// Phase 7 gate: patient portal and public booking, proven against the local Medplum server with
// real portal sign-ins (patients and proxies through the portal ClientApplication), the deployed
// Bots and policies, and the portal service's own code over HTTP. Every rule is also attempted by
// calling Medplum directly, bypassing the portal, and must be refused there. Synthetic records
// only; everything created here is removed afterwards.

import { MedplumClient, createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Appointment, Communication, Consent, DocumentReference, Patient, Practitioner, ProjectMembership, QuestionnaireResponse, RelatedPerson, Resource, ResourceType, Task } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, EXT, INTAKE_QUESTIONNAIRE_URL, onboardingReviewIdentifier, PORTAL_CONSENTS, PORTAL_INVITATION_SYSTEM, PORTAL_MESSAGE, PORTAL_REPLY, SEED_IDENTIFIER_SYSTEM, guardianContact, questionnaireUrl, MEASURES,
} from '@teleemon/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { QUEUES, loadInbox } from '../apps/staff/src/inbox/inbox';
import { freeTimes } from '../services/portal/src/availability';
import { releaseHolds } from '../services/portal/src/booking';
import { ProofOfWork, solve } from '../services/portal/src/captcha';
import { createInvitation, hashToken, processInviteTasks, reviewProxies } from '../services/portal/src/invitations';
import { remindIncompleteIntake } from '../services/portal/src/onboarding';
import { buildRouter, connectPortalService } from '../services/portal/src/index';
import { notifyReplies } from '../services/portal/src/notify';
import { ROOT, baseUrl, connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
const PORTAL_PASSWORD = 'Synthetic-portal-2026!';
const RUN = Date.now().toString(36);
const LETTERS = RUN.replace(/[^a-z]/g, '').padEnd(4, 'q').slice(0, 6);
const created: Resource[] = [];
const patients: Patient[] = [];
let failures = 0;
let passes = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.slice(0, 160)})` : ''}`);
}
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}
async function eventually<T>(fn: () => Promise<T | undefined>, tries = 20): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}
const track = <T extends Resource>(r: T): T => { created.push(r); return r; };
const yearsAgo = (n: number, extraDays = 40): string => new Date(Date.now() - (n * 365.25 + extraDays) * 86400000).toISOString().slice(0, 10);

const OUTBOX = join(ROOT, 'services', 'worker', 'outbox.log');
/** The newest activation link emailed (by the log transport) to this address. */
function linkFor(email: string): string | undefined {
  if (!existsSync(OUTBOX)) return undefined;
  const lines = readFileSync(OUTBOX, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    const entry = JSON.parse(line) as { to: string; text: string };
    if (entry.to === email) return /activate\?token=([A-Za-z0-9_-]+)/.exec(entry.text)?.[1];
  }
  return undefined;
}
const emails = (email: string): number => existsSync(OUTBOX) ? readFileSync(OUTBOX, 'utf8').split('\n').filter((l) => l.includes(`"to":"${email}"`)).length : 0;

function portalAppEnv(): { clientId: string; projectId: string } {
  const env = parseEnv(readFileSync(join(ROOT, 'apps', 'portal', '.env.local'), 'utf8'));
  return { clientId: env.MEDPLUM_CLIENT_ID as string, projectId: env.MEDPLUM_PROJECT_ID as string };
}

/** Signs in exactly as the portal app does: its public client, PKCE, project-scoped user. */
async function portalLogin(email: string, password: string, profileRef?: string): Promise<MedplumClient> {
  const { clientId, projectId } = portalAppEnv();
  const m = new MedplumClient({ baseUrl: baseUrl(), clientId });
  // Outside a browser the SDK logs a harmless PKCE fallback warning; keep the report readable.
  const { warn, error } = console;
  const quiet = (original: (...a: unknown[]) => void) => (...a: unknown[]): void => { if (!(typeof a[0] === 'string' && a[0].startsWith('Failed to hash code verifier'))) original(...a); };
  console.warn = quiet(warn);
  console.error = quiet(error);
  let res = await m.startLogin({ email, password, projectId }).finally(() => { console.warn = warn; console.error = error; });
  if (res.memberships && !res.code) {
    const chosen = res.memberships.find((x) => !profileRef || x.profile?.reference === profileRef) ?? res.memberships[0];
    res = await m.post('auth/profile', { login: res.login, profile: chosen.id });
  }
  if (!res.code) throw new Error('portal sign-in did not complete');
  await m.processCode(res.code);
  return m;
}

async function main(): Promise<void> {
  const admin = await connect();
  const portal = await connectPortalService();
  const prac = (await admin.searchOne('Practitioner', { identifier: `${SEED_IDENTIFIER_SYSTEM}|prac-provider` })) as Practitioner;
  const pow = new ProofOfWork(process.env.TELEEMON_PORTAL_SECRET ?? '');
  // The public booking limit (5 per address per hour) is proven in the regression tests; this run books more.
  const router = buildRouter(portal, pow, undefined, { browsePerMinute: 1000, bookPerHour: 100, linksPerHour: 100 });
  const server = createServer((req, res) => void router.handle(req, res)).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/portal/`;
  try {
    await checks(admin, portal, prac, api, pow);
  } finally {
    server.close();
    console.log(`\n(cleaned up ${await cleanup(admin, portal.projectId)} test resources)`);
  }
  console.log(`\n${passes} PASS, ${failures} FAIL (${passes + failures} checks)`);
  console.log(failures === 0 ? '✓ Phase 7 server-side checks passed' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

type Http = (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; json: Record<string, unknown> }>;

async function checks(admin: MedplumClient, portal: Awaited<ReturnType<typeof connectPortalService>>, prac: Practitioner, api: string, pow: ProofOfWork): Promise<void> {
  const http: Http = async (method, path, body, token) => {
    const res = await fetch(api + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const { service, accounts, projectId } = portal;

  console.log('Patient registration without booking');
  const registration = { given: 'Register', family: `Registrant${LETTERS}`, birthDate: '1985-05-12', email: `register-${RUN}@example.com`, phone: '2065550198', state: 'WA', smsConsent: false };
  const register = async (body: object) => http('POST', 'public/register', { ...body, proof: solve(pow.issue()) });
  report((await http('POST', 'public/register', registration)).status === 400, 'Registration requires a fresh anti-bot proof');
  report((await register({ ...registration, birthDate: '1985-02-31' })).status === 400, 'Registration refuses impossible calendar dates');
  report((await register({ ...registration, given: 123 })).status === 400, 'Registration refuses malformed identity fields');
  report((await register({ ...registration, birthDate: yearsAgo(12) })).status === 400, 'Self-registration refuses minors and directs guardian registration');
  report((await register({ ...registration, state: 'TX' })).status === 400, 'Registration refuses states the practice does not serve');
  const registered = await register(registration);
  const registrant = await admin.searchOne('Patient', { email: registration.email }, { cache: 'no-cache' });
  if (registrant) patients.push(registrant);
  report(registered.status === 200 && !!registrant, 'An adult can register without selecting an appointment');
  if (!registrant) throw new Error('Registration did not create the synthetic patient');
  report((await admin.searchResources('Appointment', { patient: getReferenceString(registrant) })).length === 0 && !(await accounts.searchOne('ProjectMembership', { profile: getReferenceString(registrant) })), 'Registration creates neither a booking nor sign-in access before email verification');
  report(!!registrant.extension?.some((ext) => ext.url === EXT.contactOptOut && ext.valueCode === 'sms'), 'Registration leaves optional text reminders opted out by default');
  const registrationToken = linkFor(registration.email);
  report(!!registrationToken, 'Registration emails a single-use account verification link');
  const activatedRegistration = await http('POST', 'public/activate', { token: registrationToken, password: PORTAL_PASSWORD });
  report(activatedRegistration.status === 200 && activatedRegistration.json.appointment === undefined, 'Email activation sets up the account without creating a visit');
  const registrationClient = await portalLogin(registration.email, PORTAL_PASSWORD);
  report(registrationClient.getProfile()?.id === registrant.id, 'The registered adult signs in to their own portal record');
  const duplicateRegistration = await register(registration);
  const registrationPatients = await admin.searchResources('Patient', { email: registration.email }, { cache: 'no-cache' });
  report(duplicateRegistration.status === registered.status && JSON.stringify(duplicateRegistration.json) === JSON.stringify(registered.json) && registrationPatients.length === 1, 'Duplicate registration returns the same public response and does not duplicate or expose the chart');
  const registrationReview = await admin.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|booking-review`, _count: '100' });
  const matchingReview = registrationReview.find((task) => task.input?.some((input) => input.valueString === registration.email));
  if (matchingReview) track(matchingReview);
  report(!!matchingReview, 'Possible duplicate registration is routed to staff for identity verification');

  // ---------------------------------------------------------------- X01 public booking
  console.log('X01 Public booking');
  const tx = await http('GET', 'public/slots?state=TX&visitType=new-eval');
  report(tx.status === 400 && tx.json.code === 'unlicensed-state', 'Free times are refused for a state with no licensed provider', String(tx.json.message));
  const slots = await http('GET', 'public/slots?state=WA&visitType=new-eval');
  const days = (slots.json.days as { date: string; times: { start: string; practitionerId: string }[] }[]) ?? [];
  const firstTime = days.flatMap((d) => d.times).find(Boolean);
  report(!!firstTime && days.flatMap((d) => d.times).every((t) => Date.parse(t.start) > Date.now() + 23.9 * 3600000), 'Public times exist for WA and are all at least 24 hours ahead');
  report(JSON.stringify(slots.json).match(/"(name|patient|family|birthDate)"/) === null, 'Free times carry no patient or visit details');
  if (!firstTime) throw new Error('No free WA time to book; check practice hours and the seed schedule.');
  // Other free times well clear of the held hour, for the duplicate and expired-hold checks.
  const clear = days.flatMap((d) => d.times).filter((t) => Date.parse(t.start) >= Date.parse(firstTime.start) + 2 * 3600000);
  const [dupTime, holdTime] = [clear[0], clear[8] ?? clear[clear.length - 1]];

  const email = `portal.${RUN}@example.com`;
  const person = { given: 'Synthetic', family: `Portal${LETTERS}`, birthDate: yearsAgo(34), email, phone: '206-555-0142', smsConsent: false };
  const booking = { ...person, state: 'WA', visitType: 'new-eval', start: firstTime.start, practitionerId: firstTime.practitionerId };
  const noProof = await http('POST', 'public/book', booking);
  report(noProof.status === 400 && noProof.json.code === 'captcha', 'Booking without the proof-of-work check is refused');
  const forged = await http('POST', 'public/book', { ...booking, proof: { ...solve(pow.issue()), signature: '00'.repeat(32) } });
  report(forged.status === 400 && forged.json.code === 'captcha', 'A forged check signature is refused');
  const minor = await http('POST', 'public/book', { ...booking, birthDate: yearsAgo(15), proof: solve(pow.issue()) });
  report(minor.status === 400 && minor.json.code === 'minor', 'A patient under 18 cannot book online (guardian books by phone)');
  const outOfState = await http('POST', 'public/book', { ...booking, state: 'TX', proof: solve(pow.issue()) });
  report(outOfState.status === 400 && outOfState.json.code === 'unlicensed-state', 'Booking a visit while located in an unlicensed state is refused');
  const proof = solve(pow.issue());
  const booked = await http('POST', 'public/book', { ...booking, proof });
  report(booked.status === 200 && booked.json.status === 'check-email', 'Public booking answers "check your email"');
  const replay = await http('POST', 'public/book', { ...booking, given: 'Synthetic', family: `Replay${LETTERS}`, proof });
  report(replay.status === 400 && replay.json.code === 'captcha', 'A solved check cannot be used twice');

  const newPatient = await eventually(() => admin.searchOne('Patient', { email, _count: '1' }, { cache: 'no-cache' }));
  if (newPatient) patients.push(newPatient);
  const held = newPatient ? await admin.searchOne('Appointment', { patient: getReferenceString(newPatient), _count: '1' }, { cache: 'no-cache' }) : undefined;
  report(held?.status === 'pending' && !!held.extension?.some((e) => e.url === EXT.holdExpires) && held.extension.some((e) => e.url === EXT.bookingChannel && e.valueCode === 'online'), 'The time is held (pending, with a hold expiry) until the email link is opened');
  report(!!newPatient?.extension?.some((e) => e.url === EXT.contactOptOut && e.valueCode === 'sms'), 'Declining texts at booking records the SMS opt-out');
  const token = linkFor(email);
  report(!!token, 'A single-use confirmation link was emailed (log transport)');
  const invitation = token ? await admin.searchOne('Basic', { identifier: `${PORTAL_INVITATION_SYSTEM}|${hashToken(token)}` }, { cache: 'no-cache' }) : undefined;
  report(!!invitation && !JSON.stringify(invitation).includes(token as string), 'Only the SHA-256 of the link token is stored, never the token');

  // Direct writes that bypass the portal service are refused by the appointment Bot.
  const base = (over: Partial<Appointment>): Appointment => ({
    resourceType: 'Appointment', status: 'booked', start: firstTime.start, end: new Date(Date.parse(firstTime.start) + 3600000).toISOString(),
    appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: 'new-eval' }] },
    participant: [{ actor: createReference(newPatient as Patient), status: 'accepted' }, { actor: createReference(prac), status: 'accepted' }],
    extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'TX' }, { url: EXT.bookingChannel, valueCode: 'online' }], ...over,
  });
  const direct = await attempt(() => service.createResource(base({})));
  report(!direct.ok && /licen/i.test(direct.error ?? ''), 'Direct API: an online booking located in TX is refused by the server', direct.error);
  const soon = new Date(Math.ceil((Date.now() + 3 * 3600000) / 900000) * 900000).toISOString();
  const tooSoon = await attempt(() => service.createResource(base({ start: soon, end: new Date(Date.parse(soon) + 3600000).toISOString(), extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.bookingChannel, valueCode: 'online' }] })));
  report(!tooSoon.ok && /24 hours/i.test(tooSoon.error ?? ''), 'Direct API: an online new-patient booking within 24 hours is refused', tooSoon.error);
  const clash = await attempt(() => service.createResource(base({ extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.bookingChannel, valueCode: 'online' }] })));
  report(!clash.ok && /overlaps/i.test(clash.error ?? ''), 'Direct API: a second booking over the held time is refused', clash.error);

  // Duplicate: the same person books again. No record is created and the caller cannot tell.
  const dup = await http('POST', 'public/book', { ...booking, start: dupTime?.start, email: `other.${RUN}@example.com`, proof: solve(pow.issue()) });
  const dupPatients = await admin.searchResources('Patient', { family: person.family, _count: '5' }, { cache: 'no-cache' });
  const review = await eventually(async () => (await admin.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|booking-review`, _sort: '-_lastUpdated', _count: '20' }, { cache: 'no-cache' })).find((t) => t.description?.includes(person.family)));
  if (review) track(review);
  report(dup.status === 200 && dup.json.status === 'check-email' && dupPatients.length === 1 && !!review, 'A booking matching an existing record gets the same answer, creates no record, and goes to the front desk');

  // ---------------------------------------------------------------- Activation and sign-in
  console.log('Invitation links and sign-in');
  const bad = await http('POST', 'public/activate', { token: 'x'.repeat(43), password: PORTAL_PASSWORD });
  report(bad.status === 400 && bad.json.code === 'invalid-link', 'An unknown link is refused');
  const weak = await http('POST', 'public/activate', { token, password: 'short' });
  report(weak.status === 400, 'A password under 12 characters is refused');
  const act = await http('POST', 'public/activate', { token, password: PORTAL_PASSWORD });
  report(act.status === 200 && act.json.appointment === 'confirmed', 'Opening the link sets the password and confirms the held visit', JSON.stringify(act.json));
  const again = await http('POST', 'public/activate', { token, password: PORTAL_PASSWORD });
  report(again.status === 400 && again.json.code === 'link-used', 'The link is single-use');
  const confirmed = held ? await admin.readResource('Appointment', held.id as string, { cache: 'no-cache' }) : undefined;
  report(confirmed?.status === 'booked' && !confirmed.extension?.some((e) => e.url === EXT.holdExpires), 'The held visit is now booked');
  const patientClient = await portalLogin(email, PORTAL_PASSWORD);
  report(patientClient.getProfile()?.resourceType === 'Patient' && patientClient.getProfile()?.id === newPatient?.id, 'The patient signs in through the portal client as their own Patient profile');
  const pt = patientClient.getAccessToken() as string;
  const staffLogin = await attempt(() => portalLogin('frontdesk@teleemon.test', PASSWORD));
  const staffMe = staffLogin.ok ? await http('GET', 'me', undefined, staffLogin.value?.getAccessToken()) : undefined;
  report(!staffLogin.ok || staffMe?.status === 403, 'A staff sign-in is refused by the portal service');

  // Expired hold release.
  const past = new Date(Date.now() - 60000).toISOString();
  const expiring = track(await service.createResource(base({ status: 'pending', start: holdTime?.start, end: new Date(Date.parse(holdTime?.start ?? '') + 3600000).toISOString(), extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.bookingChannel, valueCode: 'online' }, { url: EXT.holdExpires, valueDateTime: past }] })));
  await releaseHolds(service);
  report((await admin.readResource('Appointment', expiring.id as string, { cache: 'no-cache' })).status === 'cancelled', 'An unconfirmed hold is released after it expires');

  // ---------------------------------------------------------------- Compartment policy, direct API
  console.log('Patient policy (direct Medplum API, bypassing the portal)');
  const other = track(await admin.createResource<Patient>({ resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: `verify-phase7-${RUN}-other` }], name: [{ given: ['Other'], family: `Stranger${LETTERS}` }], birthDate: yearsAgo(40) }));
  patients.push(other);
  report((await attempt(() => patientClient.readResource('Patient', newPatient?.id as string))).ok, 'The patient reads their own record');
  report(!(await attempt(() => patientClient.readResource('Patient', other.id as string))).ok, "The patient cannot read another patient's record");
  report((await patientClient.searchResources('Patient', { _count: '50' })).length === 1, 'A patient search returns only their own record');
  await admin.updateResource({ ...(confirmed as Appointment), extension: [...(confirmed?.extension ?? []), { url: EXT.telehealthUrl, valueUrl: 'https://meet.google.com/syn-thet-ic' }] });
  const seen = await patientClient.readResource('Appointment', held?.id as string, { cache: 'no-cache' });
  report(!seen.extension && !JSON.stringify(seen).includes('meet.google.com'), "The telehealth link is hidden from the patient's own reads");
  const selfBook = await attempt(() => patientClient.createResource({ ...base({}), participant: [{ actor: createReference(newPatient as Patient), status: 'accepted' }, { actor: createReference(prac), status: 'accepted' }] }));
  report(!selfBook.ok, 'Patients cannot write Appointments directly (only through the portal service)', selfBook.error);

  const me = await patientClient.readResource('Patient', newPatient?.id as string, { cache: 'no-cache' });
  const phoneEdit = await attempt(() => patientClient.updateResource<Patient>({ ...me, telecom: [...(me.telecom ?? []).filter((t) => t.system !== 'phone'), { system: 'phone', value: '206-555-0199', use: 'mobile' }] }));
  report(phoneEdit.ok, 'The patient can change their own phone number', phoneEdit.error);
  const fresh = await patientClient.readResource('Patient', newPatient?.id as string, { cache: 'no-cache' });
  const dob = await attempt(() => patientClient.updateResource<Patient>({ ...fresh, birthDate: '1990-01-01' }));
  report(!dob.ok && /care team/i.test(dob.error ?? ''), 'Changing their date of birth is refused by the server', dob.error);
  const override = await attempt(() => patientClient.updateResource<Patient>({ ...fresh, extension: [...(fresh.extension ?? []), { url: EXT.duplicateOverride, valueString: 'I am someone else entirely' }] }));
  report(!override.ok, 'Adding a duplicate override is refused');
  const fakeCard = await attempt(() => patientClient.updateResource<Patient>({ ...fresh, extension: [...(fresh.extension ?? []), { url: EXT.cardOnFile, valueString: '{"provider":"stripe"}' }] }));
  report(!fakeCard.ok, 'Writing a card on file directly is refused (portal service only)');

  const enc = await admin.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', subject: createReference(newPatient as Patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'after-visit-summary' }] }], description: 'Synthetic after-visit summary', content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('Synthetic AVS').toString('base64'), title: 'avs.txt' } }] });
  const letter = await admin.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', subject: createReference(newPatient as Patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'outside-records' }] }], description: 'Synthetic outside records', content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('x').toString('base64') } }] });
  const docs = await patientClient.searchResources('DocumentReference', { patient: getReferenceString(newPatient as Patient) }, { cache: 'no-cache' });
  report(docs.length === 1 && docs[0].id === enc.id, 'The patient sees released after-visit summaries and no other documents');
  report(!(await attempt(() => patientClient.readResource('DocumentReference', letter.id as string))).ok, 'Reading an unreleased document directly is refused');
  report(!(await attempt(() => patientClient.searchResources('Condition', { subject: getReferenceString(newPatient as Patient) }))).ok, 'Problem list and other clinical data are not readable from the portal');
  report(!(await attempt(() => patientClient.createResource<Consent>({ resourceType: 'Consent', status: 'active', scope: { coding: [{ code: 'treatment' }] }, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: 'treatment' }] }], patient: createReference(newPatient as Patient) }))).ok, 'Consents cannot be written directly (e-signature through the service only)');

  // Messages.
  const msg = (text: string, over: Partial<Communication> = {}): Communication => ({ resourceType: 'Communication', status: 'in-progress', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_MESSAGE }] }], subject: createReference(newPatient as Patient), sender: createReference(newPatient as Patient), payload: [{ contentString: text }], ...over });
  const sent = await attempt(() => patientClient.createResource(msg('Synthetic question about my appointment time.')));
  report(sent.ok && sent.value?.priority === 'routine', 'The patient sends a portal message', sent.error);
  const crisis = await attempt(() => patientClient.createResource(msg('Synthetic test: I have been thinking about suicide.')));
  report(crisis.ok && crisis.value?.priority === 'urgent', 'A message with possible crisis language is marked urgent by the server');
  const spoof = await attempt(() => patientClient.createResource(msg('Spoofed sender', { sender: createReference(prac) })));
  report(!spoof.ok, 'A message under someone else\'s name is refused');
  const aboutOther = await attempt(() => patientClient.createResource(msg('About someone else', { subject: createReference(other) })));
  report(!aboutOther.ok, "A message about another patient is refused");
  const edit = sent.value ? await attempt(() => patientClient.updateResource({ ...(sent.value as Communication), payload: [{ contentString: 'edited' }] })) : { ok: true };
  report(!edit.ok, 'A sent message cannot be edited');
  const queue = await frontdesk.searchResources('Communication', { ...QUEUES.messages.params(), _count: '1000' }, { cache: 'no-cache' });
  report(queue.some((c) => c.id === sent.value?.id), 'Portal messages land in the staff inbox queue');
  const replyText = `Synthetic reply ${RUN}`;
  const reply = await attempt(() => provider.createResource<Communication>({ resourceType: 'Communication', status: 'completed', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_REPLY }] }], subject: createReference(newPatient as Patient), sender: createReference(prac), inResponseTo: sent.value ? [createReference(sent.value)] : undefined, sent: new Date().toISOString(), payload: [{ contentString: replyText }] }));
  report(reply.ok, 'Staff reply in the portal under their own name', reply.error);
  const before = emails(email);
  await notifyReplies(service);
  const notified = await admin.readResource('Communication', reply.value?.id as string, { cache: 'no-cache' });
  report(emails(email) === before + 1 && !!notified.extension?.some((e) => e.url === EXT.notifiedAt) && !readFileSync(OUTBOX, 'utf8').includes(replyText), 'The patient is emailed that a reply is waiting, without its content, once');
  await notifyReplies(service);
  report(emails(email) === before + 1, 'No second notice for the same reply');
  const thread = await patientClient.searchResources('Communication', { subject: getReferenceString(newPatient as Patient) }, { cache: 'no-cache' });
  report(thread.some((c) => c.id === reply.value?.id), 'The patient reads the reply');
  const tamper = await attempt(() => frontdesk.updateResource({ ...notified, payload: [{ contentString: 'rewritten' }] }));
  report(!tamper.ok, 'A sent reply cannot be rewritten');

  // Intake answers and insurance.
  const intake = await attempt(() => patientClient.createResource<QuestionnaireResponse>({ resourceType: 'QuestionnaireResponse', questionnaire: INTAKE_QUESTIONNAIRE_URL, status: 'in-progress', subject: createReference(newPatient as Patient), item: [{ linkId: 'reason', answer: [{ valueString: 'Synthetic' }] }] }));
  const resumed = intake.value ? await attempt(() => patientClient.updateResource<QuestionnaireResponse>({ ...(intake.value as QuestionnaireResponse), item: [{ linkId: 'reason', answer: [{ valueString: 'Synthetic, resumed' }] }] })) : { ok: false, value: undefined };
  report(intake.ok && resumed.ok, 'Intake answers save and resume (in progress)');
  const submitted = resumed.value ? await patientClient.updateResource<QuestionnaireResponse>({ ...resumed.value, status: 'completed' }) : undefined;
  const locked = submitted ? await attempt(() => patientClient.updateResource<QuestionnaireResponse>({ ...submitted, item: [] })) : { ok: true };
  report(!!submitted && !locked.ok, 'Submitted intake answers are locked');
  const draftCov = await attempt(() => patientClient.createResource({ resourceType: 'Coverage', status: 'draft', beneficiary: createReference(newPatient as Patient), payor: [{ display: 'Synthetic Health Plan' }], subscriberId: 'SYN123' }));
  const activeCov = await attempt(() => patientClient.createResource({ resourceType: 'Coverage', status: 'active', beneficiary: createReference(newPatient as Patient), payor: [{ display: 'Synthetic Health Plan' }] }));
  report(draftCov.ok && !activeCov.ok, 'Patients enter insurance as a draft; only staff can make it active');
  const phq = MEASURES.phq9;
  const positive = await attempt(() => patientClient.createResource({ resourceType: 'QuestionnaireResponse', questionnaire: questionnaireUrl('phq9'), status: 'completed', subject: createReference(newPatient as Patient), authored: new Date().toISOString(), item: phq.items.map((i) => ({ linkId: i.linkId, answer: [{ valueCoding: { code: i.linkId === 'phq9-9' ? '1' : '0' } }] })) }));
  const safetyTask = await eventually(() => admin.searchOne('Task', { patient: getReferenceString(newPatient as Patient), code: `${CODE_SYSTEMS.taskCode}|safety-review` }, { cache: 'no-cache' }));
  report(positive.ok && safetyTask?.priority === 'stat', 'A positive safety answer from the portal creates the same stat review task as in clinic', positive.error);

  // Refill requests.
  const refill = (medication: string, over: Partial<Task> = {}): Task => ({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'rx-renewal' }] }, for: createReference(newPatient as Patient), requester: createReference(newPatient as Patient), owner: createReference(prac), input: [{ type: { text: 'medication' }, valueString: medication }], ...over });
  const asked = await attempt(() => patientClient.createResource(refill('Sertraline 50 mg', { restriction: { period: { end: '2099-01-01T00:00:00Z' } }, priority: 'stat' })));
  report(asked.ok && asked.value?.priority === 'routine' && (asked.value?.restriction?.period?.end ?? '') < '2099', 'A portal refill request gets the server SLA and priority, not the patient\'s', asked.error);
  report(!(await attempt(() => patientClient.createResource(refill('Sertraline 50 mg')))).ok, 'A second open request for the same medication is refused');
  report(!(await attempt(() => patientClient.createResource(refill('Bupropion', { for: createReference(other) })))).ok, "A request for another patient's medication is refused");
  report(!(await attempt(() => patientClient.createResource(refill('x', { code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'general' }] } })))).ok, 'Patients cannot create other kinds of task');
  const refills = await frontdesk.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|rx-renewal`, patient: getReferenceString(newPatient as Patient) }, { cache: 'no-cache' });
  report(refills.some((t) => t.id === asked.value?.id), 'Portal refill requests appear in the staff refill queue (P26)');

  // ---------------------------------------------------------------- Portal service (signed in)
  console.log('Portal service: booking, check-in, join, consents, payment');
  const meRes = await http('GET', 'me', undefined, pt);
  report(meRes.status === 200 && meRes.json.access === 'self' && (meRes.json.visitTypes as unknown[]).length === 0, 'A new patient with an evaluation booked is offered no follow-ups yet');
  report((await http('GET', 'me')).status === 401, 'Signed-in routes need the patient\'s token');

  // An established patient (one fulfilled visit) invited by staff from the chart.
  const est = track(await admin.createResource<Patient>({ resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: `verify-phase7-${RUN}-est` }], name: [{ given: ['Established'], family: `Portal${LETTERS}` }], birthDate: yearsAgo(29), telecom: [{ system: 'email', value: `est.${RUN}@example.com` }, { system: 'phone', value: '206-555-0143' }], generalPractitioner: [createReference(prac)], address: [{ use: 'home', state: 'WA', city: 'Seattle' }] }));
  patients.push(est);
  const pastStart = new Date(Date.now() - 30 * 86400000).toISOString();
  track(await admin.createResource<Appointment>({ resourceType: 'Appointment', status: 'fulfilled', start: pastStart, end: new Date(Date.parse(pastStart) + 1800000).toISOString(), appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: 'med-mgmt' }] }, participant: [{ actor: createReference(est), status: 'accepted' }, { actor: createReference(prac), status: 'accepted' }], extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }] }));
  const inviteTask = track(await frontdesk.createResource<Task>({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }] }, for: createReference(est), focus: createReference(est), authoredOn: new Date().toISOString() }));
  report(!(await loadInbox(frontdesk)).some((r) => r.task?.id === inviteTask.id), 'Invitation requests do not clutter the staff inbox');
  await processInviteTasks(service, accounts);
  const doneTask = await admin.readResource('Task', inviteTask.id as string, { cache: 'no-cache' });
  report(doneTask.status === 'completed' && !!linkFor(`est.${RUN}@example.com`), 'A front-desk invitation request is sent by the portal service and completed');
  await http('POST', 'public/activate', { token: linkFor(`est.${RUN}@example.com`), password: PORTAL_PASSWORD });
  const estClient = await portalLogin(`est.${RUN}@example.com`, PORTAL_PASSWORD);
  const et = estClient.getAccessToken() as string;
  const estMe = await http('GET', 'me', undefined, et);
  report((estMe.json.visitTypes as { code: string }[]).some((v) => v.code === 'med-mgmt') && estMe.json.lastState === 'WA', 'An established patient is offered follow-ups, pre-filled with their last visit state');
  const free = await freeTimes(service, { channel: 'portal', state: 'WA', visitType: 'med-mgmt', days: 7 });
  const slot = free.flatMap((d) => d.times)[0];
  const outside = await http('POST', 'appointments', { visitType: 'med-mgmt', state: 'TX', start: slot?.start, practitionerId: slot?.practitionerId }, et);
  report(outside.status === 400 && outside.json.code === 'unlicensed-state', 'Signed-in booking while located in TX is refused');
  const evalAgain = await http('POST', 'appointments', { visitType: 'new-eval', state: 'WA', start: slot?.start, practitionerId: slot?.practitionerId }, et);
  report(evalAgain.status === 400, 'An established patient cannot book a new patient evaluation online');
  const fu = await http('POST', 'appointments', { visitType: 'med-mgmt', state: 'WA', start: slot?.start, practitionerId: slot?.practitionerId }, et);
  report(fu.status === 200 && !!fu.json.id, 'A returning patient books a follow-up in one request', JSON.stringify(fu.json));
  const fuAppt = fu.json.id ? await admin.readResource('Appointment', fu.json.id as string, { cache: 'no-cache' }) : undefined;
  report(fuAppt?.status === 'booked' && fuAppt.extension?.some((e) => e.url === EXT.bookingChannel && e.valueCode === 'portal') === true, 'The follow-up is booked with the portal channel recorded');
  const strangerCancel = await http('POST', `appointments/${fu.json.id}/cancel`, undefined, pt);
  report(strangerCancel.status === 404, "A patient cannot cancel someone else's visit");
  const cancelled = await http('POST', `appointments/${fu.json.id}/cancel`, undefined, et);
  report(cancelled.status === 200 && (await admin.readResource('Appointment', fu.json.id as string, { cache: 'no-cache' })).status === 'cancelled', 'The patient cancels their own visit');

  // A visit a full day ahead proves there is no 30-minute opening restriction.
  const nowStart = new Date(Date.now() + 24 * 60 * 60000).toISOString();
  const today = track(await admin.createResource<Appointment>({ resourceType: 'Appointment', status: 'booked', start: nowStart, end: new Date(Date.parse(nowStart) + 1800000).toISOString(), appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: 'med-mgmt' }] }, participant: [{ actor: createReference(est), status: 'accepted' }, { actor: createReference(prac), status: 'accepted' }], extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.overbookReason, valueString: 'Phase 7 verification visit' }, { url: EXT.telehealthUrl, valueUrl: 'https://meet.google.com/syn-now-visit' }] }));
  const earlyJoin = await http('GET', `appointments/${today.id}/join`, undefined, et);
  report(earlyJoin.status === 400 && earlyJoin.json.code === 'not-checked-in' && !JSON.stringify(earlyJoin.json).includes('meet.google'), 'Before check-in the join link is refused');
  const readyEarly = await http('GET', `appointments/${today.id}/status`, undefined, et);
  report(readyEarly.status === 200 && !(readyEarly.json.checkIn as { problem?: string } | undefined)?.problem, 'Check-in is available a full day before the scheduled appointment');
  const noConfirm = await http('POST', `appointments/${today.id}/check-in`, { state: 'WA' }, et);
  report(noConfirm.status === 400, 'Check-in needs the location confirmation');
  const txCheckIn = await http('POST', `appointments/${today.id}/check-in`, { state: 'TX', confirm: true }, et);
  report(txCheckIn.status === 400 && txCheckIn.json.code === 'unlicensed-location', 'Checking in from an unlicensed state is refused, and the visit stays unjoinable');
  const caCheckIn = await http('POST', `appointments/${today.id}/check-in`, { state: 'CA', confirm: true }, et);
  const checkedIn = await admin.readResource('Appointment', today.id as string, { cache: 'no-cache' });
  report(caCheckIn.status === 200 && checkedIn.status === 'arrived' && checkedIn.extension?.some((e) => e.url === EXT.patientLocationState && e.valueCode === 'CA') === true && checkedIn.extension.some((e) => e.url === EXT.locationConfirmed), 'Checking in from another licensed state records the confirmed location (CA)');
  const joined = await http('GET', `appointments/${today.id}/join`, undefined, et);
  report(joined.status === 200 && joined.json.url === 'https://meet.google.com/syn-now-visit', 'After check-in the join link is released');
  const othersJoin = await http('GET', `appointments/${today.id}/join`, undefined, pt);
  report(othersJoin.status === 404, "Another patient cannot get this visit's link");

  const doc = PORTAL_CONSENTS[0];
  const oldVersion = await http('POST', 'consents', { type: doc.type, version: 'treatment-2020-01', signature: 'Established Portal', agree: true }, et);
  report(oldVersion.status === 400 && oldVersion.json.code === 'consent-version', 'Signing an outdated consent version is refused');
  const unsigned = await http('POST', 'consents', { type: doc.type, version: doc.version, signature: '', agree: true }, et);
  report(unsigned.status === 400, 'A signature needs the typed name');
  const signed = await http('POST', 'consents', { type: doc.type, version: doc.version, signature: 'Established Portal', agree: true }, et);
  const consent = signed.json as unknown as Consent;
  report(signed.status === 200 && consent.extension?.some((e) => e.url === EXT.consentMethod && e.valueCode === 'portal-esignature') === true && consent.extension.some((e) => e.url === EXT.consentDocument && e.valueString === doc.version) && consent.extension.some((e) => e.url === EXT.consentTextHash && /^[0-9a-f]{64}$/.test(e.valueString ?? '')) && consent.performer?.[0]?.reference === `Patient/${est.id}`, 'An e-signature records the method, document version, text hash and signer');
  const twice = await http('POST', 'consents', { type: doc.type, version: doc.version, signature: 'Established Portal', agree: true }, et);
  report((twice.json as { id?: string }).id === consent.id, 'Signing again returns the existing consent');

  const decline = await http('POST', 'payment/confirm', { sandboxOutcome: 'decline' }, et);
  report(decline.status === 402, 'A declined test card is reported and not saved');
  const card = await http('POST', 'payment/confirm', { sandboxOutcome: 'success' }, et);
  const withCard = await admin.readResource('Patient', est.id as string, { cache: 'no-cache' });
  const stored = withCard.extension?.find((e) => e.url === EXT.cardOnFile)?.valueString ?? '';
  report(card.status === 200 && (card.json.card as { last4?: string })?.last4 === '4242' && !/\d{12,}/.test(stored), 'Card on file stores processor IDs, brand and last four only');

  // ---------------------------------------------------------------- Proxies (minors)
  console.log('Proxies: what a parent or guardian sees depends on the minor\'s age and state');
  const minorPatient = async (key: string, age: number): Promise<{ patient: Patient; guardian: RelatedPerson; email: string }> => {
    const patient = track(await admin.createResource<Patient>({
      resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: `verify-phase7-${RUN}-${key}` }], name: [{ given: [key === 'teen' ? 'Teen' : 'Child'], family: `Portal${LETTERS}` }], birthDate: yearsAgo(age), address: [{ use: 'home', state: 'WA', city: 'Kirkland' }],
      contact: [guardianContact({ given: 'Guardian', family: `Portal${LETTERS}`, relationship: 'Mother', phone: '425-555-0177', authority: true })],
    }));
    patients.push(patient);
    const gEmail = `guardian.${key}.${RUN}@example.com`;
    const guardian = track(await admin.createResource<RelatedPerson>({ resourceType: 'RelatedPerson', patient: createReference(patient), relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'GUARD', display: 'guardian' }] }], name: [{ given: ['Guardian'], family: `Portal${LETTERS}` }], telecom: [{ system: 'email', value: gEmail }] }));
    await admin.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', subject: createReference(patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'after-visit-summary' }] }], content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('AVS').toString('base64') } }] });
    track(await frontdesk.createResource<Task>({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }] }, for: createReference(patient), focus: createReference(guardian) }));
    return { patient, guardian, email: gEmail };
  };
  const teen = await minorPatient('teen', 15);
  const child = await minorPatient('child', 9);
  await processInviteTasks(service, accounts);
  for (const m of [teen, child]) await http('POST', 'public/activate', { token: linkFor(m.email), password: PORTAL_PASSWORD });
  const teenProxy = await portalLogin(teen.email, PORTAL_PASSWORD);
  const childProxy = await portalLogin(child.email, PORTAL_PASSWORD);
  report(teenProxy.getProfile()?.resourceType === 'RelatedPerson' && childProxy.getProfile()?.resourceType === 'RelatedPerson', 'Guardians sign in as their RelatedPerson profile');
  const teenMe = await http('GET', 'me', undefined, teenProxy.getAccessToken());
  const childMe = await http('GET', 'me', undefined, childProxy.getAccessToken());
  report(teenMe.json.access === 'limited' && childMe.json.access === 'full', 'A WA 15-year-old\'s guardian gets limited access; a 9-year-old\'s gets full access', `${teenMe.json.access}, ${childMe.json.access}`);
  report((await teenProxy.searchResources('Patient', {})).length === 1 && (await attempt(() => teenProxy.searchResources('Appointment', { patient: getReferenceString(teen.patient) }))).ok, 'The limited proxy sees the patient record and appointments');
  report(!(await attempt(() => teenProxy.searchResources('DocumentReference', { patient: getReferenceString(teen.patient) }))).ok, "The limited proxy cannot read the teen's visit summaries");
  report(!(await attempt(() => teenProxy.searchResources('Communication', { subject: getReferenceString(teen.patient) }))).ok && !(await attempt(() => teenProxy.createResource(msg('hi', { subject: createReference(teen.patient), sender: createReference(teen.guardian) })))).ok, 'The limited proxy cannot read or send messages');
  report(!(await attempt(() => teenProxy.searchResources('QuestionnaireResponse', { subject: getReferenceString(teen.patient) }))).ok && !(await attempt(() => teenProxy.searchResources('MedicationStatement', { subject: getReferenceString(teen.patient) }))).ok, 'The limited proxy cannot read answers, measures or medications');
  const limitedTreatment = await http('POST', 'consents', { type: 'treatment', version: PORTAL_CONSENTS[0].version, signature: 'Guardian Portal', agree: true }, teenProxy.getAccessToken());
  const limitedFinancial = await http('POST', 'consents', { type: 'financial', version: PORTAL_CONSENTS.find((d) => d.type === 'financial')?.version, signature: 'Guardian Portal', agree: true }, teenProxy.getAccessToken());
  report(limitedTreatment.status === 403 && limitedFinancial.status === 200, 'The limited proxy may sign the financial policy but not the teen\'s treatment consent');
  const childDocs = await childProxy.searchResources('DocumentReference', { patient: getReferenceString(child.patient) }, { cache: 'no-cache' });
  report(childDocs.length === 1, "The full proxy reads the young child's visit summaries");
  const childMsg = await attempt(() => childProxy.createResource(msg('Synthetic parent question', { subject: createReference(child.patient), sender: createReference(child.guardian) })));
  report(childMsg.ok, 'The full proxy can message the care team about the child', childMsg.error);
  report(!(await attempt(() => childProxy.readResource('Patient', teen.patient.id as string))).ok, 'A proxy cannot read a patient they are not linked to');
  // The child turns 14: the next review moves the guardian to limited access.
  await admin.updateResource({ ...(await admin.readResource('Patient', child.patient.id as string)), birthDate: yearsAgo(14) });
  const reviewed = await reviewProxies(accounts, projectId);
  const childAgain = await portalLogin(child.email, PORTAL_PASSWORD);
  report(reviewed.changed >= 1 && !(await attempt(() => childAgain.searchResources('DocumentReference', { patient: getReferenceString(child.patient) }))).ok, 'When the child reaches the state age, the guardian is moved to limited access', JSON.stringify(reviewed));

  // ---------------------------------------------------------------- Onboarding (PATIENT-ONBOARDING-PLAN.md)
  console.log('Onboarding: minors, sex at birth, card photos, verification, reminders, estimates');
  const minorInvite = await attempt(() => frontdesk.createResource<Task>({ resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }] }, for: createReference(teen.patient), focus: createReference(teen.patient) }));
  report(!minorInvite.ok && /under 18/.test(minorInvite.error ?? ''), "Direct API: a portal invitation for a minor's own record is refused", minorInvite.error);
  const { token: minorToken } = await createInvitation(service, await admin.readResource('Patient', teen.patient.id as string));
  const minorActivate = await http('POST', 'public/activate', { token: minorToken, password: PORTAL_PASSWORD });
  report(minorActivate.status === 403, 'An older link to a minor\'s own record cannot create a sign-in');

  const reviewId = onboardingReviewIdentifier(newPatient?.id as string);
  const obReview = await eventually(() => admin.searchOne('Task', { identifier: `${reviewId.system}|${reviewId.value}` }, { cache: 'no-cache' }));
  report(obReview?.status === 'requested' && obReview.performerType?.[0]?.coding?.[0]?.code === 'frontdesk', 'Submitting the intake opened one front-desk review task');
  const early = obReview ? await attempt(() => frontdesk.updateResource<Task>({ ...obReview, status: 'completed' })) : { ok: true, error: '' };
  report(!early.ok && /Sex assigned at birth/.test(early.error ?? '') && /Card on file/.test(early.error ?? ''), 'Marking the patient verified with items missing is refused, naming them', early.error);

  const obBefore = await patientClient.readResource('Patient', newPatient?.id as string, { cache: 'no-cache' });
  const obCompleted = await attempt(() => patientClient.updateResource<Patient>({
    ...obBefore, gender: 'female',
    extension: [...(obBefore.extension ?? []).filter((e) => e.url !== EXT.selfPay), { url: EXT.sexAssignedAtBirth, valueCode: 'female' }, { url: EXT.selfPay, valueBoolean: true }],
    address: [{ use: 'home', line: ['1 Synthetic Way'], city: 'Seattle', state: 'WA', postalCode: '98101' }],
    contact: [{ relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'C' }], text: 'Partner' }], name: { given: ['Synthetic'], family: 'Contact' }, telecom: [{ system: 'phone', value: '206-555-0188' }] }],
  }));
  report(obCompleted.ok, 'The patient records sex at birth, address, emergency contact and self-pay', obCompleted.error);
  const resex = obCompleted.value ? await attempt(() => patientClient.updateResource<Patient>({ ...(obCompleted.value as Patient), gender: 'male', extension: (obCompleted.value as Patient).extension?.map((e) => (e.url === EXT.sexAssignedAtBirth ? { ...e, valueCode: 'male' } : e)) })) : { ok: true, error: '' };
  report(!resex.ok && /care team/.test(resex.error ?? ''), 'Changing sex at birth afterwards is refused (staff correct it)', resex.error);

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const cardDoc = await attempt(async () => {
    const doc = await patientClient.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: createReference(newPatient as Patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'id-insurance' }] }], description: 'Insurance card (front)', content: [{ attachment: { contentType: 'image/png', title: 'Insurance card (front)' } }] });
    const attachment = await patientClient.createAttachment({ data: png, contentType: 'image/png', filename: 'front.png', securityContext: createReference(doc) });
    return patientClient.updateResource<DocumentReference>({ ...doc, content: [{ attachment: { ...attachment, size: png.length } }] });
  });
  report(cardDoc.ok && !!cardDoc.value?.content?.[0]?.attachment?.url, 'The patient uploads an insurance card photo to their own record', cardDoc.error);
  const finalCard = await attempt(() => patientClient.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', docStatus: 'final', subject: createReference(newPatient as Patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'id-insurance' }] }], content: [{ attachment: { contentType: 'image/png' } }] }));
  const otherCategory = await attempt(() => patientClient.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: createReference(newPatient as Patient), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'outside-records' }] }], content: [{ attachment: { contentType: 'application/pdf' } }] }));
  const otherPatient = await attempt(() => patientClient.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: createReference(other), category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'id-insurance' }] }], content: [{ attachment: { contentType: 'image/png' } }] }));
  report(!finalCard.ok && !otherCategory.ok && !otherPatient.ok, 'Uploads marked checked, other document types, and uploads to another record are refused');
  if (cardDoc.value) {
    const checked = await frontdesk.updateResource<DocumentReference>({ ...(await frontdesk.readResource('DocumentReference', cardDoc.value.id as string)), docStatus: 'final' });
    const tamper = await attempt(() => patientClient.updateResource<DocumentReference>({ ...checked, description: 'changed' }));
    report(!tamper.ok, 'Once staff mark a card checked, the patient can no longer change it');
  }

  const estBefore = await http('GET', 'estimate', undefined, pt);
  const gfe = estBefore.json.estimate as { appointmentId?: string; amount?: number } | undefined;
  report(estBefore.json.needed === true && gfe?.amount === 350 && gfe.appointmentId === held?.id, 'A self-pay patient sees the good-faith estimate for their next visit ($350 evaluation)');
  const ack = await http('POST', 'estimate/acknowledge', { appointmentId: gfe?.appointmentId, signature: 'Synthetic Portal', agree: true }, pt);
  const ackConsent = ack.json as unknown as Consent;
  report(ack.status === 200 && ackConsent.provision?.data?.[0]?.reference.reference === `Appointment/${held?.id}` && ackConsent.extension?.some((e) => e.url === EXT.consentTextHash) === true, 'Acknowledging records the exact estimate text, its hash and the visit');
  report((await http('GET', 'estimate', undefined, pt)).json.needed === false, 'The estimate is not asked for again for that visit');

  await http('POST', 'payment/confirm', { sandboxOutcome: 'success' }, pt);
  for (const doc of PORTAL_CONSENTS.filter((d) => !d.onlyWhenControlled)) await http('POST', 'consents', { type: doc.type, version: doc.version, signature: 'Synthetic Portal', agree: true }, pt);
  const obFresh = obReview ? await frontdesk.readResource('Task', obReview.id as string) : undefined;
  const obVerified = obFresh ? await attempt(() => frontdesk.updateResource<Task>({ ...obFresh, status: 'completed' })) : { ok: false, error: 'no obReview task' };
  report(obVerified.ok, 'With the record complete, the front desk marks the patient verified', obVerified.error);

  // A new patient with a visit tomorrow and no forms gets one reminder.
  const rem = track(await admin.createResource<Patient>({ resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: `verify-phase7-${RUN}-rem` }], name: [{ given: ['Reminder'], family: `Portal${LETTERS}` }], birthDate: yearsAgo(41), telecom: [{ system: 'email', value: `rem.${RUN}@example.com` }] }));
  patients.push(rem);
  const tomorrow = new Date(Math.ceil((Date.now() + 20 * 3600000) / 900000) * 900000).toISOString();
  const remAppt = track(await admin.createResource<Appointment>({ resourceType: 'Appointment', status: 'booked', start: tomorrow, end: new Date(Date.parse(tomorrow) + 3600000).toISOString(), appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: 'new-eval' }] }, participant: [{ actor: createReference(rem), status: 'accepted' }, { actor: createReference(prac), status: 'accepted' }], extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.overbookReason, valueString: 'Phase 7 reminder check' }] }));
  const remBefore = emails(`rem.${RUN}@example.com`);
  await remindIncompleteIntake(service);
  await remindIncompleteIntake(service);
  const reminded = await admin.readResource('Appointment', remAppt.id as string, { cache: 'no-cache' });
  report(emails(`rem.${RUN}@example.com`) === remBefore + 1 && !!reminded.extension?.some((e) => e.url === EXT.intakeReminderSent), 'A new patient with a visit within a day and no forms gets one reminder (no clinical detail)');
}

async function cleanup(admin: MedplumClient, projectId: string): Promise<number> {
  let n = 0;
  const del = async (type: ResourceType, id: string | undefined): Promise<void> => { if (id && (await attempt(() => admin.deleteResource(type, id))).ok) n++; };
  for (const p of patients) {
    const ref = `Patient/${p.id}`;
    for (const [type, param] of [['Task', 'patient'], ['Communication', 'subject'], ['DocumentReference', 'subject'], ['QuestionnaireResponse', 'subject'], ['Observation', 'subject'], ['Flag', 'subject'], ['Consent', 'patient'], ['Coverage', 'beneficiary'], ['Appointment', 'patient']] as const) {
      for (const r of await admin.searchResources(type, { [param]: ref, _count: '200' }, { cache: 'no-cache' }).catch(() => [] as Resource[])) await del(type, r.id);
    }
    const profiles = [ref, ...(await admin.searchResources('RelatedPerson', { patient: ref }, { cache: 'no-cache' })).map((r) => `RelatedPerson/${r.id}`)];
    for (const profile of profiles) {
      for (const b of await admin.searchResources('Basic', { subject: profile, _count: '50' }, { cache: 'no-cache' })) await del('Basic', b.id);
      for (const t of await admin.searchResources('Task', { focus: profile, _count: '50' }, { cache: 'no-cache' })) await del('Task', t.id);
      const memberships = await admin.searchResources('ProjectMembership', { profile }, { cache: 'no-cache' }).catch(() => [] as ProjectMembership[]);
      for (const m of memberships) {
        if ((await attempt(() => admin.delete(`admin/projects/${projectId}/members/${m.id}`))).ok) n++;
        if (m.user?.reference?.startsWith('User/')) await del('User', m.user.reference.split('/')[1]);
      }
    }
  }
  for (const r of [...created].reverse()) await del(r.resourceType, r.id);
  for (const p of patients) await del('Patient', p.id);
  return n;
}

main().catch((err: unknown) => {
  console.error(normalizeErrorString(err));
  process.exit(1);
});
