// Sets up (or brings up to date) the Teleemon Medplum project. Safe to re-run.
//
//   npm run setup              bootstrap once, then apply settings, access policies, Bots, subscriptions
//   npm run setup -- --mfa     also require MFA for every user in the project (P01, P43)
//   npm run setup -- --no-mfa  turn the project-wide MFA requirement off again
//   npm run setup -- --portal-only  Phase 7: portal policies, Bots and the portal service and app clients
//
// Bootstrap (first run only) signs in as the Medplum super admin and creates:
//   - the "Teleemon" project. Members of Medplum's Super Admin project bypass every AccessPolicy,
//     so practice users and data must never live there (ADR-013).
//   - the practice administrator user (TELEEMON_ADMIN_EMAIL / TELEEMON_ADMIN_PASSWORD)
//   - the "Teleemon scripts" service client (admin), saved to .env.local
// Later runs use only the service client, so they keep working once MFA is enforced.
//
// MFA recovery: a project admin can reset a user's factor with
// POST /admin/projects/{projectId}/members/{membershipId}/mfa/reset

import type { MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { AccessPolicy, Bot, ClientApplication, Project, ProjectMembership, ProjectSetting, Subscription } from '@medplum/fhirtypes';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBots } from '../bots/build.mjs';
import { ACCESS_POLICIES, BOTS, PRE_COMMIT_EXTENSION, WORKER_POLICY, SCRIBE_RETENTION_POLICY } from './config/platform';
import { PORTAL_ACCOUNTS_POLICY, PORTAL_CLIENT_NAME, PORTAL_POLICIES, PORTAL_SERVICE_POLICY } from './config/portal';
import { randomBytes } from 'node:crypto';
import { MEASURE_LIST, questionnaireUrl } from '@teleemon/core';
import type { Questionnaire } from '@medplum/fhirtypes';
import { ROOT, connect, connectAsPassword, loadEnv, writeEnvValues } from './lib/client';

const PROJECT_NAME = 'Teleemon';
const CLIENT_NAME = 'Teleemon scripts';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  loadEnv();

  if (args.has('--transactions-only')) {
    const medplum = await connect();
    await ensureTransactions(medplum, process.env.TELEEMON_PROJECT_ID as string);
    return;
  }

  // Narrow maintenance path: no bootstrap, user/client changes, role policies or auth settings.
  if (args.has('--bots-only')) {
    if (!process.env.TELEEMON_PROJECT_ID || !process.env.TELEEMON_CLIENT_ID || !process.env.TELEEMON_CLIENT_SECRET) {
      throw new Error('--bots-only requires the existing local practice project and service client. It never bootstraps accounts.');
    }
    const medplum = await connect();
    await applyBots(medplum, process.env.TELEEMON_PROJECT_ID);
    console.log('✓ Updated only Teleemon Bots, their least-privilege policies and subscriptions.');
    return;
  }

  if (!process.env.TELEEMON_PROJECT_ID || !process.env.TELEEMON_CLIENT_ID) {
    await bootstrap();
    loadEnv();
  }

  const medplum = await connect();
  const projectId = process.env.TELEEMON_PROJECT_ID as string;
  console.log(`✓ Signed in to project ${PROJECT_NAME} (${projectId}) with the service client`);

  if (args.has('--scribe-only')) {
    await applyAccessPolicies(medplum);
    await applyScribeRetentionClient(medplum, projectId);
    return;
  }
  if (args.has('--scribe-policies-only')) {
    await applyAccessPolicies(medplum);
    console.log('✓ Applied narrower Phase 4 private-note access policies; no service client created');
    return;
  }

  if (args.has('--portal-only')) {
    // Phase 7: patient and proxy policies, the portal Bots' rules, the portal service clients and app client.
    await applyAccessPolicies(medplum);
    await applyBots(medplum, projectId);
    await applyPortal(medplum, projectId);
    console.log('✓ Applied Phase 7 portal policies, Bots and clients. Restart `npm run portal` and the portal app.');
    return;
  }
  if (args.has('--inbox-only')) {
    // Phase 6: inbox, task, document and message rules, and the worker's fax access.
    await applyAccessPolicies(medplum);
    await applyBots(medplum, projectId);
    await applyWorkerClient(medplum, projectId);
    console.log('✓ Applied Phase 6 inbox, document and fax policies, Bots and worker access; sign out and back in');
    return;
  }
  if (args.has('--erx-only')) {
    // Phase 5: prescribing policies, the prescription/PDMP Bots and the worker's e-prescribing access.
    await applyAccessPolicies(medplum);
    await applyBots(medplum, projectId);
    await applyWorkerClient(medplum, projectId);
    console.log('✓ Applied Phase 5 e-prescribing policies, Bots and worker access; sign out and back in');
    return;
  }

  await applySettings(medplum, projectId, args);
  const policies = await applyAccessPolicies(medplum);
  await applyQuestionnaires(medplum);
  await applyBots(medplum, projectId);
  await applyWorkerClient(medplum, projectId);
  await applyScribeRetentionClient(medplum, projectId);
  await applyPortal(medplum, projectId);
  // Shared secret for service-to-ledger calls (worker charges and 835s, portal card payments).
  if (!process.env.LEDGER_INTERNAL_TOKEN) {
    writeEnvValues({ LEDGER_INTERNAL_TOKEN: randomBytes(32).toString('hex') });
    console.log('✓ Ledger internal token created');
  }

  // The staff app signs users into the practice project only.
  writeFileSync(join(ROOT, 'apps', 'staff', '.env.local'), `MEDPLUM_PROJECT_ID=${projectId}\n`);

  console.log('\nRole policies:');
  for (const p of policies) console.log(`  ${p.name} → AccessPolicy/${p.id}`);
  console.log('\nNext: `npm run seed`, `npm run worker` (reminders), then `npm run verify:phase1` and `npm run verify:phase2`.');
}

async function bootstrap(): Promise<void> {
  console.log('Bootstrapping the Teleemon project (one-time, as Medplum super admin)…');
  const sa = await connectAsPassword(process.env.MEDPLUM_ADMIN_EMAIL ?? 'admin@example.com', process.env.MEDPLUM_ADMIN_PASSWORD ?? 'medplum_admin');
  if (!sa.getProject()?.superAdmin) {
    throw new Error('Bootstrap needs the Medplum super admin login (MEDPLUM_ADMIN_EMAIL / MEDPLUM_ADMIN_PASSWORD).');
  }

  let project = await sa.searchOne('Project', { name: PROJECT_NAME });
  if (!project) {
    project = await sa.createResource<Project>({
      resourceType: 'Project',
      name: PROJECT_NAME,
      description: 'Teleemon Behavioral Health & Wellness: practice EHR, PM and billing',
      features: ['bots', 'transaction-bundles'],
      strictMode: true,
      checkReferencesOnWrite: true,
      setting: [{ name: 'preCommitSubscriptionsEnabled', valueBoolean: true }],
    });
    console.log(`  ✓ Created project ${project.id}`);
  } else if (!project.features?.includes('bots')) {
    project = await sa.updateResource<Project>({ ...project, features: [...(project.features ?? []), 'bots'] });
  }
  const projectId = project.id as string;

  // Practice administrator (full access, no AccessPolicy). In production this is the owner's own account.
  const adminEmail = process.env.TELEEMON_ADMIN_EMAIL ?? 'admin@teleemon.test';
  const existingAdmin = await sa.searchOne('ProjectMembership', { project: `Project/${projectId}`, 'user-name': adminEmail });
  if (!existingAdmin) {
    await sa.post(`admin/projects/${projectId}/invite`, {
      resourceType: 'Practitioner',
      firstName: 'Practice',
      lastName: 'Administrator',
      email: adminEmail,
      password: process.env.TELEEMON_ADMIN_PASSWORD ?? 'Teleemon-Local-2026',
      sendEmail: false,
      scope: 'server',
      membership: { admin: true },
    });
    console.log(`  ✓ Invited practice administrator ${adminEmail}`);
  }

  // Service client for scripts, with an admin membership in the Teleemon project.
  const client = await sa.post<ClientApplication>(`admin/projects/${projectId}/client`, {
    name: CLIENT_NAME,
    description: 'Service client for Teleemon setup, seed and migration scripts. Never deployed to production.',
  });
  const membership = await sa.searchOne('ProjectMembership', { profile: `ClientApplication/${client.id}` });
  if (!membership) throw new Error('Created the service client but could not find its membership.');
  await sa.updateResource<ProjectMembership>({ ...membership, admin: true });
  writeEnvValues({ TELEEMON_PROJECT_ID: projectId, TELEEMON_CLIENT_ID: client.id as string, TELEEMON_CLIENT_SECRET: client.secret as string });
  console.log(`  ✓ Created service client ${client.id}; credentials saved to .env.local`);

  // Remove earlier "Teleemon scripts" clients that live outside the Teleemon project (e.g. in Super Admin).
  const stale = (await sa.searchResources('ClientApplication', { name: CLIENT_NAME })).filter((c) => c.meta?.project !== projectId);
  for (const c of stale) {
    const m = await sa.searchOne('ProjectMembership', { profile: `ClientApplication/${c.id}` });
    if (m?.id) await sa.deleteResource('ProjectMembership', m.id);
    await sa.deleteResource('ClientApplication', c.id as string);
    console.log(`  ✓ Removed stale service client ${c.id} from project ${c.meta?.project}`);
  }
}

async function applySettings(medplum: MedplumClient, projectId: string, args: Set<string>): Promise<void> {
  await ensureTransactions(medplum, projectId);
  const details = await medplum.get<{ project: Project }>(`admin/projects/${projectId}`, { cache: 'no-cache' });
  const settings = new Map<string, ProjectSetting>((details.project.setting ?? []).map((s) => [s.name, s]));
  settings.set('preCommitSubscriptionsEnabled', { name: 'preCommitSubscriptionsEnabled', valueBoolean: true });
  // Authenticator apps only; email codes are weaker and are not offered to staff.
  settings.set('allowedMfaMethods', { name: 'allowedMfaMethods', valueString: 'totp' });
  if (args.has('--mfa')) settings.set('mfaRequired', { name: 'mfaRequired', valueBoolean: true });
  if (args.has('--no-mfa')) settings.set('mfaRequired', { name: 'mfaRequired', valueBoolean: false });
  await medplum.post(`admin/projects/${projectId}/settings`, [...settings.values()]);
  const mfa = settings.get('mfaRequired')?.valueBoolean === true;
  console.log(`✓ Project settings applied · pre-commit Bots on · MFA required: ${mfa ? 'yes' : 'no (run with --mfa to enforce)'}`);
}

/** Medplum otherwise silently treats transaction bundles as independent batch writes. */
async function ensureTransactions(medplum: MedplumClient, projectId: string): Promise<void> {
  const { project } = await medplum.get<{ project: Project }>(`admin/projects/${projectId}`, { cache: 'no-cache' });
  if (project.features?.includes('transaction-bundles')) return;
  const sa = await connectAsPassword(process.env.MEDPLUM_ADMIN_EMAIL ?? 'admin@example.com', process.env.MEDPLUM_ADMIN_PASSWORD ?? 'medplum_admin');
  if (!sa.getProject()?.superAdmin) throw new Error('Enabling transaction-bundles requires the configured Medplum super administrator.');
  const current = await sa.readResource('Project', projectId, { cache: 'no-cache' });
  await sa.updateResource({ ...current, features: [...new Set([...(current.features ?? []), 'transaction-bundles' as const])] });
  console.log('✓ Atomic transaction bundles enabled for the Teleemon project.');
}

async function upsertPolicy(medplum: MedplumClient, policy: AccessPolicy): Promise<AccessPolicy> {
  const existing = await medplum.searchOne('AccessPolicy', { 'name:exact': policy.name as string });
  return existing ? medplum.updateResource({ ...policy, id: existing.id }) : medplum.createResource(policy);
}

async function applyAccessPolicies(medplum: MedplumClient): Promise<AccessPolicy[]> {
  const result: AccessPolicy[] = [];
  for (const policy of [...ACCESS_POLICIES, ...PORTAL_POLICIES]) {
    result.push(await upsertPolicy(medplum, policy));
  }
  console.log(`✓ ${result.length} role access policies applied`);
  return result;
}

/** Measure instruments (P15) as FHIR Questionnaires, generated from @teleemon/core so scoring and forms match. */
async function applyQuestionnaires(medplum: MedplumClient): Promise<void> {
  for (const def of MEASURE_LIST) {
    const url = questionnaireUrl(def.key);
    const q: Questionnaire = {
      resourceType: 'Questionnaire',
      url,
      name: def.key.replace(/-/g, '_'),
      title: def.title,
      status: 'active',
      subjectType: ['Patient'],
      description: def.prompt,
      item: def.items.map((item) => ({
        linkId: item.linkId,
        text: item.text,
        type: 'choice',
        required: true,
        answerOption: item.options.map((o) => ({ valueCoding: { code: String(o.value), display: o.label } })),
      })),
    };
    const existing = await medplum.searchOne('Questionnaire', { url });
    await (existing ? medplum.updateResource({ ...q, id: existing.id }) : medplum.createResource(q));
  }
  console.log(`✓ ${MEASURE_LIST.length} measure questionnaires applied (${MEASURE_LIST.map((m) => m.shortTitle).join(', ')})`);
}

/** The delivery worker gets its own client and least-privilege policy (SYSTEM-DESIGN.md §5.1). */
async function applyWorkerClient(medplum: MedplumClient, projectId: string): Promise<void> {
  const policy = await upsertPolicy(medplum, WORKER_POLICY);
  const policyRef = { reference: getReferenceString(policy), display: policy.name };
  let clientId = process.env.TELEEMON_WORKER_CLIENT_ID;
  if (!clientId || !(await medplum.searchOne('ClientApplication', { _id: clientId }))) {
    const client = await medplum.post<ClientApplication>(`admin/projects/${projectId}/client`, {
      name: 'Teleemon worker',
      description: 'Delivery worker: reminders, inbound SMS replies. Least-privilege policy.',
    });
    clientId = client.id as string;
    writeEnvValues({ TELEEMON_WORKER_CLIENT_ID: clientId, TELEEMON_WORKER_CLIENT_SECRET: client.secret as string });
    console.log(`✓ Created worker client ${clientId}; credentials saved to .env.local`);
  }
  const membership = await medplum.searchOne('ProjectMembership', { profile: `ClientApplication/${clientId}` });
  if (membership && membership.accessPolicy?.reference !== policyRef.reference) {
    await medplum.post(`admin/projects/${projectId}/members/${membership.id}`, { ...membership, admin: false, accessPolicy: policyRef });
  }
  console.log('✓ Worker client on its least-privilege policy');
}

/** A service client with its own policy and credentials in .env.local (SYSTEM-DESIGN.md §5.1). */
async function applyServiceClient(medplum: MedplumClient, projectId: string, opts: { name: string; description: string; idVar: string; secretVar: string; policy: AccessPolicy; admin: boolean }): Promise<void> {
  const policy = await upsertPolicy(medplum, opts.policy);
  const policyRef = { reference: getReferenceString(policy), display: policy.name };
  let clientId = process.env[opts.idVar];
  if (!clientId || !(await medplum.searchOne('ClientApplication', { _id: clientId }))) {
    const client = await medplum.post<ClientApplication>(`admin/projects/${projectId}/client`, { name: opts.name, description: opts.description });
    clientId = client.id as string;
    writeEnvValues({ [opts.idVar]: clientId, [opts.secretVar]: client.secret as string });
    loadEnv();
    console.log(`✓ Created ${opts.name} client ${clientId}; credentials saved to .env.local`);
  }
  const membership = await medplum.searchOne('ProjectMembership', { profile: `ClientApplication/${clientId}` });
  if (membership && (membership.accessPolicy?.reference !== policyRef.reference || !!membership.admin !== opts.admin)) {
    await medplum.post(`admin/projects/${projectId}/members/${membership.id}`, { ...membership, admin: opts.admin, accessPolicy: policyRef });
  }
}

/**
 * Phase 7 (ADR-012): the portal service's two clients, the public portal app client and the
 * secret that signs booking-page challenges. The app client has no project membership, so its
 * secret cannot be used for client-credentials sign-in; patients sign in through it with PKCE.
 */
async function applyPortal(medplum: MedplumClient, projectId: string): Promise<void> {
  await applyServiceClient(medplum, projectId, {
    name: 'Teleemon portal service', description: 'Public booking and portal writes with rules. Least-privilege policy.',
    idVar: 'TELEEMON_PORTAL_CLIENT_ID', secretVar: 'TELEEMON_PORTAL_CLIENT_SECRET', policy: PORTAL_SERVICE_POLICY, admin: false,
  });
  await applyServiceClient(medplum, projectId, {
    name: 'Teleemon portal accounts', description: 'Creates patient and proxy sign-ins from invitations; keeps proxy policies current. Internal only.',
    idVar: 'TELEEMON_PORTAL_ACCOUNTS_CLIENT_ID', secretVar: 'TELEEMON_PORTAL_ACCOUNTS_CLIENT_SECRET', policy: PORTAL_ACCOUNTS_POLICY, admin: true,
  });
  const portalUrl = (process.env.TELEEMON_PORTAL_URL ?? 'http://localhost:3200/').replace(/\/?$/, '/');
  const desired = {
    resourceType: 'ClientApplication' as const,
    name: PORTAL_CLIENT_NAME,
    description: 'Patient portal and public booking (apps/portal). Public client: PKCE, patient and proxy sign-in only.',
    redirectUri: portalUrl,
    accessTokenLifetime: '30m',
    refreshTokenLifetime: '12h',
  };
  const existing = await medplum.searchOne('ClientApplication', { 'name:exact': PORTAL_CLIENT_NAME });
  const app = existing
    ? await medplum.updateResource<ClientApplication>({ ...existing, ...desired })
    : await medplum.createResource<ClientApplication>({ ...desired, secret: randomBytes(32).toString('hex') });
  if (!process.env.TELEEMON_PORTAL_SECRET) writeEnvValues({ TELEEMON_PORTAL_SECRET: randomBytes(32).toString('hex') });
  writeFileSync(join(ROOT, 'apps', 'portal', '.env.local'), `MEDPLUM_PROJECT_ID=${projectId}\nMEDPLUM_CLIENT_ID=${app.id}\n`);
  console.log(`✓ Portal clients ready · app client ${app.id} → ${portalUrl}`);
}

async function applyScribeRetentionClient(medplum: MedplumClient, projectId: string): Promise<void> {
  const policy = await upsertPolicy(medplum, SCRIBE_RETENTION_POLICY);
  const policyRef = { reference: getReferenceString(policy), display: policy.name };
  let clientId = process.env.TELEEMON_SCRIBE_RETENTION_CLIENT_ID;
  if (!clientId || !(await medplum.searchOne('ClientApplication', { _id: clientId }))) {
    const client = await medplum.post<ClientApplication>(`admin/projects/${projectId}/client`, { name: 'Teleemon scribe retention', description: 'Scheduled audio retention; separate from interactive scribe requests.' });
    clientId = client.id as string;
    writeEnvValues({ TELEEMON_SCRIBE_RETENTION_CLIENT_ID: clientId, TELEEMON_SCRIBE_RETENTION_CLIENT_SECRET: client.secret as string });
  }
  const membership = await medplum.searchOne('ProjectMembership', { profile: `ClientApplication/${clientId}` });
  if (membership) await medplum.post(`admin/projects/${projectId}/members/${membership.id}`, { ...membership, admin: false, accessPolicy: policyRef });
  console.log('✓ Scribe retention client and Phase 4 privacy policies configured');
}

async function applyBots(medplum: MedplumClient, projectId: string): Promise<void> {
  await buildBots();
  for (const def of BOTS) {
    const policy = await upsertPolicy(medplum, def.policy);
    let bot: Bot | undefined = await medplum.searchOne('Bot', { 'name:exact': def.name });
    for (const former of def.formerNames ?? []) {
      if (bot) break;
      const old = await medplum.searchOne('Bot', { 'name:exact': former });
      if (old) bot = await medplum.updateResource<Bot>({ ...old, name: def.name, description: def.description });
    }
    if (!bot) {
      bot = await medplum.post<Bot>(`admin/projects/${projectId}/bot`, {
        name: def.name,
        description: def.description,
        runtimeVersion: 'vmcontext',
        accessPolicy: { reference: getReferenceString(policy) },
      });
    }
    const botId = bot.id as string;
    // Keep the Bot's membership on its least-privilege policy.
    const membership = await medplum.searchOne('ProjectMembership', { profile: `Bot/${botId}` });
    if (membership && membership.accessPolicy?.reference !== getReferenceString(policy)) {
      await medplum.post(`admin/projects/${projectId}/members/${membership.id}`, { ...membership, accessPolicy: { reference: getReferenceString(policy) } });
    }
    const code = readFileSync(join(ROOT, 'bots', 'dist', `${def.file}.js`), 'utf8');
    await medplum.post(medplum.fhirUrl('Bot', botId, '$deploy'), { code, filename: `${def.file}.js` });

    const endpoint = `Bot/${botId}`;
    if (!def.criteria) {
      console.log(`✓ Bot deployed: ${def.name} (on demand) → ${endpoint}`);
      continue;
    }
    const subs = await medplum.searchResources('Subscription', { url: endpoint, _count: '20' });
    const desired: Subscription = {
      resourceType: 'Subscription',
      status: 'active',
      reason: def.description,
      criteria: def.criteria,
      channel: { type: 'rest-hook', endpoint },
      extension: def.preCommit ? [{ url: PRE_COMMIT_EXTENSION, valueBoolean: true }] : undefined,
    };
    const match = subs.find((s) => s.criteria === def.criteria);
    if (match) {
      await medplum.updateResource({ ...desired, id: match.id });
    } else {
      await medplum.createResource(desired);
    }
    console.log(`✓ Bot deployed: ${def.name}${def.preCommit ? ' (pre-commit)' : ''} → ${endpoint}`);
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  process.exit(1);
});
