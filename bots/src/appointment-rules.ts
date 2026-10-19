// Pre-commit Bot on Appointment create/update (P04, P05, P39; SYSTEM-DESIGN.md §6).
// While a visit is being booked (proposed, pending, booked):
//   1. the provider must hold a valid licence for the patient's location on the visit date;
//   2. it must not overlap another active appointment or blocked time for the same provider,
//      unless staff give an overbooking reason.
// Check-in is status-driven, not limited by the planned start/end. On entry to arrived/checked-in,
// the confirming actor, current patient location and provider licence are validated here; the
// encounter rule checks the location again when the provider starts care.
// Online bookings (public page or portal, Phase 7) must also be a video visit type offered online,
// on the 15-minute grid, inside practice hours and within the booking window (onlineBookingProblem).

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest, getExtensionValue } from '@medplum/core';
import type { Appointment, ClientApplication, Practitioner, Reference, RelatedPerson, Slot } from '@medplum/fhirtypes';
import { ACTIVE_STATUSES, CODE_SYSTEMS, EXT, PRACTICE_TIME_ZONE, bookingChannel, checkLicensure, locationConfirmation, onlineBookingProblem, overlaps, readSettings, zonedDate } from '@teleemon/core';
import { previous } from './previous';

const BOOKING_STATUSES: Appointment['status'][] = ['proposed', 'pending', 'booked'];
const MIN_REASON = 5;

export async function handler(medplum: MedplumClient, event: BotEvent<Appointment>): Promise<boolean> {
  const appt = event.input;
  if (!BOOKING_STATUSES.includes(appt.status)) {
    if (appt.status === 'arrived' || appt.status === 'checked-in') {
      await validateCheckIn(medplum, appt);
    }
    return true;
  }
  if (!appt.start || !appt.end || appt.end <= appt.start) {
    reject('A booked appointment needs a start and an end time, with the end after the start.');
  }
  const channel = bookingChannel(appt);
  if (channel && !(await previous(medplum, appt))) {
    const practice = await readSettings(medplum, 'practice');
    const problem = onlineBookingProblem({
      channel, visitType: appt.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code, start: appt.start, end: appt.end,
      state: getExtensionValue(appt, EXT.patientLocationState) as string | undefined, hours: practice.hours, closures: practice.closures.map((c) => c.date),
    });
    if (problem) reject(problem);
    if (getExtensionValue(appt, EXT.modality) !== 'video') reject('Online bookings are video visits.');
    if (getExtensionValue(appt, EXT.overbookReason)) reject('Online bookings cannot overbook.');
    if (appt.status === 'pending' && !getExtensionValue(appt, EXT.holdExpires)) reject('An unconfirmed online booking needs a hold expiry.');
  }
  const practitionerRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor as Reference<Practitioner> | undefined;
  if (!practitionerRef) {
    reject('Choose the provider for this appointment.');
  }

  // 1. Licensure on the visit date (practice calendar date).
  const practitioner = await medplum.readReference(practitionerRef as Reference<Practitioner>);
  const state = getExtensionValue(appt, EXT.patientLocationState) as string | undefined;
  const licence = checkLicensure(practitioner, state, zonedDate(new Date(appt.start as string), PRACTICE_TIME_ZONE));
  if (!licence.ok) {
    reject(licence.reason as string);
  }

  // 2. Conflicts, unless overbooking was explicitly chosen with a reason.
  const reason = (getExtensionValue(appt, EXT.overbookReason) as string | undefined)?.trim() ?? '';
  if (reason.length >= MIN_REASON) {
    return true;
  }
  const interval = { start: appt.start as string, end: appt.end as string };
  const windowStart = new Date(Date.parse(interval.start) - 12 * 3600000).toISOString();
  const others = await medplum.searchResources(
    'Appointment',
    new URLSearchParams([
      ['actor', practitionerRef?.reference as string],
      ['date', `ge${windowStart}`],
      ['date', `lt${interval.end}`],
      ['status', ACTIVE_STATUSES.join(',')],
      ['_count', '100'],
    ])
  );
  const clash = others.find((o) => o.id !== appt.id && o.start && o.end && overlaps(interval, { start: o.start, end: o.end }));
  if (clash) {
    reject(`This time overlaps another appointment (${time(clash.start as string)}–${time(clash.end as string)}). Choose another time, or book it as an overbook with a reason.`);
  }

  const schedules = await medplum.searchResources('Schedule', { actor: practitionerRef?.reference as string, _count: '10' });
  if (schedules.length) {
    const blocked: Slot[] = await medplum.searchResources(
      'Slot',
      new URLSearchParams([
        ['schedule', schedules.map((s) => `Schedule/${s.id}`).join(',')],
        ['status', 'busy-unavailable'],
        ['start', `ge${windowStart}`],
        ['start', `lt${interval.end}`],
        ['_count', '100'],
      ])
    );
    const block = blocked.find((s) => overlaps(interval, s));
    if (block) {
      reject(`This time is blocked${block.comment ? ` (${block.comment})` : ''}. Choose another time, or book it as an overbook with a reason.`);
    }
  }
  return true;
}

async function validateCheckIn(medplum: MedplumClient, appt: Appointment): Promise<void> {
  const before = await previous(medplum, appt);
  if (!before) reject('Create this visit as booked before checking it in.');
  const wasCheckedIn = before.status === 'arrived' || before.status === 'checked-in';
  if (!wasCheckedIn && before.status !== 'booked') reject('Only a booked visit can be checked in.');
  const state = getExtensionValue(appt, EXT.patientLocationState) as string | undefined;
  const beforeState = getExtensionValue(before, EXT.patientLocationState) as string | undefined;
  const confirmed = locationConfirmation(appt);
  const previousConfirmation = locationConfirmation(before);
  const changedConfirmation = JSON.stringify(confirmed) !== JSON.stringify(previousConfirmation);
  const enteringCheckIn = !wasCheckedIn;
  if (!enteringCheckIn && beforeState === state && !changedConfirmation) return;

  if (!state || !/^[A-Z]{2}$/.test(state)) reject('Confirm the patient\'s current physical location before checking in.');
  if (confirmed?.state !== state || !confirmed.by || !confirmed.at || !Number.isFinite(Date.parse(confirmed.at))) {
    reject('Record who confirmed the patient\'s current location and when before checking in.');
  }
  const patientRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  if (!patientRef) reject('This visit has no patient record to check in.');
  const author = appt.meta?.author?.reference;
  if (author === confirmed.by) {
    const staffAuthor = author.startsWith('Practitioner/');
    if (!staffAuthor && !(await portalPersonMatchesPatient(medplum, confirmed.by, patientRef))) {
      reject('The check-in confirmer is not this patient or an authorized proxy.');
    }
  } else if (author?.startsWith('ClientApplication/') && await isPortalService(medplum, author)) {
    if (!(await portalPersonMatchesPatient(medplum, confirmed.by, patientRef))) {
      reject('The check-in confirmer is not this patient or an authorized proxy.');
    }
    // The portal service writes with its own FHIR identity. Its session authenticates the
    // patient/proxy and the service checks that the appointment belongs to that patient.
  } else {
    reject('The location confirmation must be recorded by the staff member or patient who completed check-in.');
  }
  const start = Date.parse(appt.start ?? '');
  const end = Date.parse(appt.end ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) reject('This visit has no valid scheduled time.');
  const practitionerRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor as Reference<Practitioner> | undefined;
  if (!practitionerRef) reject('Choose the provider for this appointment before checking in.');
  const practitioner = await medplum.readReference(practitionerRef as Reference<Practitioner>);
  const licence = checkLicensure(practitioner, state, zonedDate(new Date(), PRACTICE_TIME_ZONE));
  if (!licence.ok) reject(licence.reason as string);
}

async function isPortalService(medplum: MedplumClient, author: string): Promise<boolean> {
  const id = author.split('/')[1];
  if (!id) return false;
  const app = await medplum.readResource('ClientApplication', id) as ClientApplication;
  return app.name === 'Teleemon portal service';
}

async function portalPersonMatchesPatient(medplum: MedplumClient, actor: string, patientRef: string): Promise<boolean> {
  if (actor === patientRef) return true;
  if (!actor.startsWith('RelatedPerson/')) return false;
  const proxy = await medplum.readResource('RelatedPerson', actor.split('/')[1]) as RelatedPerson;
  return proxy.active !== false && proxy.patient?.reference === patientRef;
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}

function time(instant: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: PRACTICE_TIME_ZONE }).format(new Date(instant));
}
