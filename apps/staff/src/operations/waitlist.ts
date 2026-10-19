import type { MedplumClient } from '@medplum/core';
import type { Appointment, Patient, Practitioner, Reference } from '@medplum/fhirtypes';
import { DERIVED_IDENTIFIER_SYSTEM, EXT, buildWaitlistAppointment, hasFutureBookedVisit, waitlistCandidatesForInterval, waitlistPatientRef } from '@teleemon/core';
import type { AvailableInterval, SlotOfferCriteria, WaitlistDraft } from '@teleemon/core';
import { collectResources, idOf, patientsByRef } from './shared';

export interface WaitlistRow {
  readonly appointment: Appointment;
  readonly patient?: Patient;
  readonly provider?: Practitioner;
  readonly futureVisitBooked: boolean;
}

export interface WaitlistData {
  readonly rows: readonly WaitlistRow[];
  readonly total: number;
}

export async function loadWaitlist(medplum: MedplumClient, query = ''): Promise<WaitlistData> {
  const appointments = await collectResources<Appointment>(medplum, 'Appointment', new URLSearchParams([['status', 'waitlist'], ['_sort', '_lastUpdated']]));
  let rows: Appointment[] = appointments;
  if (query.trim()) {
    const patients = await collectResources<Patient>(medplum, 'Patient', new URLSearchParams([['name', query.trim()]]), 1000);
    const matched = new Set(patients.map((patient) => `Patient/${patient.id}`));
    rows = appointments.filter((appointment) => matched.has(waitlistPatientRef(appointment) ?? ''));
  }
  const booked = await bookedVisitsForRefs(medplum, rows.map(waitlistPatientRef));
  const patientMap = await patientsByRef(medplum, rows.map(waitlistPatientRef));
  const providerRefs = [...new Set(rows.flatMap((appointment) => appointment.participant.flatMap((part) => part.actor?.reference?.startsWith('Practitioner/') ? [part.actor.reference] : [])))];
  const providerMap = new Map<string, Practitioner>();
  for (let i = 0; i < providerRefs.length; i += 40) {
    const found = await collectResources<Practitioner>(medplum, 'Practitioner', new URLSearchParams([['_id', providerRefs.slice(i, i + 40).map(idOf).join(',')]]), 1000);
    for (const provider of found) providerMap.set(`Practitioner/${provider.id}`, provider);
  }
  return {
    rows: rows.map((appointment) => {
      const patientRef = waitlistPatientRef(appointment);
      const providerRef = appointment.participant.find((part) => part.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;
      return { appointment, patient: patientRef ? patientMap.get(patientRef) : undefined, provider: providerRef ? providerMap.get(providerRef) : undefined, futureVisitBooked: patientRef ? hasFutureBookedVisit(patientRef, booked) : false };
    }),
    total: rows.length,
  };
}

async function bookedVisitsForRefs(medplum: MedplumClient, refs: readonly (string | undefined)[]): Promise<Appointment[]> {
  const unique = [...new Set(refs.filter((ref): ref is string => !!ref))];
  const out: Appointment[] = [];
  for (let i = 0; i < unique.length; i += 40) {
    out.push(...await collectResources<Appointment>(medplum, 'Appointment', new URLSearchParams([
      ['patient', unique.slice(i, i + 40).join(',')], ['status', 'booked,arrived,checked-in'], ['date', `ge${new Date().toISOString()}`],
    ]), 5000));
  }
  return out;
}

export async function saveWaitlistAppointment(medplum: MedplumClient, draft: WaitlistDraft, existing?: Appointment): Promise<Appointment> {
  const next = buildWaitlistAppointment(draft);
  if (!existing?.id) return medplum.createResourceIfNoneExist(next, new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${next.identifier?.[0]?.value ?? ''}` }).toString());
  const current = await medplum.readResource('Appointment', existing.id, { cache: 'no-cache' });
  if (current.status !== 'waitlist') throw new Error('This appointment is no longer on the waitlist. Refresh and try again.');
  if (waitlistPatientRef(current) !== draft.patient.reference) throw new Error('A waitlist request cannot be reassigned to a different patient.');
  const preserved = (current.extension ?? []).filter((extension) => extension.url !== EXT.modality && extension.url !== EXT.waitlistNote);
  const updated: Appointment = {
    ...current,
    ...next,
    id: current.id,
    meta: current.meta,
    identifier: current.identifier,
    extension: [...preserved, ...(next.extension ?? [])],
  };
  return medplum.updateResource(updated, { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } });
}

/**
 * Books a waitlist request into an interval the scheduling UI has just determined is free.
 * No Slot resource is required; the existing appointment Bot rechecks provider licensure and
 * schedule conflicts on the booked update.
 */
export async function promoteWaitlistAppointment(
  medplum: MedplumClient,
  appointmentId: string,
  interval: AvailableInterval,
  provider: Reference<Practitioner>,
  modality?: 'video' | 'phone' | 'office'
): Promise<Appointment> {
  const current = await medplum.readResource('Appointment', appointmentId, { cache: 'no-cache' });
  if (current.status !== 'waitlist') throw new Error('This waitlist request was already updated. Refresh before booking.');
  if (!waitlistPatientRef(current)) throw new Error('This waitlist request has no patient.');
  const candidate = waitlistCandidatesForInterval([current], interval, { providerRef: provider.reference, modality });
  if (!candidate.length) throw new Error('The selected provider, modality, or interval does not match this waitlist request.');
  const patientRef = waitlistPatientRef(current)!;
  const booked = await collectResources<Appointment>(medplum, 'Appointment', new URLSearchParams([
    ['patient', patientRef], ['status', 'booked,arrived,checked-in'], ['date', `ge${new Date().toISOString()}`],
  ]), 1000);
  if (hasFutureBookedVisit(patientRef, booked)) throw new Error('This patient already has a future booked visit; close or reschedule that visit first.');
  const participant = current.participant.filter((part) => !part.actor?.reference?.startsWith('Practitioner/'));
  participant.push({ actor: provider, status: 'accepted', required: 'required' });
  const extension = (current.extension ?? []).filter((item) => item.url !== EXT.modality);
  if (modality) extension.push({ url: EXT.modality, valueCode: modality });
  return medplum.updateResource({ ...current, status: 'booked', start: interval.start, end: interval.end, participant, extension }, { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } });
}

export function waitlistCandidates(rows: readonly WaitlistRow[], interval: AvailableInterval, criteria: SlotOfferCriteria = {}): WaitlistRow[] {
  const eligible = new Set(waitlistCandidatesForInterval(rows.map((row) => row.appointment), interval, criteria).map((appointment) => appointment.id));
  return rows.filter((row) => eligible.has(row.appointment.id) && !row.futureVisitBooked);
}
