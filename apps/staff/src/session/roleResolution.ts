import type { ProjectMembership } from '@medplum/fhirtypes';
import type { Role } from '../navigation';

export interface RoleSession {
  readonly membership?: Partial<ProjectMembership>;
  readonly accessPolicy?: { readonly basedOn?: readonly { readonly display?: string }[] };
}

const POLICY_ROLES: Readonly<Record<string, Role>> = {
  'Teleemon Provider': 'provider',
  'Teleemon Front desk': 'frontdesk',
  'Teleemon Biller': 'biller',
};

/** Match the effective policies from auth/me, exactly as the ledger service does. */
export function rolesFromSession(session: RoleSession | undefined): Role[] {
  if (session?.membership?.admin) return ['admin'];
  return [...new Set((session?.accessPolicy?.basedOn ?? []).flatMap((policy) => {
    const role = policy.display ? POLICY_ROLES[policy.display] : undefined;
    return role ? [role] : [];
  }))];
}
