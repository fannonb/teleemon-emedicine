// Check-in and joining (X04). The patient confirms where they are; the visit can only be joined
// once that location is confirmed in a state where the provider is licensed on the visit date.
// The telehealth link is hidden from the patient's own reads (policy hiddenFields) and released
// here only after check-in.

import type { MedplumClient } from '@medplum/core';
import type { Appointment, Practitioner, Reference } from '@medplum/fhirtypes';
import { EXT, PRACTICE_TIME_ZONE, checkInProblem, checkLicensure, joinProblem, locationConfirmation, locationConfirmedExtension, zonedDate } from '@teleemon/core';
import { ownAppointment } from './booking';
import { badRequest } from './http';
import type { PortalSession } from './session';

export interface VisitStatus {
  readonly checkIn: { problem?: string; reconfirm: boolean };
  readonly checkedIn: boolean;
  readonly confirmedState?: string;
  readonly bookedState?: string;
  readonly join: { available: boolean; problem?: string };
}

export async function visitStatus(service: MedplumClient, session: PortalSession, id: string): Promise<VisitStatus> {
  const appt = await ownAppointment(service, session, id);
  const join = joinProblem(appt);
  const checkedIn = appt.status === 'arrived' || appt.status === 'checked-in';
  const problem = checkInProblem(appt);
  return {
    checkIn: { problem, reconfirm: checkedIn && !problem },
    checkedIn,
    confirmedState: locationConfirmation(appt)?.state,
    bookedState: appt.extension?.find((e) => e.url === EXT.patientLocationState)?.valueCode,
    join: { available: !join, problem: join },
  };
}

export async function checkIn(service: MedplumClient, session: PortalSession, id: string, body: { state?: string; confirm?: boolean }, now = new Date()): Promise<VisitStatus> {
  const appt = await ownAppointment(service, session, id);
  const problem = checkInProblem(appt);
  if (problem) throw badRequest(problem);
  const state = body.state?.toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state)) throw badRequest('Choose the state you are in right now.');
  if (body.confirm !== true) throw badRequest('Confirm that you are physically in this state for the whole visit.');
  const practitionerRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor as Reference<Practitioner> | undefined;
  const practitioner = practitionerRef ? await service.readReference(practitionerRef) : undefined;
  const licence = checkLicensure(practitioner, state, zonedDate(now, PRACTICE_TIME_ZONE));
  if (!licence.ok) {
    throw badRequest(`Your provider is not licensed in ${state}, so this visit cannot go ahead while you are there. If you can get to a state where they are licensed, check in from there; otherwise call us to reschedule.`, 'unlicensed-location');
  }
  const extension = (appt.extension ?? []).filter((e) => e.url !== EXT.patientLocationState && e.url !== EXT.locationConfirmed);
  await service.updateResource<Appointment>({
    ...appt,
    status: 'arrived',
    extension: [...extension, { url: EXT.patientLocationState, valueCode: state }, locationConfirmedExtension(session.actor, state, now)],
  }, { headers: { 'If-Match': `W/"${appt.meta?.versionId}"` } });
  return visitStatus(service, session, id);
}

export async function joinLink(service: MedplumClient, session: PortalSession, id: string): Promise<{ url?: string; pending?: boolean }> {
  const appt = await ownAppointment(service, session, id);
  const problem = joinProblem(appt);
  if (problem) throw badRequest(problem, 'not-checked-in');
  const url = appt.extension?.find((e) => e.url === EXT.telehealthUrl)?.valueUrl;
  return url ? { url } : { pending: true };
}
