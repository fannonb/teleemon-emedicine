// Who is calling: the portal app sends the patient's or proxy's own Medplum access token. The
// service asks Medplum who it belongs to, so it never trusts an identity the browser asserts.

import type { MedplumClient } from '@medplum/core';
import type { Patient, RelatedPerson } from '@medplum/fhirtypes';
import type { ProxyLevel } from '@teleemon/core';
import { proxyLevel } from '@teleemon/core';
import type { IncomingMessage } from 'node:http';
import { HttpError } from './http';

export interface PortalSession {
  /** Patient/… or RelatedPerson/… : the person signed in, recorded as the author of their actions. */
  readonly actor: string;
  readonly actorName: string;
  readonly patient: Patient;
  readonly patientRef: string;
  /** 'self' for the patient; a proxy's level is recomputed from the patient's age and state on every request. */
  readonly access: 'self' | ProxyLevel;
}

interface Me {
  readonly project?: { id?: string };
  readonly profile?: Patient | RelatedPerson | { resourceType: string; id?: string };
}

const CACHE_MS = 30000;
const cache = new Map<string, { at: number; me: Me }>();

export async function sessionFor(req: IncomingMessage, service: MedplumClient, projectId: string): Promise<PortalSession> {
  const header = String(req.headers.authorization ?? '');
  const token = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header)?.[1];
  if (!token) throw new HttpError(401, 'Please sign in again.');
  const me = await whoIs(token);
  if (me.project?.id !== projectId) throw new HttpError(403, 'This sign-in is not for the Teleemon portal.');
  const profile = me.profile;
  if (profile?.resourceType === 'Patient' && profile.id) {
    const patient = await service.readResource('Patient', profile.id, { cache: 'no-cache' });
    if (patient.active === false) throw new HttpError(403, 'Portal access for this record is closed. Please call us.');
    return { actor: `Patient/${patient.id}`, actorName: nameOf(patient), patient, patientRef: `Patient/${patient.id}`, access: 'self' };
  }
  if (profile?.resourceType === 'RelatedPerson' && profile.id) {
    const proxy = await service.readResource('RelatedPerson', profile.id, { cache: 'no-cache' });
    const ref = proxy.patient?.reference;
    if (proxy.active === false || !ref?.startsWith('Patient/')) throw new HttpError(403, 'Proxy access is closed. Please call us.');
    const patient = await service.readResource('Patient', ref.split('/')[1], { cache: 'no-cache' });
    const level = proxyLevel(patient).level;
    if (level === 'none' || patient.active === false) throw new HttpError(403, 'Proxy access is not available for this patient. Please call us.');
    return { actor: `RelatedPerson/${proxy.id}`, actorName: nameOf(proxy), patient, patientRef: ref, access: level };
  }
  throw new HttpError(403, 'Staff accounts use the staff app, not the patient portal.');
}

async function whoIs(token: string): Promise<Me> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.me;
  const res = await fetch(new URL('auth/me', process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/'), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Please sign in again.');
  if (!res.ok) throw new Error(`auth/me returned ${res.status}`);
  const me = (await res.json()) as Me;
  cache.set(token, { at: Date.now(), me });
  if (cache.size > 5000) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  return me;
}

export function nameOf(r: Patient | RelatedPerson): string {
  const n = r.name?.[0];
  return [n?.given?.[0], n?.family].filter(Boolean).join(' ') || 'Patient';
}

/** Clinical actions (intake, clinical consents) need the patient or a proxy with full access. */
export function requireClinicalAccess(s: PortalSession): void {
  if (s.access === 'limited') throw new HttpError(403, `Because of ${s.patient.name?.[0]?.given?.[0] ?? 'the patient'}'s age, this part of the portal is for them to use. You can still manage appointments and insurance.`);
}
