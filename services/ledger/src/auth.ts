// Who is calling the ledger. Staff send their Medplum access token; the service asks Medplum who
// they are and takes their role from the policies Medplum applied, matching the policy name exactly.
// Other Teleemon services (worker, portal) send the shared internal token instead.

import { MedplumClient } from '@medplum/core';
import type { ProjectMembership } from '@medplum/fhirtypes';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../portal/src/http';

export type LedgerRole = 'admin' | 'biller' | 'frontdesk' | 'provider';

/** Same names as scripts/config/platform.ts POLICY_NAMES. */
const POLICY_ROLES: Record<string, LedgerRole> = {
  'Teleemon Biller': 'biller',
  'Teleemon Front desk': 'frontdesk',
  'Teleemon Provider': 'provider',
};

export interface StaffCaller {
  readonly kind: 'staff';
  readonly medplum: MedplumClient;
  /** `Practitioner/<id>`, recorded as posted_by. */
  readonly actor: string;
  readonly roles: LedgerRole[];
}

export interface ServiceCaller {
  readonly kind: 'service';
  readonly actor: string;
}

/**
 * Roles from Medplum's own account of the session: `auth/me` returns the policies the server
 * applied (accessPolicy.basedOn) and the admin flag. The membership resource it returns does not
 * carry the policy reference, so it is not used for this.
 */
export function rolesOf(me: { membership?: ProjectMembership; accessPolicy?: { basedOn?: { display?: string }[] } }): LedgerRole[] {
  if (me.membership?.admin) return ['admin'];
  const names = (me.accessPolicy?.basedOn ?? []).map((b) => b.display).filter(Boolean) as string[];
  return [...new Set(names.map((n) => POLICY_ROLES[n]).filter(Boolean))];
}

export async function staffCaller(req: IncomingMessage): Promise<StaffCaller> {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new HttpError(401, 'Sign in to use billing.');
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/', cacheTime: 0 });
  medplum.setAccessToken(token);
  let me: { membership?: ProjectMembership; profile?: { resourceType?: string; id?: string }; accessPolicy?: { basedOn?: { display?: string }[] } };
  try {
    me = await medplum.get('auth/me', { cache: 'no-cache' });
  } catch {
    throw new HttpError(401, 'Your session has ended. Sign in again.');
  }
  const profile = me.membership?.profile?.reference ?? (me.profile ? `${me.profile.resourceType}/${me.profile.id}` : '');
  if (!profile.startsWith('Practitioner/')) throw new HttpError(403, 'Billing is for staff accounts only.');
  return { kind: 'staff', medplum, actor: profile, roles: rolesOf(me) };
}

/** Billing work (P19, P30–P37 financial reports): billers and providers (practice decision, 18 Oct 2026). Administrators always pass. */
export const BILLING_ROLES: readonly LedgerRole[] = ['biller', 'provider'];

export function requireRole(caller: StaffCaller, ...roles: LedgerRole[]): void {
  if (!caller.roles.some((r) => r === 'admin' || roles.includes(r))) throw new HttpError(403, 'Your role cannot do this.');
}

/** Staff may see a patient's account only when Medplum lets them read that patient. */
export async function requirePatientAccess(caller: StaffCaller, patientId: string): Promise<string> {
  try {
    await caller.medplum.readResource('Patient', patientId);
  } catch {
    throw new HttpError(404, 'Patient not found.');
  }
  return `Patient/${patientId}`;
}

export function serviceCaller(req: IncomingMessage): ServiceCaller {
  const expected = process.env.LEDGER_INTERNAL_TOKEN ?? '';
  const given = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (expected.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'Not authorized.');
  const service = String(req.headers['x-teleemon-service'] ?? 'service').replace(/[^a-z-]/g, '').slice(0, 40) || 'service';
  return { kind: 'service', actor: `service:${service}` };
}
