// Online booking (X01 public page, X03 signed-in patients), cancellation and held-time release.
//
// The service checks the online-booking rules and licensure before writing, and the appointment
// pre-commit Bot checks them again together with conflicts, so a direct API call gets the same
// answer. Public responses never reveal whether someone is already a patient: a booking that
// matches an existing record goes to the front desk, and the caller always sees "check your email".

import type { MedplumClient } from '@medplum/core';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Appointment, Bundle, Patient, Practitioner, Task } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, EXT, PORTAL_RULES, PRACTICE_TIME_ZONE, addBusinessDays, ageInYears, bookingEnd, cancelCheck, checkLicensure, findVisitType, formatVisitTime, normalizePhone,
  onlineBookingProblem, portalVisitTypes, readSettings, teamCoding, zonedDate,
} from '@teleemon/core';
import type { BookingChannel } from '@teleemon/core';
import { freeTimes, loadProviders } from './availability';
import { HttpError, badRequest } from './http';
import { createInvitation, invitationEmail } from './invitations';
import { emailOf, sendEmail } from './mail';
import type { PortalSession } from './session';

export interface PublicBookingRequest {
  readonly state?: string;
  readonly visitType?: string;
  readonly start?: string;
  readonly practitionerId?: string;
  readonly given?: string;
  readonly family?: string;
  readonly birthDate?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly smsConsent?: boolean;
  /** Honeypot: hidden from people, filled in by simple bots. */
  readonly website?: string;
}

const NAME = /^[\p{L}][\p{L}' .-]{0,59}$/u;
const CHECK_EMAIL = { status: 'check-email' } as const;

export function validPerson(b: PublicBookingRequest, now: Date): { given: string; family: string; birthDate: string; email: string; phone: string } {
  if (['given', 'family', 'birthDate', 'email', 'phone'].some((key) => typeof b[key as keyof PublicBookingRequest] !== 'string')) throw badRequest('Enter your name, date of birth, email and phone.');
  const given = b.given?.trim() ?? '';
  const family = b.family?.trim() ?? '';
  if (!NAME.test(given) || !NAME.test(family)) throw badRequest('Enter your first and last name.');
  const birthDate = b.birthDate ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || !Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0, 10) !== birthDate || birthDate > zonedDate(now) || birthDate < '1900-01-01') throw badRequest('Enter your date of birth.');
  if (ageInYears(birthDate, now) < 18) throw badRequest('Patients under 18 are booked by a parent or guardian by phone. Please call us.', 'minor');
  const email = b.email?.trim().toLowerCase() ?? '';
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw badRequest('Enter a valid email address.');
  const phone = normalizePhone(b.phone ?? '');
  if (!phone) throw badRequest('Enter a 10-digit US mobile number.');
  return { given, family, birthDate, email, phone };
}

/** Service-side checks shared by public and portal booking. Returns the provider. */
async function checkRequest(service: MedplumClient, channel: BookingChannel, q: { state?: string; visitType?: string; start?: string; practitionerId?: string }, now: Date): Promise<Practitioner> {
  const practice = await readSettings(service, 'practice');
  const problem = onlineBookingProblem({ channel, visitType: q.visitType, start: q.start, state: q.state, now, hours: practice.hours, closures: practice.closures.map((c) => c.date) });
  if (problem) throw badRequest(problem);
  const provider = (await loadProviders(service)).find((p) => p.practitioner.id === q.practitionerId);
  if (!provider) throw badRequest('Choose an available time.');
  const licence = checkLicensure(provider.practitioner, q.state, zonedDate(new Date(q.start as string), PRACTICE_TIME_ZONE));
  if (!licence.ok) throw badRequest(`We cannot book a visit while you are in ${q.state}. You need to be in a state where your provider is licensed.`, 'unlicensed-state');
  // Re-check that the time is still free (the Bot refuses a conflict too, at commit).
  const day = zonedDate(new Date(q.start as string), PRACTICE_TIME_ZONE);
  const free = await freeTimes(service, { channel, state: q.state as string, visitType: q.visitType as string, from: day, days: 1, practitionerId: q.practitionerId, now });
  if (!free[0]?.times.some((t) => t.start === new Date(q.start as string).toISOString())) throw new HttpError(409, 'That time was just taken. Please choose another time.', 'taken');
  return provider.practitioner;
}

function appointment(channel: BookingChannel, patient: Patient | string, practitioner: Practitioner, q: { state: string; visitType: string; start: string }, now: Date, status: Appointment['status']): Appointment {
  const type = findVisitType(q.visitType);
  const start = new Date(q.start).toISOString();
  return {
    resourceType: 'Appointment',
    status,
    start,
    end: bookingEnd(start, q.visitType),
    minutesDuration: type?.minutes,
    appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: q.visitType, display: type?.label }], text: type?.label },
    created: now.toISOString(),
    participant: [
      { actor: typeof patient === 'string' ? { reference: patient } : createReference(patient), status: 'accepted' },
      { actor: createReference(practitioner), status: 'accepted' },
    ],
    extension: [
      { url: EXT.modality, valueCode: 'video' },
      { url: EXT.patientLocationState, valueCode: q.state },
      { url: EXT.bookingChannel, valueCode: channel },
      ...(status === 'pending' ? [{ url: EXT.holdExpires, valueDateTime: new Date(now.getTime() + PORTAL_RULES.holdMinutes * 60000).toISOString() }] : []),
    ],
  };
}

/** Bot refusals can name other patients (duplicates) or other visits: map them to safe messages. */
function bookingRefusal(err: unknown): HttpError | 'duplicate' {
  const message = normalizeErrorString(err);
  if (/possible duplicate/i.test(message)) return 'duplicate';
  if (/overlaps|is blocked/i.test(message)) return new HttpError(409, 'That time was just taken. Please choose another time.', 'taken');
  if (/licen[cs]e|licensed/i.test(message)) return badRequest('We cannot book a visit in that state. You need to be in a state where your provider is licensed.', 'unlicensed-state');
  return new HttpError(400, 'We could not book that time. Please choose another time, or call us.');
}

export async function publicBook(service: MedplumClient, b: PublicBookingRequest, now = new Date()): Promise<typeof CHECK_EMAIL> {
  if (b.website) return CHECK_EMAIL; // Honeypot filled: silently accept and do nothing.
  const person = validPerson(b, now);
  const practitioner = await checkRequest(service, 'online', b, now);
  const q = { state: b.state as string, visitType: b.visitType as string, start: b.start as string };

  const patient: Patient = {
    resourceType: 'Patient',
    active: true,
    name: [{ given: [person.given], family: person.family }],
    birthDate: person.birthDate,
    telecom: [{ system: 'phone', value: person.phone, use: 'mobile' }, { system: 'email', value: person.email }],
    generalPractitioner: [createReference(practitioner)],
    extension: [
      { url: EXT.referralSource, valueString: 'Website' },
      ...(b.smsConsent === true ? [] : [{ url: EXT.contactOptOut, valueCode: 'sms' }]),
    ],
  };
  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      { fullUrl: 'urn:uuid:00000000-0000-4000-8000-000000000001', resource: patient, request: { method: 'POST', url: 'Patient' } },
      { resource: appointment('online', 'urn:uuid:00000000-0000-4000-8000-000000000001', practitioner, q, now, 'pending'), request: { method: 'POST', url: 'Appointment' } },
    ],
  };
  let created: Bundle;
  try {
    created = await service.executeBatch(bundle);
  } catch (err) {
    const refusal = bookingRefusal(err);
    if (refusal !== 'duplicate') throw refusal;
    await bookingReview(service, person, q, now);
    await sendEmail(person.email, 'We received your Teleemon booking request', `Hello ${person.given},\n\nThank you for your request for ${formatVisitTime(q.start)}. Our team will contact you within one business day to confirm it. If you already use the Teleemon portal, you can sign in to book.`);
    return CHECK_EMAIL;
  }
  const savedPatient = created.entry?.[0]?.resource as Patient;
  const savedAppt = created.entry?.[1]?.resource as Appointment;
  const { token } = await createInvitation(service, savedPatient, { appointment: savedAppt, now });
  const message = invitationEmail(savedPatient, token, savedAppt);
  await sendEmail(person.email, message.subject, message.text);
  return CHECK_EMAIL;
}

/** A request that matches an existing record: the front desk calls the person back. */
async function bookingReview(service: MedplumClient, person: ReturnType<typeof validPerson>, q: { state: string; visitType: string; start: string }, now: Date): Promise<Task> {
  return service.createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'booking-review' }], text: 'Online booking request' },
    description: `Online booking request needs matching: ${person.given} ${person.family}, born ${person.birthDate}. Call back to book.`,
    performerType: teamCoding('frontdesk'),
    authoredOn: now.toISOString(),
    restriction: { period: { end: addBusinessDays(now, 1).toISOString() } },
    input: [
      { type: { text: 'name' }, valueString: `${person.given} ${person.family}` },
      { type: { text: 'birth date' }, valueString: person.birthDate },
      { type: { text: 'email' }, valueString: person.email },
      { type: { text: 'phone' }, valueString: person.phone },
      { type: { text: 'requested time' }, valueString: formatVisitTime(q.start) },
      { type: { text: 'visit location' }, valueString: q.state },
    ],
    note: [{ text: 'The online booking matched an existing patient record, so no appointment or record was created. Match the person, then book.' }],
  });
}

export interface PortalBookingRequest {
  readonly state?: string;
  readonly visitType?: string;
  readonly start?: string;
  readonly practitionerId?: string;
}

export async function patientHistory(service: MedplumClient, patientRef: string): Promise<Appointment[]> {
  return service.searchResources('Appointment', { patient: patientRef, _count: '200', _sort: '-date' }, { cache: 'no-cache' });
}

export async function portalBook(service: MedplumClient, session: PortalSession, b: PortalBookingRequest, now = new Date()): Promise<{ id: string; start: string }> {
  const allowed = portalVisitTypes(await patientHistory(service, session.patientRef), now);
  if (!allowed.some((v) => v.code === b.visitType)) {
    throw badRequest(allowed.length ? 'Choose one of the visit types offered to you.' : 'Your new patient visit is already booked. Follow-up visits can be booked after it.');
  }
  const practitioner = await checkRequest(service, 'portal', b, now);
  try {
    const saved = await service.createResource(appointment('portal', session.patientRef, practitioner, { state: b.state as string, visitType: b.visitType as string, start: b.start as string }, now, 'booked'));
    const email = emailOf(session.patient);
    if (email) await sendEmail(email, 'Your Teleemon visit is booked', `Your visit is booked for ${formatVisitTime(saved.start as string)}. You can check in from the portal whenever you are ready; your provider will start the visit when ready.`);
    return { id: saved.id as string, start: saved.start as string };
  } catch (err) {
    const refusal = bookingRefusal(err);
    throw refusal === 'duplicate' ? badRequest('We could not book that time.') : refusal;
  }
}

export async function ownAppointment(service: MedplumClient, session: PortalSession, id: string): Promise<Appointment> {
  const appt = await service.readResource('Appointment', id, { cache: 'no-cache' }).catch(() => undefined);
  if (!appt || !appt.participant.some((p) => p.actor?.reference === session.patientRef)) throw new HttpError(404, 'Visit not found.');
  return appt;
}

export async function cancel(service: MedplumClient, session: PortalSession, id: string, now = new Date()): Promise<{ late: boolean }> {
  const appt = await ownAppointment(service, session, id);
  const check = cancelCheck(appt, now);
  if (check.problem) throw badRequest(check.problem);
  await service.updateResource<Appointment>({
    ...appt,
    status: 'cancelled',
    cancelationReason: { coding: [{ system: CODE_SYSTEMS.cancellationReason, code: check.late ? 'late-cancel' : 'patient-request' }], text: `Cancelled in the portal by ${session.actorName}` },
    extension: appt.extension?.filter((e) => e.url !== EXT.holdExpires),
  }, { headers: { 'If-Match': `W/"${appt.meta?.versionId}"` } });
  return { late: check.late };
}

/** Releases unconfirmed public bookings once their hold expires. */
export async function releaseHolds(service: MedplumClient, now = new Date()): Promise<number> {
  let released = 0;
  for await (const page of service.searchResourcePages('Appointment', { status: 'pending', _count: '100' }, { cache: 'no-cache' })) {
    for (const appt of page) {
      const expires = Date.parse(appt.extension?.find((e) => e.url === EXT.holdExpires)?.valueDateTime ?? '');
      if (!Number.isFinite(expires) || expires > now.getTime()) continue;
      await service.updateResource<Appointment>({
        ...appt,
        status: 'cancelled',
        cancelationReason: { coding: [{ system: CODE_SYSTEMS.cancellationReason, code: 'other' }], text: 'Online booking was not confirmed from the email link in time' },
        extension: appt.extension?.filter((e) => e.url !== EXT.holdExpires),
      }, { headers: { 'If-Match': `W/"${appt.meta?.versionId}"` } }).then(() => released++).catch(() => undefined);
    }
  }
  return released;
}
