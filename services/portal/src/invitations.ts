// Portal invitations and accounts (X02, X09; SYSTEM-DESIGN.md §9 "Links and tokens", ADR-012).
//
// - Links are single-use and expire after 72 hours. Only the SHA-256 of the token is stored (on a
//   Basic resource), so a database reader cannot use a link.
// - Staff invite a patient or proxy with a Task (code portal-invite); public booking issues one
//   automatically. Opening the link sets a password and creates the sign-in for that profile.
// - A proxy's sign-in is parameterized to their patient and placed on the full or limited proxy
//   policy from the patient's age and state; reviewProxies keeps that current as minors age.

import type { MedplumClient } from '@medplum/core';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { AccessPolicy, Appointment, Basic, BundleEntry, Patient, ProjectMembership, Reference, RelatedPerson, Task } from '@medplum/fhirtypes';
import type { ProxyLevel } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, PORTAL_INVITATION_SYSTEM, PORTAL_RULES, formatVisitTime, patientInviteProblem, proxyLevel } from '@teleemon/core';
import { createHash, randomBytes } from 'node:crypto';
import { HttpError, badRequest } from './http';
import { emailOf, portalBaseUrl, sendEmail } from './mail';

export const POLICY = { patient: 'Teleemon Patient', proxy: 'Teleemon Proxy', proxyLimited: 'Teleemon Proxy (limited)' } as const;

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const INVITATION_CODE = { coding: [{ system: CODE_SYSTEMS.portal, code: 'invitation', display: 'Portal invitation' }] };

type Profile = Patient | RelatedPerson;

export async function createInvitation(service: MedplumClient, subject: Profile, opts: { appointment?: Appointment; requestedBy?: Basic['author']; now?: Date } = {}): Promise<{ token: string; invitation: Basic }> {
  const now = opts.now ?? new Date();
  // A new link replaces any earlier unused one.
  for (const old of await service.searchResources('Basic', { code: `${CODE_SYSTEMS.portal}|invitation`, subject: getReferenceString(subject), _count: '20' }, { cache: 'no-cache' })) {
    if (!ext(old, EXT.inviteUsed) && Date.parse(ext(old, EXT.inviteExpires) ?? '') > now.getTime()) {
      await service.updateResource<Basic>({ ...old, extension: [...(old.extension ?? []).filter((e) => e.url !== EXT.inviteExpires), { url: EXT.inviteExpires, valueDateTime: now.toISOString() }] });
    }
  }
  const token = randomBytes(32).toString('base64url');
  const invitation = await service.createResource<Basic>({
    resourceType: 'Basic',
    code: INVITATION_CODE,
    identifier: [{ system: PORTAL_INVITATION_SYSTEM, value: hashToken(token) }],
    subject: createReference(subject),
    created: now.toISOString().slice(0, 10),
    author: opts.requestedBy,
    extension: [
      { url: EXT.inviteExpires, valueDateTime: new Date(now.getTime() + PORTAL_RULES.inviteHours * 3600000).toISOString() },
      ...(opts.appointment ? [{ url: EXT.inviteAppointment, valueReference: createReference(opts.appointment) }] : []),
    ],
  });
  return { token, invitation };
}

export const activationLink = (token: string): string => `${portalBaseUrl()}activate?token=${encodeURIComponent(token)}`;

const ext = (r: { extension?: { url: string; valueDateTime?: string }[] }, url: string): string | undefined => r.extension?.find((e) => e.url === url)?.valueDateTime;

export type InvitationState = 'valid' | 'expired' | 'used';

export async function findInvitation(service: MedplumClient, token: string, now = new Date()): Promise<{ invitation: Basic; state: InvitationState }> {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) throw badRequest('This link is not valid. Ask us to send a new one.', 'invalid-link');
  const invitation = await service.searchOne('Basic', { identifier: `${PORTAL_INVITATION_SYSTEM}|${hashToken(token)}` }, { cache: 'no-cache' });
  if (!invitation) throw badRequest('This link is not valid. Ask us to send a new one.', 'invalid-link');
  if (ext(invitation, EXT.inviteUsed)) return { invitation, state: 'used' };
  if (!(Date.parse(ext(invitation, EXT.inviteExpires) ?? '') > now.getTime())) return { invitation, state: 'expired' };
  return { invitation, state: 'valid' };
}

const maskEmail = (email: string): string => email.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.min(b.length, 6))}${c}`);

/** What the activation page shows: whose invitation it is (first name only) and the held visit, if any. */
export async function describeInvitation(service: MedplumClient, token: string): Promise<unknown> {
  const { invitation, state } = await findInvitation(service, token);
  if (state !== 'valid') return { state };
  const profile = (await service.readReference(invitation.subject as Reference<Profile>)) as Profile;
  const email = emailOf(profile);
  const apptRef = invitation.extension?.find((e) => e.url === EXT.inviteAppointment)?.valueReference;
  const appt = apptRef ? await service.readReference(apptRef as Reference<Appointment>).catch(() => undefined) : undefined;
  return {
    state,
    kind: profile.resourceType === 'Patient' ? 'patient' : 'proxy',
    firstName: profile.name?.[0]?.given?.[0] ?? '',
    email: email ? maskEmail(email) : undefined,
    appointment: appt ? { start: appt.start, status: appt.status, visit: appt.appointmentType?.text } : undefined,
  };
}

export interface ActivationResult {
  readonly email: string;
  /** The email already had a portal sign-in: the patient signs in with their existing password. */
  readonly existingLogin: boolean;
  readonly appointment?: 'confirmed' | 'expired';
}

export async function activate(service: MedplumClient, accounts: MedplumClient, projectId: string, token: string, password: string, now = new Date()): Promise<ActivationResult> {
  if (typeof password !== 'string' || password.length < PORTAL_RULES.minPasswordLength || password.length > 128) {
    throw badRequest(`Choose a password of at least ${PORTAL_RULES.minPasswordLength} characters.`);
  }
  const { invitation, state } = await findInvitation(service, token, now);
  if (state !== 'valid') throw badRequest(state === 'used' ? 'This link was already used. Sign in instead.' : 'This link has expired. Ask us to send a new one.', `link-${state}`);
  const profile = (await service.readReference(invitation.subject as Reference<Profile>)) as Profile;
  if (profile.resourceType === 'Patient' && patientInviteProblem(profile, now)) throw new HttpError(403, "Patients under 18 use a parent's or guardian's portal access. Please call us.");
  const email = emailOf(profile);
  if (!email) throw badRequest('We need your email address on file first. Please call us.');
  const membership = await membershipFor(accounts, profile, now);

  let existingLogin = false;
  const existing = await accounts.searchOne('ProjectMembership', { profile: getReferenceString(profile) }, { cache: 'no-cache' });
  existingLogin = !!existing;
  if (!existing) {
    const request = {
      resourceType: profile.resourceType,
      firstName: profile.name?.[0]?.given?.[0] ?? 'Patient',
      lastName: profile.name?.[0]?.family ?? 'Patient',
      email,
      password,
      sendEmail: false,
      scope: 'project',
      // A parent with several children chooses between profiles at sign-in by this label.
      membership: { ...membership, profile: { ...createReference(profile), display: await profileLabel(service, profile) }, admin: false },
    };
    try {
      await accounts.post(`admin/projects/${projectId}/invite`, request);
    } catch (err) {
      // The same email already signs in to the portal (for example a parent who is also a patient):
      // add this profile to that sign-in; their existing password stays.
      if (!/already a member/i.test(normalizeErrorString(err))) throw err;
      await accounts.post(`admin/projects/${projectId}/invite`, { ...request, forceNewMembership: true });
      existingLogin = true;
    }
  }

  const apptRef = invitation.extension?.find((e) => e.url === EXT.inviteAppointment)?.valueReference;
  const entries: BundleEntry[] = [{ resource: { ...invitation, extension: [...(invitation.extension ?? []), { url: EXT.inviteUsed, valueDateTime: now.toISOString() }] }, request: { method: 'PUT', url: `Basic/${invitation.id}`, ifMatch: `W/"${invitation.meta?.versionId}"` } }];
  let appointment: ActivationResult['appointment'];
  if (apptRef) {
    const appt = await service.readResource('Appointment', apptRef.reference!.split('/')[1], { cache: 'no-cache' });
    const expires = Date.parse(appt.extension?.find((e) => e.url === EXT.holdExpires)?.valueDateTime ?? '');
    appointment = appt.status === 'booked' ? 'confirmed' : 'expired';
    if (appt.status === 'pending' && expires > now.getTime()) {
      appointment = 'confirmed';
      entries.push({ resource: { ...appt, status: 'booked', extension: appt.extension?.filter((e) => e.url !== EXT.holdExpires) }, request: { method: 'PUT', url: `Appointment/${appt.id}`, ifMatch: `W/"${appt.meta?.versionId}"` } });
    }
  }
  // Consuming the link and confirming the hold succeed together. A failed confirmation must
  // leave a retryable link, even if the account was created by the preceding external API call.
  await service.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries });
  return { email, existingLogin, appointment };
}

const personName = (r: Profile): string => [r.name?.[0]?.given?.[0], r.name?.[0]?.family].filter(Boolean).join(' ');

async function profileLabel(service: MedplumClient, profile: Profile): Promise<string> {
  if (profile.resourceType === 'Patient') return personName(profile);
  const patient = await service.readReference(profile.patient as Reference<Patient>);
  return `${personName(profile)} for ${personName(patient)}`;
}

const policyCache = new Map<string, Reference<AccessPolicy>>();
async function policyRef(accounts: MedplumClient, name: string): Promise<Reference<AccessPolicy>> {
  const hit = policyCache.get(name);
  if (hit) return hit;
  const policy = await accounts.searchOne('AccessPolicy', { 'name:exact': name });
  if (!policy) throw new Error(`Access policy "${name}" not found. Run \`npm run setup -- --portal-only\`.`);
  const ref = { reference: getReferenceString(policy), display: name };
  policyCache.set(name, ref);
  return ref;
}

/** The membership fields that decide what this profile may see. */
async function membershipFor(accounts: MedplumClient, profile: Profile, now: Date): Promise<Partial<ProjectMembership>> {
  if (profile.resourceType === 'Patient') {
    // Patients under 18 use a guardian's proxy access until the teen sign-in age is decided.
    const problem = patientInviteProblem(profile, now);
    if (problem) throw new HttpError(403, "Patients under 18 use a parent's or guardian's portal access. Please call us.");
    return { accessPolicy: await policyRef(accounts, POLICY.patient) };
  }
  const patientRef = profile.patient?.reference;
  if (!patientRef?.startsWith('Patient/')) throw badRequest('This invitation is not linked to a patient. Please call us.');
  const patient = await accounts.readResource('Patient', patientRef.split('/')[1], { cache: 'no-cache' });
  const level = proxyLevel(patient, now).level;
  if (level === 'none') throw new HttpError(403, 'Proxy access is for parents and guardians of minors. Please call us.');
  return { access: [{ policy: await policyRef(accounts, level === 'full' ? POLICY.proxy : POLICY.proxyLimited), parameter: [{ name: 'patient', valueReference: { reference: patientRef } }] }] };
}

/** Staff requests (Task code portal-invite): issue the link, email it, and complete the Task. */
export async function processInviteTasks(service: MedplumClient, accounts: MedplumClient, now = new Date()): Promise<number> {
  const tasks = await service.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|portal-invite`, status: 'requested', _count: '50' }, { cache: 'no-cache' });
  let sent = 0;
  for (const task of tasks) {
    // Claim the request first, so two passes never send two links.
    let claimed: Task;
    try {
      claimed = await service.updateResource<Task>({ ...task, status: 'in-progress' }, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
    } catch {
      continue;
    }
    const finish = (status: 'completed' | 'failed', text: string): Promise<Task> =>
      service.updateResource<Task>({ ...claimed, status, ...(status === 'failed' ? { statusReason: { text } } : {}), businessStatus: { text }, lastModified: new Date().toISOString() });
    try {
      const profile = (await service.readReference(task.focus as Reference<Profile>)) as Profile;
      const email = emailOf(profile);
      if (!email) { await finish('failed', 'No valid email address on file for this person.'); continue; }
      if (profile.resourceType === 'Patient') {
        const problem = patientInviteProblem(profile, now);
        if (problem) { await finish('failed', problem); continue; }
      }
      if (profile.resourceType === 'RelatedPerson') {
        const patient = await service.readReference(profile.patient as Reference<Patient>);
        const level: ProxyLevel = proxyLevel(patient, now).level;
        if (level === 'none') { await finish('failed', 'Proxy portal access is for parents and guardians of patients under 18.'); continue; }
      }
      if (await accounts.searchOne('ProjectMembership', { profile: getReferenceString(profile) }, { cache: 'no-cache' })) {
        await finish('completed', 'Already has portal access; no new link was sent.');
        continue;
      }
      const requester = task.requester?.reference?.match(/^(Practitioner|PractitionerRole|Patient|RelatedPerson|Organization)\//) ? (task.requester as Basic['author']) : undefined;
      const { token } = await createInvitation(service, profile, { requestedBy: requester, now });
      const message = invitationEmail(profile, token);
      await sendEmail(email, message.subject, message.text);
      await finish('completed', `Invitation sent ${now.toISOString().slice(0, 10)}; link expires in ${PORTAL_RULES.inviteHours} hours.`);
      sent++;
    } catch (err) {
      await finish('failed', `Invitation could not be sent: ${normalizeErrorString(err).slice(0, 120)}`).catch(() => undefined);
    }
  }
  return sent;
}

/** Keeps each proxy on the policy their patient's age and state allow; ends access when the patient turns 18. */
export async function reviewProxies(accounts: MedplumClient, projectId: string, now = new Date()): Promise<{ changed: number; ended: number }> {
  const memberships = await accounts.searchResources('ProjectMembership', { 'profile-type': 'RelatedPerson', _count: '500' }, { cache: 'no-cache' });
  let changed = 0;
  let ended = 0;
  for (const m of memberships) {
    if (m.active === false || !m.profile?.reference?.startsWith('RelatedPerson/')) continue;
    const proxy = await accounts.readReference(m.profile as Reference<RelatedPerson>).catch(() => undefined);
    const patientRef = proxy?.patient?.reference;
    if (!proxy || !patientRef) continue;
    const patient = await accounts.readResource('Patient', patientRef.split('/')[1], { cache: 'no-cache' });
    const level = proxyLevel(patient, now).level;
    if (level === 'none' || proxy.active === false || patient.active === false) {
      await accounts.post(`admin/projects/${projectId}/members/${m.id}`, { ...m, active: false });
      ended++;
      continue;
    }
    const want = await policyRef(accounts, level === 'full' ? POLICY.proxy : POLICY.proxyLimited);
    const current = m.access?.[0];
    if (m.access?.length === 1 && current && current.policy?.reference === want.reference && current.parameter?.some((p) => p.name === 'patient' && p.valueReference?.reference === patientRef)) continue;
    await accounts.post(`admin/projects/${projectId}/members/${m.id}`, { ...m, accessPolicy: undefined, access: [{ policy: want, parameter: [{ name: 'patient', valueReference: { reference: patientRef } }] }] });
    changed++;
  }
  return { changed, ended };
}

export function invitationEmail(profile: Profile, token: string, appointment?: Appointment): { subject: string; text: string } {
  const first = profile.name?.[0]?.given?.[0] ?? '';
  if (appointment?.start) {
    return {
      subject: 'Confirm your Teleemon visit',
      text: `Hello ${first},\n\nWe are holding ${formatVisitTime(appointment.start)} for your new patient visit for ${PORTAL_RULES.holdMinutes} minutes. Confirm it and set up your portal sign-in here (single use):\n${activationLink(token)}\n\nIf you did not request this, ignore this email and the time will be released.`,
    };
  }
  return { subject: 'Your Teleemon patient portal invitation', text: `Hello ${first},\n\nSet up your Teleemon portal sign-in here (single use, valid ${PORTAL_RULES.inviteHours} hours):\n${activationLink(token)}` };
}

