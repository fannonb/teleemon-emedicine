// Synthetic portal sign-ins for the Phase 7 checklist (docs/verification/phase-7.md). Uses the same
// invitation and activation code as real invitations, so the accounts are configured exactly as a
// patient's or guardian's would be. Safe to re-run: existing sign-ins are left as they are.
//
//   npm run portal:demo
//
//   Maya Thornton (adult, established, WA)             maya.thornton@example.com
//   Emily Bennett, mother of Lucas (16, WA: limited)   emily.bennett@example.com
//   Password for both: TELEEMON_PORTAL_DEMO_PASSWORD, default Synthetic-portal-2026!

import { getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Patient, RelatedPerson } from '@medplum/fhirtypes';
import { SEED_IDENTIFIER_SYSTEM, proxyLevel } from '@teleemon/core';
import { activate, createInvitation } from '../services/portal/src/invitations';
import { connectPortalService } from '../services/portal/src/index';

const PASSWORD = process.env.TELEEMON_PORTAL_DEMO_PASSWORD ?? 'Synthetic-portal-2026!';

async function main(): Promise<void> {
  const { service, accounts, projectId } = await connectPortalService();
  const seeded = async <T extends Patient | RelatedPerson>(type: T['resourceType'], key: string): Promise<T> => {
    const r = await service.searchOne(type, { identifier: `${SEED_IDENTIFIER_SYSTEM}|${key}` });
    if (!r) throw new Error(`Seed record ${key} not found. Run \`npm run seed\` first.`);
    return r as T;
  };
  const maya = await seeded<Patient>('Patient', 'pt-01');
  const emily = await seeded<RelatedPerson>('RelatedPerson', 'rp-04-mother');
  const lucas = await service.readResource('Patient', emily.patient.reference?.split('/')[1] as string);

  for (const [profile, label] of [[maya, 'Maya Thornton (patient)'], [emily, `Emily Bennett (guardian of Lucas: ${proxyLevel(lucas).level} access)`]] as const) {
    if (await accounts.searchOne('ProjectMembership', { profile: getReferenceString(profile) }, { cache: 'no-cache' })) {
      console.log(`• ${label}: portal sign-in already exists`);
      continue;
    }
    const { token } = await createInvitation(service, profile);
    const result = await activate(service, accounts, projectId, token, PASSWORD);
    console.log(`✓ ${label}: ${result.email}${result.existingLogin ? ' (added to an existing sign-in; its password is unchanged)' : ''}`);
  }
  console.log(`\nSign in at http://localhost:3200/signin with the email above and the password ${PASSWORD}`);
}

main().catch((err: unknown) => {
  console.error(`✗ ${normalizeErrorString(err)}`);
  process.exit(1);
});
