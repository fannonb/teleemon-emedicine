// Synthetic local acceptance: audit immutability, role boundaries, real read audits, migration replay,
// compliance attestations (administrator only, append-only) and worker-only integration health.
import { MedplumClient, normalizeErrorString } from '@medplum/core';
import type { AuditEvent, DocumentReference, Task } from '@medplum/fhirtypes';
import { buildComplianceAttestation, buildIntegrationHealthTask } from '../packages/core/src/operations';
import { recordWorkerHeartbeat } from '../services/worker/src/operations';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../services/ledger/src/index';
import { LedgerStore } from '../services/ledger/src/store';
import { ROOT, baseUrl, connect, connectAsPassword, loadEnv } from './lib/client';
import { importSyntheticMigration } from './lib/migration-import';
import { MIGRATION_SYSTEM, type MigrationBundle } from '../packages/core/src/migration';
import { loadWaitlist, saveWaitlistAppointment } from '../apps/staff/src/operations/waitlist';
import { completeRecallTask, loadRecalls, saveRecallTask } from '../apps/staff/src/operations/recalls';

loadEnv();
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl()).hostname)) throw new Error('Phase 9 verification is local only.');
let passed = 0; let failed = 0;
const lines: string[] = [];
function check(ok: boolean, label: string): void { const line = `${ok ? 'PASS' : 'FAIL'} ${label}`; lines.push(line); console.log(line); if (ok) passed++; else failed++; }
async function refused(fn: () => Promise<unknown>): Promise<boolean> { try { await fn(); return false; } catch { return true; } }
try {
  const admin = await connect();
  const password = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
  const front = await connectAsPassword('frontdesk@teleemon.test', password);
  const provider = await connectAsPassword('provider@teleemon.test', password);
  const biller = await connectAsPassword('biller@teleemon.test', password);
  const audit = await provider.createResource<AuditEvent>({ resourceType: 'AuditEvent', type: { code: 'rest' }, subtype: [{ system: 'https://fhir.teleemon.com/audit', code: 'phase9-verification' }], recorded: new Date().toISOString(), action: 'R', outcome: '0', agent: [{ requestor: true }], source: { observer: { display: 'Synthetic Phase 9 verification' } } });
  check(!!audit.id, 'Staff can append an audit event');
  check(await refused(() => admin.updateResource({ ...audit, outcomeDesc: 'Synthetic tampering attempt' })), 'Administrator cannot modify a stored audit event');
  check(await refused(() => admin.deleteResource('AuditEvent', audit.id as string)), 'Administrator cannot delete a stored audit event');
  check(await refused(() => front.searchResources('AuditEvent', { _count: '1' })), 'Front desk cannot search audit records');
  check(await refused(() => provider.searchResources('AuditEvent', { _count: '1' })), 'Provider cannot search audit records');
  check(await refused(() => biller.searchResources('AuditEvent', { _count: '1' })), 'Biller cannot search audit records');
  const fixture = JSON.parse(readFileSync(join(ROOT, 'docs/verification/advancedmd-synthetic.json'), 'utf8')) as MigrationBundle;
  const first = await importSyntheticMigration(admin, fixture);
  const second = await importSyntheticMigration(admin, fixture);
  check(first.patients === fixture.patients.length && first.appointments === fixture.appointments.length, 'Imported patient and appointment counts equal synthetic source counts');
  check(second.replayed === fixture.patients.length + fixture.appointments.length, 'Repeating a migration reuses every target record');
  const changed = structuredClone(fixture); changed.patients[0].birthDate = '1991-01-01';
  check(await refused(() => importSyntheticMigration(admin, changed)), 'A different source cannot overwrite an existing imported patient');
  const patient = await admin.searchOne('Patient', { identifier: `${MIGRATION_SYSTEM}|patient:${fixture.patients[0].sourceId}` });
  await front.readResource('Patient', patient?.id as string, { cache: 'no-cache' });
  let found = false;
  for (let attempt = 0; attempt < 10 && !found; attempt++) {
    const events = await admin.searchResources('AuditEvent', { entity: `Patient/${patient?.id}`, _count: '20', _sort: '-_lastUpdated' }, { cache: 'no-cache' });
    found = events.some(event => event.action === 'R');
    if (!found) await new Promise(resolve => setTimeout(resolve, 500));
  }
  check(found, 'Direct Patient reads create server audit evidence');
  check((await admin.readResource('AuditEvent', audit.id as string)).outcomeDesc !== 'Synthetic tampering attempt', 'Original audit content remains unchanged');

  const preferredStart = new Date(Date.now() + 86400000).toISOString();
  const waitlist = await saveWaitlistAppointment(front, { patient: { reference: `Patient/${patient?.id}` }, visitTypeCode: 'med-mgmt', visitTypeLabel: 'Synthetic waitlist verification', preferredStart });
  check(waitlist.status === 'waitlist' && !waitlist.start, 'Staff creates a waitlist request without booking an appointment slot');
  check((await loadWaitlist(front)).rows.some(row => row.appointment.id === waitlist.id), 'Waitlist queue loads the saved request through supported FHIR search parameters');
  await front.updateResource({ ...waitlist, status: 'cancelled' });
  const recall = await saveRecallTask(front, { patient: { reference: `Patient/${patient?.id}` }, dueDate: preferredStart.slice(0, 10), reasonCode: `verification-${Date.now()}`, reasonLabel: 'Synthetic consent-review follow-up', channel: 'consent-review' });
  check((await loadRecalls(front)).some(row => row.task.id === recall.id), 'Internal recall queue loads the saved consent-review task');
  check((await completeRecallTask(front, recall.id as string, 'Synthetic verification complete.')).status === 'completed', 'Staff can complete an internal recall without sending patient outreach');

  // P45 compliance: attestations are recorded by an administrator, stamped by the server, append-only.
  const practiceAdmin = await connectAsPassword('admin@teleemon.test', password);
  const run = Date.now().toString(36);
  const evidence = await practiceAdmin.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', identifier: [{ system: 'https://fhir.teleemon.com/identifier/derived', value: `phase9-evidence:${run}` }], content: [{ attachment: { contentType: 'text/plain', title: 'Synthetic verification evidence', data: Buffer.from('Synthetic access review fixture; no real review is attested.').toString('base64') } }] });
  const attestation = (by: { reference: string }) => buildComplianceAttestation({
    checkpoint: 'access-review', title: 'Quarterly access review (synthetic verification)', evidence: { reference: `DocumentReference/${evidence.id}` },
    recordedBy: by, recordedAt: new Date().toISOString(),
  });
  const adminRef = { reference: `Practitioner/${practiceAdmin.getProfile()?.id}` };
  let attestationError = '';
  const attested = await practiceAdmin.createResource<Task>(attestation(adminRef)).catch((error: unknown) => { attestationError = normalizeErrorString(error); return undefined; });
  check(!!attested && attested.requester?.reference === adminRef.reference, `An administrator records a compliance attestation; the server stamps who recorded it${attestationError ? ` (${attestationError})` : ''}`);
  check(await refused(() => biller.createResource<Task>(attestation({ reference: `Practitioner/${biller.getProfile()?.id}` }))), 'A biller cannot record a compliance attestation');
  check(await refused(() => provider.createResource<Task>(attestation({ reference: `Practitioner/${provider.getProfile()?.id}` }))), 'A provider cannot record a compliance attestation');
  check(await refused(() => front.createResource<Task>(attestation({ reference: `Practitioner/${front.getProfile()?.id}` }))), 'Front desk cannot record a compliance attestation');
  if (attested) {
    check(await refused(() => practiceAdmin.updateResource({ ...attested, description: 'Changed after the fact' })), 'A recorded attestation cannot be changed');
    check(await refused(() => practiceAdmin.deleteResource('Task', attested.id as string)), 'A recorded attestation cannot be deleted');
    check(await refused(() => front.readResource('Task', attested.id as string, { cache: 'no-cache' })), 'Front desk cannot read a compliance control record directly');
  }

  // P44 integration health: only the named worker client records signals.
  const signal = buildIntegrationHealthTask({ key: 'worker', label: 'Background worker', configured: true, outcome: 'success', observedAt: new Date().toISOString() });
  check(await refused(() => practiceAdmin.createResource<Task>(signal)), 'Staff cannot forge an integration health signal');
  const worker = new MedplumClient({ baseUrl: baseUrl(), cacheTime: 0 });
  await worker.startClientLogin(process.env.TELEEMON_WORKER_CLIENT_ID as string, process.env.TELEEMON_WORKER_CLIENT_SECRET as string);
  await recordWorkerHeartbeat(worker, 'success');
  const recorded = await worker.searchOne('Task', { identifier: 'https://fhir.teleemon.com/identifier/derived|integration-health:worker' }, { cache: 'no-cache' });
  check(!!recorded && Date.now() - Date.parse(recorded.lastModified ?? '') < 60_000, 'The worker records its integration health signal');
  if (recorded) {
    check(await refused(() => practiceAdmin.deleteResource('Task', recorded.id as string)), 'An integration health signal cannot be deleted');
    check(await refused(() => provider.readResource('Task', recorded.id as string, { cache: 'no-cache' })), 'Provider cannot read an operational control record directly');
  }
  const ledger = new LedgerStore();
  const router = buildRouter(ledger);
  const server = createServer((request, response) => void router.handle(request, response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ledger/reports`;
    const get = (path: string, token?: string) => fetch(`${url}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    check((await get('ar-aging-ledger')).status === 401, 'Financial reports refuse unauthenticated requests');
    check((await get('ar-aging-ledger', front.getAccessToken())).status === 403, 'Financial reports refuse front-desk requests');
    check((await get('ar-aging-ledger', provider.getAccessToken())).status === 200, 'Financial reports are available to providers (they do billing work)');
    const financial = await get('ar-aging-ledger', biller.getAccessToken());
    const body = await financial.json() as { source?: string; complete?: boolean; totals?: { totalCents?: number; patientCents?: number; insuranceCents?: number } };
    check(financial.status === 200 && body.source === 'ledger' && body.complete === true, 'Biller receives a complete ledger-backed financial report');
    check(body.totals?.totalCents === (body.totals?.patientCents ?? 0) + (body.totals?.insuranceCents ?? 0), 'Financial report receivable totals reconcile to its account groups');
    check((await get('charges-by-period?from=2026-02-30', biller.getAccessToken())).status === 400, 'Financial report API rejects impossible dates');
    const reconciliation = await get('ledger-reconciliation', biller.getAccessToken());
    const result = await reconciliation.json() as { reconciliation?: { ok: boolean } };
    check(reconciliation.status === 200 && result.reconciliation?.ok === true, 'Current ledger report passes reconciliation');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await ledger.close(); }
} catch (error) { check(false, `Unexpected verification error: ${normalizeErrorString(error)}`); }
const summary = `${passed} PASS, ${failed} FAIL`;
console.log(summary); lines.push(summary);
writeFileSync(join(ROOT, 'docs/verification/phase9-api.log'), lines.join('\n') + '\n');
process.exitCode = failed ? 1 : 0;
