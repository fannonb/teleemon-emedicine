// Phase 7 regression tests: portal and public booking rules, the Bot rules they rely on, the
// booking-page proof of work and rate limits. No server needed; `npm run verify:phase7` proves the
// same rules against local Medplum.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Consent, Coverage, DocumentReference, Patient, Practitioner, QuestionnaireResponse, Task } from '@medplum/fhirtypes';
import type { VisitType } from '@teleemon/core';
import {
  CODE_SYSTEMS, EXT, INTAKE_STEPS, PORTAL_CONSENTS, PORTAL_MESSAGE, PORTAL_REPLY, cancelCheck, checkInProblem, crisisLanguage, guardianContact, joinProblem, locationConfirmedExtension,
  INTAKE_QUESTIONNAIRE_URL, MEASURES, US_CORE_RACE, VISIT_TYPES, estimateAcknowledged, genderForSex, goodFaithEstimate, isControlledStatement, onboardingProblems, patientInviteProblem, registrationGaps, requiredPortalConsents, scoreMeasure,
  isActivePortalVisit, missingIntakeAnswers, nextActivePortalVisit, onlineBookingProblem, patientSelfEditProblem, portalMessageProblem, portalVisitTypes, proxyLevel, resumeStep, signedPortalConsent, stableJson, toQualification,
} from '@teleemon/core';
import { handler as appointmentRules } from '../bots/src/appointment-rules';
import { handler as patientRules } from '../bots/src/duplicate-patient';
import { handler as messageRules } from '../bots/src/communication-rules';
import { handler as taskRules } from '../bots/src/task-rules';
import { handler as documentRules } from '../bots/src/document-rules';
import { handler as onboardingBot } from '../bots/src/onboarding-review';
import { ProofOfWork, solve } from '../services/portal/src/captcha';
import { HttpError, RateLimiter } from '../services/portal/src/http';
import { activate, hashToken } from '../services/portal/src/invitations';
import { validPerson } from '../services/portal/src/booking';

test('public identity validation requires actual calendar dates and string fields', () => {
  const person = { given: 'Synthetic', family: 'Patient', birthDate: '1980-02-29', email: 'Test@Example.com', phone: '2065550123' };
  assert.equal(validPerson(person, new Date('2026-10-17')).email, 'test@example.com');
  assert.throws(() => validPerson({ ...person, birthDate: '1981-02-29' }, new Date('2026-10-17')), /date of birth/);
  assert.throws(() => validPerson({ ...person, given: 42 as unknown as string }, new Date('2026-10-17')), /name/);
});

test('activation consumes the link and confirms its hold atomically, preserving retries after conflicts', async () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const invitation = { resourceType: 'Basic', id: 'invite', meta: { versionId: '1' }, subject: { reference: 'Patient/adult' }, extension: [{ url: EXT.inviteExpires, valueDateTime: '2026-10-18T12:00:00Z' }, { url: EXT.inviteAppointment, valueReference: { reference: 'Appointment/held' } }] };
  let fail = true;
  let consumed = false;
  const service = {
    searchOne: async () => invitation,
    readReference: async () => ({ resourceType: 'Patient', id: 'adult', birthDate: '1980-01-01', telecom: [{ system: 'email', value: 'synthetic@example.com' }] }),
    readResource: async () => ({ resourceType: 'Appointment', id: 'held', meta: { versionId: '2' }, status: 'pending', participant: [], extension: [{ url: EXT.holdExpires, valueDateTime: '2026-10-17T13:00:00Z' }] }),
    executeBatch: async (bundle: { entry: { resource: { resourceType: string; status?: string }; request: { ifMatch?: string } }[] }) => {
      assert.equal(bundle.entry.length, 2);
      assert.equal(bundle.entry[0].resource.resourceType, 'Basic');
      assert.equal(bundle.entry[1].resource.status, 'booked');
      assert.equal(bundle.entry[1].request.ifMatch, 'W/"2"');
      if (fail) throw new Error('version conflict');
      consumed = true;
      return bundle;
    },
  } as unknown as MedplumClient;
  const accounts = { searchOne: async (type: string) => type === 'AccessPolicy' ? { resourceType: 'AccessPolicy', id: 'patient-policy' } : { resourceType: 'ProjectMembership', id: 'existing-account' } } as unknown as MedplumClient;
  await assert.rejects(activate(service, accounts, 'project', 'a'.repeat(43), 'Synthetic-password-2026!', now), /version conflict/);
  assert.equal(consumed, false);
  fail = false;
  const result = await activate(service, accounts, 'project', 'a'.repeat(43), 'Synthetic-password-2026!', now);
  assert.equal(consumed, true);
  assert.equal(result.existingLogin, true);
  assert.equal(result.appointment, 'confirmed');
});

// Monday 19 October 2026, 08:00 in Bellevue (practice hours Mon–Sat 9 AM – 9 PM).
const NOW = new Date('2026-10-19T15:00:00Z');
const event = <T extends { meta?: object }>(input: T, author = 'Practitioner/staff'): BotEvent<T> => ({
  input: { ...input, meta: { ...(input.meta ?? {}), author: { reference: author } } }, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {},
});
const client = (methods: object): MedplumClient => methods as MedplumClient;
const notFound = async (): Promise<never> => { throw Object.assign(new Error('Not found'), { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] } }); };
const licensed: Practitioner = {
  resourceType: 'Practitioner', id: 'prov', name: [{ given: ['Jordan'], family: 'Ellis' }],
  qualification: ['WA', 'CA'].map((state) => toQualification({ kind: 'state-license', state, number: `${state}-1`, start: '2020-01-01', end: '2099-01-01' })),
};
const appt = (over: Partial<Appointment> = {}, code = 'new-eval'): Appointment => ({
  resourceType: 'Appointment', status: 'booked', start: '2026-10-20T17:00:00.000Z', end: '2026-10-20T18:00:00.000Z',
  appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code }] },
  participant: [{ actor: { reference: 'Patient/p' }, status: 'accepted' }, { actor: { reference: 'Practitioner/prov' }, status: 'accepted' }],
  extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.bookingChannel, valueCode: 'online' }],
  ...over,
});

test('online booking: new patients book an evaluation 24 hours ahead; returning patients follow-ups 2 hours ahead', () => {
  const ok = { channel: 'online' as const, visitType: 'new-eval', start: '2026-10-20T17:00:00.000Z', state: 'WA', now: NOW };
  assert.equal(onlineBookingProblem(ok), undefined);
  assert.match(onlineBookingProblem({ ...ok, visitType: 'med-mgmt' }) ?? '', /new patient evaluation/);
  assert.match(onlineBookingProblem({ ...ok, start: '2026-10-19T18:00:00.000Z' }) ?? '', /24 hours/);
  assert.match(onlineBookingProblem({ ...ok, channel: 'portal', visitType: 'med-mgmt', start: '2026-10-19T16:00:00.000Z' }) ?? '', /2 hours/);
  assert.equal(onlineBookingProblem({ ...ok, channel: 'portal', visitType: 'med-mgmt', start: '2026-10-19T18:00:00.000Z' }), undefined);
  assert.match(onlineBookingProblem({ ...ok, channel: 'portal', visitType: 'office-med-mgmt' }) ?? '', /offered online/);
  assert.match(onlineBookingProblem({ ...ok, start: '2026-10-20T17:05:00.000Z' }) ?? '', /available times/);
  assert.match(onlineBookingProblem({ ...ok, start: '2026-10-21T05:00:00.000Z' }) ?? '', /outside practice hours/);
  assert.match(onlineBookingProblem({ ...ok, start: '2026-10-25T18:00:00.000Z' }) ?? '', /outside practice hours/, 'Sunday is closed');
  assert.match(onlineBookingProblem({ ...ok, start: '2026-12-21T18:00:00.000Z' }) ?? '', /60 days/);
  assert.match(onlineBookingProblem({ ...ok, end: '2026-10-20T17:30:00.000Z' }) ?? '', /60 minutes/);
  assert.match(onlineBookingProblem({ ...ok, state: undefined }) ?? '', /state/);
  assert.match(onlineBookingProblem({ ...ok, closures: ['2026-10-20'] }) ?? '', /outside practice hours/);
});

test('signed-in patients are offered an evaluation until their first visit, then follow-ups', () => {
  assert.deepEqual(portalVisitTypes([], NOW).map((v) => v.code), ['new-eval']);
  assert.deepEqual(portalVisitTypes([appt({ status: 'booked' })], NOW).map((v) => v.code), [], 'evaluation already booked');
  assert.deepEqual(portalVisitTypes([appt({ status: 'fulfilled', start: '2026-09-01T17:00:00Z' })], NOW).map((v) => v.code), ['med-mgmt', 'med-mgmt-therapy', 'brief']);
});

test('check-in is always available for a booked visit and joining follows checked-in status', () => {
  assert.equal(cancelCheck(appt(), NOW).late, false);
  assert.equal(cancelCheck(appt({ start: '2026-10-19T20:00:00Z' }), NOW).late, true);
  assert.match(cancelCheck(appt({ status: 'fulfilled' }), NOW).problem ?? '', /no longer/);
  const visit = appt({ start: '2026-10-19T16:00:00.000Z', end: '2026-10-19T16:30:00.000Z' });
  assert.equal(checkInProblem(visit), undefined, 'can check in before the scheduled start');
  assert.equal(checkInProblem({ ...visit, start: '2020-10-19T16:00:00.000Z', end: '2020-10-19T16:30:00.000Z' }), undefined, 'a booked visit remains check-in eligible after its scheduled end');
  assert.equal(checkInProblem({ ...visit, status: 'cancelled' }), 'Only a booked visit can be checked in.');
  assert.equal(checkInProblem({ ...visit, status: 'fulfilled' }), 'Only a booked visit can be checked in.');
  assert.equal(checkInProblem({ ...visit, status: 'noshow' }), 'Only a booked visit can be checked in.');
  assert.equal(checkInProblem({ ...visit, status: 'pending' }), 'Only a booked visit can be checked in.');
  assert.equal(checkInProblem({ ...visit, end: visit.start }), 'This visit has no valid time set. Call us.');
  assert.match(joinProblem(visit) ?? '', /Check in/);
  assert.match(joinProblem({ ...visit, status: 'arrived' }) ?? '', /confirm your location/, 'arrived without a confirmed location');
  const checkedIn = { ...visit, status: 'arrived' as const, extension: [...(visit.extension ?? []), locationConfirmedExtension('Patient/p', 'WA', new Date('2026-10-19T15:40:00Z'))] };
  assert.equal(joinProblem(checkedIn), undefined, 'join is available before the scheduled start');
  assert.equal(joinProblem({ ...checkedIn, start: '2020-10-19T16:00:00.000Z', end: '2020-10-19T16:30:00.000Z' }), undefined, 'the scheduled end does not close an active checked-in visit');
});

test('active visit statuses remain visible and actionable after their scheduled end', () => {
  const lateBooked = appt({ start: '2020-10-19T16:00:00.000Z', end: '2020-10-19T16:30:00.000Z' });
  assert.equal(isActivePortalVisit(lateBooked), true);
  assert.equal(isActivePortalVisit({ ...lateBooked, status: 'arrived' }), true);
  assert.equal(isActivePortalVisit({ ...lateBooked, status: 'checked-in' }), true);
  assert.equal(isActivePortalVisit({ ...lateBooked, status: 'fulfilled' }), false);
  assert.equal(isActivePortalVisit({ ...lateBooked, status: 'cancelled' }), false);
  assert.equal(isActivePortalVisit({ ...lateBooked, status: 'noshow' }), false);
});

test('Home chooses an ongoing or future visit before stale active history', () => {
  const now = new Date('2026-10-19T17:00:00.000Z');
  const staleCheckedIn = appt({ status: 'checked-in', start: '2026-10-16T16:00:00.000Z', end: '2026-10-16T17:00:00.000Z' });
  const futureBooked = appt({ start: '2026-10-20T17:00:00.000Z', end: '2026-10-20T18:00:00.000Z' });
  const ongoing = appt({ status: 'arrived', start: '2026-10-19T16:30:00.000Z', end: '2026-10-19T17:30:00.000Z' });
  assert.equal(nextActivePortalVisit([staleCheckedIn, futureBooked], now), futureBooked);
  assert.equal(nextActivePortalVisit([staleCheckedIn, futureBooked, ongoing], now), ongoing);
  assert.equal(nextActivePortalVisit([staleCheckedIn], now), staleCheckedIn, 'most recent past active visit remains available as fallback');
});

test("proxy access depends on the minor's age and home state; unknown states are most restrictive", () => {
  const minor = (age: number, state?: string): Patient => ({ resourceType: 'Patient', birthDate: `${2026 - age}-01-01`, address: state ? [{ use: 'home', state }] : undefined });
  const on = new Date('2026-06-01T12:00:00Z');
  assert.equal(proxyLevel(minor(12, 'WA'), on).level, 'full');
  assert.equal(proxyLevel(minor(13, 'WA'), on).level, 'limited');
  assert.equal(proxyLevel(minor(11, 'CA'), on).level, 'full');
  assert.equal(proxyLevel(minor(12, 'CA'), on).level, 'limited');
  assert.equal(proxyLevel(minor(13, 'RI'), on).level, 'full');
  assert.equal(proxyLevel(minor(14, 'RI'), on).level, 'limited');
  assert.equal(proxyLevel(minor(12), on).level, 'limited', 'no state on file');
  assert.equal(proxyLevel(minor(18, 'WA'), on).level, 'none');
  assert.equal(proxyLevel({ resourceType: 'Patient' }, on).level, 'limited');
});

const patient: Patient = {
  resourceType: 'Patient', id: 'p', birthDate: '1990-05-05', name: [{ given: ['Sam'], family: 'Rivera' }], identifier: [{ system: 'mrn', value: 'TM-1' }],
  telecom: [{ system: 'phone', value: '206-555-0100' }], meta: { versionId: '1' },
  extension: [{ url: EXT.pronouns, valueString: 'they/them' }, { url: EXT.cardOnFile, valueString: '{"provider":"sandbox"}' }],
};

test('patients edit their contact details only', () => {
  assert.equal(patientSelfEditProblem(patient, { ...patient, telecom: [{ system: 'phone', value: '206-555-0199' }], address: [{ city: 'Seattle', state: 'WA' }] }), undefined);
  assert.equal(patientSelfEditProblem(patient, { ...patient, extension: [{ url: EXT.cardOnFile, valueString: '{"provider":"sandbox"}' }, { url: EXT.pronouns, valueString: 'she/her' }, { url: EXT.contactOptOut, valueCode: 'sms' }] }), undefined, 'order of extensions');
  assert.equal(patientSelfEditProblem(patient, JSON.parse(stableJson(patient)) as Patient), undefined, 'key order');
  assert.match(patientSelfEditProblem(patient, { ...patient, birthDate: '1991-01-01' }) ?? '', /care team/);
  assert.match(patientSelfEditProblem(patient, { ...patient, name: [{ given: ['Someone'], family: 'Else' }] }) ?? '', /care team/);
  assert.match(patientSelfEditProblem(patient, { ...patient, identifier: [] }) ?? '', /care team/);
  assert.match(patientSelfEditProblem(patient, { ...patient, extension: [{ url: EXT.pronouns, valueString: 'they/them' }] }) ?? '', /care team/, 'removing the card on file');
  assert.match(patientSelfEditProblem(patient, { ...patient, extension: [...(patient.extension ?? []), { url: EXT.duplicateOverride, valueString: 'mine' }] }) ?? '', /care team/);
  assert.match(patientSelfEditProblem(patient, { ...patient, meta: { security: [{ code: 'R' }] } }) ?? '', /care team/);
  const minor: Patient = { ...patient, contact: [guardianContact({ given: 'Ana', family: 'Rivera', relationship: 'Mother', phone: '425-555-0101', authority: true })] };
  assert.match(patientSelfEditProblem(minor, { ...minor, contact: [] }) ?? '', /Guardian/);
  assert.equal(patientSelfEditProblem(minor, { ...minor, contact: [...(minor.contact ?? []), { relationship: [{ coding: [{ code: 'C' }] }], name: { family: 'Lee' } }] }), undefined, 'adding an emergency contact');
  assert.match(patientSelfEditProblem(undefined, patient) ?? '', /cannot create/);
});

test('the Patient Bot applies the self-edit rule to portal authors only', async () => {
  const m = client({ readResource: async () => patient, searchResources: async () => [], searchOne: async () => undefined });
  await assert.rejects(patientRules(m, event({ ...patient, birthDate: '1991-01-01' }, 'Patient/p')), /care team/);
  await assert.rejects(patientRules(m, event({ ...patient, birthDate: '1991-01-01' }, 'RelatedPerson/g')), /care team/);
  assert.ok(await patientRules(m, event({ ...patient, telecom: [{ system: 'phone', value: '206-555-0101' }] }, 'Patient/p')));
  assert.ok(await patientRules(m, event({ ...patient, birthDate: '1991-01-01' }, 'Practitioner/staff')), 'staff correct registration details');
});

test('crisis language is recognized without flagging ordinary messages', () => {
  for (const t of ['I have been thinking about suicide', 'I want to kill myself', 'thinking of ending my life', 'I took an overdose', 'I keep cutting myself', 'better off dead']) assert.ok(crisisLanguage(t), t);
  for (const t of ['Can I move my appointment?', 'The pharmacy needs a refill', 'I feel a bit anxious this week', 'My doctor said my life insurance form is ready']) assert.equal(crisisLanguage(t), false, t);
});

const message = (over: Partial<Communication> = {}): Communication => ({
  resourceType: 'Communication', status: 'in-progress', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_MESSAGE }] }],
  subject: { reference: 'Patient/p' }, sender: { reference: 'Patient/p' }, payload: [{ contentString: 'Question about my visit' }], ...over,
});

test('portal messages: own name, own care, plain text; crisis language is marked urgent', async () => {
  assert.equal(portalMessageProblem(message(), 'Patient/p', 'Patient/p'), undefined);
  assert.match(portalMessageProblem(message({ sender: { reference: 'Practitioner/x' } }), 'Patient/p', 'Patient/p') ?? '', /own name/);
  assert.match(portalMessageProblem(message({ subject: { reference: 'Patient/other' } }), 'Patient/p', 'Patient/p') ?? '', /own care/);
  assert.match(portalMessageProblem(message({ payload: [{ contentString: '  ' }] }), 'Patient/p', 'Patient/p') ?? '', /Write/);
  assert.match(portalMessageProblem(message({ payload: [{ contentString: 'x'.repeat(4001) }] }), 'Patient/p', 'Patient/p') ?? '', /4000/);
  assert.match(portalMessageProblem(message({ status: 'completed' }), 'Patient/p', 'Patient/p') ?? '', /review/);
  const m = client({ readResource: async (type: string) => (type === 'RelatedPerson' ? { resourceType: 'RelatedPerson', id: 'g', patient: { reference: 'Patient/kid' } } : notFound()) });
  const routine = (await messageRules(m, event(message(), 'Patient/p'))) as Communication;
  assert.equal(routine.priority, 'routine');
  const urgent = (await messageRules(m, event(message({ payload: [{ contentString: 'I want to end my life' }] }), 'Patient/p'))) as Communication;
  assert.equal(urgent.priority, 'urgent');
  await assert.rejects(messageRules(m, event(message({ sender: { reference: 'RelatedPerson/g' } }), 'RelatedPerson/g')), /own care/, 'a proxy writes about their own patient');
  assert.ok(await messageRules(m, event(message({ subject: { reference: 'Patient/kid' }, sender: { reference: 'RelatedPerson/g' } }), 'RelatedPerson/g')));
});

test('portal replies: staff under their own name; once sent only the notified marker may be added', async () => {
  const reply: Communication = { resourceType: 'Communication', id: 'r', status: 'completed', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_REPLY }] }], subject: { reference: 'Patient/p' }, sender: { reference: 'Practitioner/staff' }, payload: [{ contentString: 'Reply' }] };
  const fresh = client({ readResource: notFound });
  assert.ok(await messageRules(fresh, event({ ...reply, id: undefined })));
  await assert.rejects(messageRules(fresh, event({ ...reply, id: undefined, sender: { reference: 'Practitioner/other' } })), /own name/);
  const stored = client({ readResource: async () => reply });
  assert.ok(await messageRules(stored, event({ ...reply, extension: [{ url: EXT.notifiedAt, valueDateTime: NOW.toISOString() }] }, 'ClientApplication/portal')));
  await assert.rejects(messageRules(stored, event({ ...reply, payload: [{ contentString: 'Rewritten' }] })), /cannot be changed/);
});

const refill = (over: Partial<Task> = {}): Task => ({
  resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'rx-renewal' }] },
  for: { reference: 'Patient/p' }, requester: { reference: 'Patient/p' }, owner: { reference: 'Practitioner/prov' }, input: [{ type: { text: 'medication' }, valueString: 'Sertraline 50 mg' }], ...over,
});

test('portal refill requests: own medication, one at a time, server-set SLA and priority', async () => {
  const m = (open: Task[] = []) => client({ readResource: async (type: string) => (type === 'MedicationRequest' ? { resourceType: 'MedicationRequest', subject: { reference: 'Patient/p' } } : notFound()), searchResources: async () => open });
  const saved = (await taskRules(m(), event(refill({ priority: 'stat', restriction: { period: { end: '2099-01-01T00:00:00Z' } } }), 'Patient/p'))) as Task;
  assert.equal(saved.priority, 'routine');
  assert.ok((saved.restriction?.period?.end ?? '') < '2099');
  await assert.rejects(taskRules(m([refill({ id: 'open' })]), event(refill(), 'Patient/p')), /already with the care team/);
  await assert.rejects(taskRules(m(), event(refill({ for: { reference: 'Patient/other' } }), 'Patient/p')), /your own medication/);
  await assert.rejects(taskRules(m(), event(refill({ requester: { reference: 'Patient/other' } }), 'Patient/p')), /own name/);
  await assert.rejects(taskRules(m(), event(refill({ code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'general' }] } }), 'Patient/p')), /Only refill requests/);
  await assert.rejects(taskRules(m(), event(refill({ status: 'completed' }), 'Patient/p')), /care team for review/);
  await assert.rejects(taskRules(client({ readResource: async () => ({ resourceType: 'MedicationRequest', subject: { reference: 'Patient/other' } }), searchResources: async () => [] }), event(refill({ focus: { reference: 'MedicationRequest/x' } }), 'Patient/p')), /your own medication/);
  await assert.rejects(taskRules(client({ readResource: async () => refill({ id: 't' }) }), event(refill({ id: 't', status: 'cancelled' }), 'Patient/p')), /cannot be changed/);
  await assert.rejects(taskRules(client({ readResource: notFound }), event({ ...refill(), code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }] }, focus: { reference: 'Appointment/a' } })), /names the patient or proxy/);
});

test('the appointment Bot enforces online-booking rules on online and portal bookings only', async () => {
  const m = client({ readResource: notFound, readReference: async () => licensed, searchOne: async () => undefined, searchResources: async () => [] });
  // Real now: choose a time 2–3 days ahead at 10:00 Bellevue time on a weekday.
  const day = new Date(Date.now() + 3 * 86400000);
  while ([0].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  const start = `${day.toISOString().slice(0, 10)}T17:00:00.000Z`;
  const end = `${day.toISOString().slice(0, 10)}T18:00:00.000Z`;
  assert.ok(await appointmentRules(m, event(appt({ start, end }))));
  await assert.rejects(appointmentRules(m, event(appt({ start, end }, 'med-mgmt'))), /new patient evaluation/);
  await assert.rejects(appointmentRules(m, event(appt({ start, end, extension: [{ url: EXT.modality, valueCode: 'office' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.bookingChannel, valueCode: 'online' }] }))), /video/);
  await assert.rejects(appointmentRules(m, event(appt({ start, end, status: 'pending' }))), /hold expiry/);
  await assert.rejects(appointmentRules(m, event(appt({ start, end, extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'TX' }, { url: EXT.bookingChannel, valueCode: 'online' }] }))), /not licensed in TX/);
  // Staff bookings (no channel) are not limited to online rules.
  assert.ok(await appointmentRules(m, event(appt({ start: new Date(Date.now() + 3600000).toISOString().replace(/:\d\d\.\d{3}Z/, ':00.000Z'), end: new Date(Date.now() + 7200000).toISOString(), extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }] }, 'med-mgmt'))));
});

test('the appointment Bot requires a signed, licensed current-location check-in', async () => {
  const prior = appt({ id: 'check-in-appointment', status: 'booked' });
  const methods = { readResource: async () => prior, readReference: async () => licensed, searchResources: async () => [] };
  const arrival = (state: string, confirmer: string): Appointment => appt({
    id: 'check-in-appointment', status: 'arrived',
    extension: [{ url: EXT.patientLocationState, valueCode: state }, locationConfirmedExtension(confirmer, state, new Date())],
  });
  assert.ok(await appointmentRules(client(methods), event(arrival('WA', 'Practitioner/staff'))));
  await assert.rejects(appointmentRules(client(methods), event(appt({ id: 'check-in-appointment', status: 'arrived', extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }] }))), /Record who confirmed/);
  await assert.rejects(appointmentRules(client(methods), event(arrival('WA', 'Practitioner/other'))), /staff member or patient/);
  await assert.rejects(appointmentRules(client(methods), event(arrival('TX', 'Practitioner/staff'))), /not licensed in TX/);

  const closed = { ...prior, status: 'cancelled' as const };
  await assert.rejects(appointmentRules(client({ ...methods, readResource: async () => closed }), event(arrival('WA', 'Practitioner/staff'))), /Only a booked visit/);

  const portalMethods = {
    ...methods,
    readResource: async (type: string) => {
      if (type === 'Appointment') return prior;
      if (type === 'ClientApplication') return { resourceType: 'ClientApplication', name: 'Teleemon portal service' };
      if (type === 'RelatedPerson') return { resourceType: 'RelatedPerson', active: true, patient: { reference: 'Patient/p' } };
      return notFound();
    },
  };
  assert.ok(await appointmentRules(client(portalMethods), event(arrival('WA', 'Patient/p'), 'ClientApplication/portal-service')));
  assert.ok(await appointmentRules(client(portalMethods), event(arrival('WA', 'RelatedPerson/proxy'), 'ClientApplication/portal-service')));
  await assert.rejects(appointmentRules(client({ ...portalMethods, readResource: async (type: string) => type === 'Appointment' ? prior : { resourceType: 'ClientApplication', name: 'Other service' } }), event(arrival('WA', 'Patient/p'), 'ClientApplication/other')));
  await assert.rejects(appointmentRules(client({ ...portalMethods, readResource: async (type: string) => type === 'Appointment' ? prior : type === 'ClientApplication' ? { resourceType: 'ClientApplication', name: 'Teleemon portal service' } : { resourceType: 'RelatedPerson', patient: { reference: 'Patient/other' } } }), event(arrival('WA', 'RelatedPerson/proxy'), 'ClientApplication/portal-service')), /authorized proxy/);
});

test('intake: required answers, conditional questions, resume point and consent status', () => {
  assert.deepEqual(missingIntakeAnswers({ reason: 'x', 'prior-treatment': false, hospitalized: false }), []);
  assert.deepEqual(missingIntakeAnswers({ 'prior-treatment': true, hospitalized: false }).map((q) => q.linkId), ['reason']);
  const empty = { patient: { resourceType: 'Patient' as const }, coverages: [], consents: [] as Consent[], measuresDue: ['phq9'] };
  assert.equal(resumeStep(empty), 'about');
  const about: Patient = { resourceType: 'Patient', telecom: [{ system: 'phone', value: '206-555-0100' }], address: [{ line: ['1 Main St'], city: 'Seattle', state: 'WA', postalCode: '98101' }], contact: [{ relationship: [{ coding: [{ code: 'C' }] }], telecom: [{ system: 'phone', value: '206-555-0102' }] }], extension: [{ url: EXT.selfPay, valueBoolean: true }, { url: EXT.sexAssignedAtBirth, valueCode: 'female' }] };
  assert.equal(resumeStep({ ...empty, patient: about }), 'history');
  const consent = (type: string): Consent => ({ resourceType: 'Consent', status: 'active', scope: {}, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: type }] }] });
  assert.ok(signedPortalConsent([consent('treatment')], PORTAL_CONSENTS[0]));
  assert.equal(signedPortalConsent([{ ...consent('treatment'), status: 'inactive' }], PORTAL_CONSENTS[0]), undefined);
  assert.equal(INTAKE_STEPS.at(-1)?.key, 'review');
  assert.ok(PORTAL_CONSENTS.every((d) => d.version && d.body.length > 100), 'every consent has a version and wording');
});

test('booking-page proof of work: signed, single-use, expiring, at full difficulty', () => {
  const pow = new ProofOfWork('x'.repeat(40));
  const solution = solve(pow.issue());
  assert.equal(pow.verify(solution), undefined);
  assert.match(pow.verify(solution) ?? '', /again/, 'single use');
  const other = solve(pow.issue());
  assert.match(pow.verify({ ...other, nonce: `${other.nonce}0` }) ?? '', /complete the check/, 'wrong nonce');
  assert.match(pow.verify({ ...other, difficulty: 1 }) ?? '', /complete the check/, 'difficulty is signed');
  assert.match(pow.verify({ ...other, expires: other.expires + 1 }) ?? '', /complete the check/, 'expiry is signed');
  assert.match(pow.verify(other, other.expires + 1) ?? '', /expired/);
  assert.match(new ProofOfWork('y'.repeat(40)).verify(solve(pow.issue())) ?? '', /complete the check/, 'another secret');
  assert.throws(() => new ProofOfWork('short'), /32 characters/);
});

test('public booking is rate limited per address, and invitation tokens are stored as hashes', () => {
  const book = new RateLimiter(5, 3600000);
  for (let i = 0; i < 5; i++) book.take('203.0.113.7', 1000);
  assert.throws(() => book.take('203.0.113.7', 1000), (e: unknown) => e instanceof HttpError && e.status === 429);
  book.take('198.51.100.2', 1000);
  book.take('203.0.113.7', 1000 + 3600001);
  assert.match(hashToken('token'), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken('token'), 'token');
});

// ---------------------------------------------------------------- Onboarding (PATIENT-ONBOARDING-PLAN.md)

const adult: Patient = {
  resourceType: 'Patient', id: 'a', birthDate: '1990-01-01', gender: 'female', name: [{ use: 'official', given: ['Ana'], family: 'Lopez' }],
  telecom: [{ system: 'phone', value: '206-555-0100' }, { system: 'email', value: 'ana@example.com' }], address: [{ use: 'home', state: 'WA' }],
  contact: [{ relationship: [{ coding: [{ code: 'C' }] }], telecom: [{ system: 'phone', value: '206-555-0101' }] }],
  extension: [{ url: EXT.sexAssignedAtBirth, valueCode: 'female' }, { url: EXT.cardOnFile, valueString: JSON.stringify({ provider: 'sandbox', last4: '4242' }) }, { url: EXT.selfPay, valueBoolean: true }],
};
const consentOf = (type: string): Consent => ({ resourceType: 'Consent', status: 'active', scope: {}, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: type }] }] });
const allConsents = ['treatment', 'telehealth', 'recording', 'financial', 'privacy-notice'].map(consentOf);

test('patients under 18 are not invited to their own sign-in until the teen age is decided', async () => {
  assert.match(patientInviteProblem({ resourceType: 'Patient', birthDate: '2015-01-01' }) ?? '', /guardian/);
  assert.equal(patientInviteProblem(adult), undefined);
  const m = client({ readResource: async (t: string) => (t === 'Patient' ? { resourceType: 'Patient', id: 'kid', birthDate: '2014-05-05' } : notFound()) });
  const invite = (focus: string): Task => ({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }] }, focus: { reference: focus } });
  await assert.rejects(taskRules(m, event(invite('Patient/kid'))), /under 18/);
  assert.ok(await taskRules(client({ readResource: async (t: string) => (t === 'Patient' ? adult : notFound()) }), event(invite('Patient/a'))));
});

test('registration gaps and the verification checklist name what is missing', () => {
  assert.deepEqual(registrationGaps(adult), []);
  assert.deepEqual(registrationGaps({ resourceType: 'Patient' }).map((g) => g.key), ['sex-at-birth', 'phone', 'email', 'home-state', 'emergency-contact']);
  assert.deepEqual(onboardingProblems({ patient: adult, coverages: [], consents: allConsents, onControlled: false }), []);
  assert.deepEqual(onboardingProblems({ patient: adult, coverages: [], consents: allConsents, onControlled: true }).map((p) => p.key), ['consent-controlled-substance']);
  const insured: Patient = { ...adult, extension: adult.extension?.filter((e) => e.url !== EXT.selfPay && e.url !== EXT.cardOnFile) };
  const draft: Coverage = { resourceType: 'Coverage', status: 'draft', beneficiary: { reference: 'Patient/a' }, payor: [{ display: 'Plan' }] };
  assert.deepEqual(onboardingProblems({ patient: insured, coverages: [draft], consents: allConsents.slice(1), onControlled: false }).map((p) => p.key), ['insurance', 'card', 'consent-treatment']);
  assert.deepEqual(onboardingProblems({ patient: { ...insured, extension: adult.extension?.filter((e) => e.url !== EXT.selfPay) }, coverages: [{ ...draft, status: 'active' }], consents: allConsents, onControlled: false }), []);
  assert.equal(requiredPortalConsents(false).length, 5);
  assert.equal(requiredPortalConsents(true).length, 6);
  assert.ok(isControlledStatement({ resourceType: 'MedicationStatement', status: 'active', subject: { reference: 'Patient/a' }, medicationCodeableConcept: { text: 'x' }, extension: [{ url: EXT.controlledSchedule, valueCode: '2' }] }));
  assert.equal(isControlledStatement({ resourceType: 'MedicationStatement', status: 'active', subject: { reference: 'Patient/a' }, medicationCodeableConcept: { text: 'Sertraline 50 mg' } }), false);
  assert.equal(isControlledStatement({ resourceType: 'MedicationStatement', status: 'stopped', subject: { reference: 'Patient/a' }, medicationCodeableConcept: { text: 'x' }, extension: [{ url: EXT.controlledSchedule, valueCode: '2' }] }), false);
});

test('AUDIT-C uses the more sensitive threshold when sex at birth is not recorded', () => {
  const def = MEASURES['audit-c'];
  const three = Object.fromEntries(def.items.map((i, n) => [i.linkId, n === 0 ? 3 : 0]));
  assert.equal(scoreMeasure(def, three, 'male').positive, false);
  assert.equal(scoreMeasure(def, three, 'female').positive, true);
  assert.equal(scoreMeasure(def, three, undefined).positive, true);
  assert.match(scoreMeasure(def, three, undefined).band?.label ?? '', /not recorded/);
  assert.equal(scoreMeasure(def, three, 'unknown').positive, true);
});

test('patients set their preferred name, demographics and (once) sex at birth; legal name stays with staff', () => {
  const p: Patient = { resourceType: 'Patient', id: 'p', birthDate: '1990-01-01', name: [{ use: 'official', given: ['Sam'], family: 'Rivera' }] };
  assert.equal(patientSelfEditProblem(p, { ...p, name: [...(p.name ?? []), { use: 'nickname', given: ['Sammy'] }] }), undefined);
  assert.match(patientSelfEditProblem(p, { ...p, name: [{ use: 'official', given: ['Samuel'], family: 'Rivera' }] }) ?? '', /care team/);
  const withSex: Patient = { ...p, gender: 'male', extension: [{ url: EXT.sexAssignedAtBirth, valueCode: 'male' }] };
  assert.equal(patientSelfEditProblem(p, withSex), undefined);
  assert.match(patientSelfEditProblem(p, { ...withSex, gender: 'female' }) ?? '', /care team/, 'gender must match');
  assert.match(patientSelfEditProblem(withSex, { ...withSex, extension: [{ url: EXT.sexAssignedAtBirth, valueCode: 'female' }], gender: 'female' }) ?? '', /corrected by the care team/);
  assert.match(patientSelfEditProblem(p, { ...p, gender: 'female' }) ?? '', /care team/);
  assert.match(patientSelfEditProblem(p, { ...p, extension: [{ url: EXT.sexAssignedAtBirth, valueCode: 'other' }] }) ?? '', /from the list/);
  assert.equal(patientSelfEditProblem(p, { ...p, maritalStatus: { text: 'Married' }, extension: [{ url: EXT.genderIdentity, valueCodeableConcept: { text: 'Man' } }, { url: US_CORE_RACE, extension: [{ url: 'text', valueString: 'Asian' }] }] }), undefined);
  assert.equal(genderForSex('unknown'), 'unknown');
});

test('intake: sex at birth is part of About you; self-pay needs the estimate acknowledged', () => {
  const base = { coverages: [], consents: [] as Consent[], measuresDue: [] };
  const about: Patient = { resourceType: 'Patient', telecom: [{ system: 'phone', value: '206-555-0100' }], address: [{ line: ['1 Main St'], city: 'Seattle', state: 'WA', postalCode: '98101' }], contact: [{ relationship: [{ coding: [{ code: 'C' }] }], telecom: [{ system: 'phone', value: '206-555-0102' }] }], extension: [{ url: EXT.selfPay, valueBoolean: true }] };
  assert.equal(resumeStep({ ...base, patient: about }), 'about', 'no sex at birth yet');
  const withSex: Patient = { ...about, extension: [...(about.extension ?? []), { url: EXT.sexAssignedAtBirth, valueCode: 'female' }] };
  assert.equal(resumeStep({ ...base, patient: withSex, estimateNeeded: true }), 'insurance');
  assert.equal(resumeStep({ ...base, patient: withSex, estimateNeeded: false }), 'history');
});

test('portal uploads: own insurance card photos only, preliminary, images or PDF up to 10 MB', async () => {
  const card = (over: Partial<DocumentReference> = {}): DocumentReference => ({
    resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: { reference: 'Patient/p' },
    category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'id-insurance' }] }], content: [{ attachment: { contentType: 'image/jpeg', size: 2_000_000 } }], ...over,
  });
  const m = client({ readResource: async () => ({ resourceType: 'RelatedPerson', id: 'g', patient: { reference: 'Patient/kid' } }) });
  assert.ok(await documentRules(m, event(card(), 'Patient/p')));
  await assert.rejects(documentRules(m, event(card({ category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'lab-report' }] }] }), 'Patient/p')), /Only insurance card/);
  await assert.rejects(documentRules(m, event(card({ docStatus: 'final' }), 'Patient/p')), /preliminary/);
  await assert.rejects(documentRules(m, event(card({ content: [{ attachment: { contentType: 'text/html' } }] }), 'Patient/p')), /photo/);
  await assert.rejects(documentRules(m, event(card({ content: [{ attachment: { contentType: 'image/png', size: 11 * 1024 * 1024 } }] }), 'Patient/p')), /10 MB/);
  await assert.rejects(documentRules(m, event(card({ subject: { reference: 'Patient/other' } }), 'Patient/p')), /own record/);
  assert.ok(await documentRules(m, event(card({ subject: { reference: 'Patient/kid' } }), 'RelatedPerson/g')), 'a guardian uploads to the child');
});

test('submitting the intake opens one front-desk review; completing it needs a complete record', async () => {
  const created: Task[] = [];
  const m = client({ createResourceIfNoneExist: async (t: Task) => { created.push(t); return { ...t, id: 'review' }; } });
  const qr: QuestionnaireResponse = { resourceType: 'QuestionnaireResponse', id: 'qr', questionnaire: INTAKE_QUESTIONNAIRE_URL, status: 'completed', subject: { reference: 'Patient/a' } };
  await onboardingBot(m, event<QuestionnaireResponse>(qr));
  await onboardingBot(m, event<QuestionnaireResponse>({ ...qr, status: 'in-progress' }));
  await onboardingBot(m, event<QuestionnaireResponse>({ ...qr, questionnaire: 'https://fhir.teleemon.com/Questionnaire/phq9' }));
  assert.equal(created.length, 1);
  assert.equal(created[0].identifier?.[0]?.value, 'onboarding-review-a');
  const review: Task = { ...created[0], id: 'review' };
  const reads = (patient: Patient, consents: Consent[]) => client({ readResource: async (t: string) => (t === 'Task' ? review : patient), searchResources: async (t: string) => (t === 'Consent' ? consents : []) });
  await assert.rejects(taskRules(reads({ resourceType: 'Patient', id: 'a' }, []), event({ ...review, status: 'completed' })), /Still missing: Sex assigned at birth/);
  assert.ok(await taskRules(reads(adult, allConsents), event({ ...review, status: 'completed' })));
});

test('good-faith estimate: visit price and codes, acknowledged per appointment', () => {
  const type = VISIT_TYPES.find((v) => v.code === 'new-eval') as VisitType;
  const est = goodFaithEstimate({ resourceType: 'Appointment', id: 'ap', status: 'booked', participant: [] }, type, 'Monday');
  assert.equal(est.amount, 350);
  assert.match(est.body, /90792/);
  const ack: Consent = { ...consentOf('good-faith-estimate'), provision: { data: [{ meaning: 'related', reference: { reference: 'Appointment/ap' } }] } };
  assert.equal(estimateAcknowledged([ack], 'ap'), true);
  assert.equal(estimateAcknowledged([ack], 'other'), false);
});
