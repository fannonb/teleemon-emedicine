// Phase 8 gate: revenue cycle, proven against the local Medplum server, the deployed Bots and
// policies, the worker's billing pass (mock test payer) and the ledger service over HTTP, on a
// throwaway ledger database. Every hard rule is attempted by calling the API directly, bypassing
// the staff app, and must be refused by the server. After every posting the ledger must balance
// to the cent and the A/R report must tie to the ledger.
//
// Synthetic records only. Charges and claims cannot be deleted (by design), so they stay on the
// "Billing Verification" patients; stop `npm run worker` while this runs so it does not process them.
//
//   npm run verify:phase8

import type { MedplumClient, ProfileResource } from '@medplum/core';
import { MedplumClient as Client, createReference, normalizeErrorString } from '@medplum/core';
import type { ChargeItem, Claim, Coverage, Encounter, Patient, Practitioner, Task } from '@medplum/fhirtypes';
import type { ChargeLine, NoteData } from '@teleemon/core';
import {
  BILLING_TASKS, CODE_SYSTEMS, CPT_SYSTEM, EXT, GENERATED_IDENTIFIER_SYSTEM, PAYER_IDENTIFIER_SYSTEM, REMITTANCE_IDENTIFIER_SYSTEM, REVENUE_EXT, SEED_IDENTIFIER_SYSTEM,
  centsMoney, chargeItemCents, chargeLineOf, claimStatusOf, readSettings, scrubStampOf,
} from '@teleemon/core';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildComposition, loadVisit, newNote } from '../apps/staff/src/fhir/visits';
import { buildRouter } from '../services/ledger/src/index';
import { reconcile } from '../services/ledger/src/reports';
import { LedgerStore, pgConfigFromEnv } from '../services/ledger/src/store';
import { processBilling } from '../services/worker/src/billing';
import { MockClearinghouse } from '../services/worker/src/clearinghouse';
import { LedgerClient } from '../services/worker/src/ledgerClient';
import { ROOT, baseUrl, connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
const RUN = Date.now().toString(36);
const TAG = { system: GENERATED_IDENTIFIER_SYSTEM, value: 'verify-phase8' };
const PAYER = 'payer:synthetic-commercial';
let failures = 0;
let passes = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 180)})` : ''}`);
}
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}
async function eventually<T>(fn: () => Promise<T | undefined>, tries = 40): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

// --- Throwaway ledger database and an in-process ledger service -------------------------------

const cfg = pgConfigFromEnv();
const LEDGER_DB = `teleemon_ledger_verify_${RUN}`;
const PSQL = [process.env.LEDGER_PSQL, 'C:/Program Files/PostgreSQL/18/bin/psql.exe', '/usr/bin/psql'].find((p) => p && existsSync(p)) ?? 'psql';
const psql = (db: string, args: string[]) => spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user, '-d', db, ...args], { env: { ...process.env, PGPASSWORD: cfg.password }, encoding: 'utf8' });

async function startLedger(): Promise<{ store: LedgerStore; url: string; close: () => Promise<void> }> {
  if (psql('postgres', ['-c', `create database ${LEDGER_DB}`]).status !== 0) throw new Error('Could not create the throwaway ledger database. Is PostgreSQL running (Start-Medplum.ps1)?');
  const applied = psql(LEDGER_DB, ['-f', join(ROOT, 'services', 'ledger', 'schema.sql')]);
  if (applied.status !== 0) throw new Error(applied.stderr);
  const store = new LedgerStore({ ...cfg, database: LEDGER_DB });
  const router = buildRouter(store);
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store, url,
    close: async () => {
      server.close();
      await store.close();
      psql('postgres', ['-c', `drop database if exists ${LEDGER_DB} with (force)`]);
    },
  };
}

async function ledgerHttp(url: string, token: string | undefined, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// --- Synthetic visits ----------------------------------------------------------------------------

interface Visit {
  readonly patient: Patient;
  readonly coverage: Coverage;
  readonly encounter: Encounter;
}

let patientCount = 0;
async function syntheticVisit(admin: MedplumClient, provider: MedplumClient, practitioner: Practitioner, label: string, memberId: string): Promise<Visit> {
  // Distinct date of birth and phone per run and patient, so the duplicate-patient check does not fire.
  const n = ++patientCount;
  const h = createHash('sha256').update(`${RUN}:${n}`).digest();
  const birthDate = `${1950 + (h[0] % 50)}-${String(1 + (h[1] % 12)).padStart(2, '0')}-${String(1 + (h[2] % 28)).padStart(2, '0')}`;
  const phone = `206-555-${String(h.readUInt16BE(3) % 10000).padStart(4, '0')}`;
  const patient = await admin.createResource<Patient>({
    resourceType: 'Patient', identifier: [TAG], name: [{ given: [label], family: 'Billing Verification' }], birthDate, gender: 'female',
    address: [{ line: ['1 Synthetic Way'], city: 'Bellevue', state: 'WA', postalCode: '98004' }], telecom: [{ system: 'phone', value: phone }],
  });
  const coverage = await admin.createResource<Coverage>({
    resourceType: 'Coverage', identifier: [TAG], status: 'active', beneficiary: createReference(patient), subscriber: createReference(patient), subscriberId: memberId,
    relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }] },
    payor: [{ display: 'Synthetic Commercial Health (test)', identifier: { system: PAYER_IDENTIFIER_SYSTEM, value: PAYER } }], period: { start: '2026-01-01' }, order: 1,
  });
  const encounter = await provider.createResource<Encounter>({
    resourceType: 'Encounter', identifier: [TAG], status: 'in-progress', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR' },
    type: [{ coding: [{ system: CODE_SYSTEMS.visitType, code: 'med-mgmt' }], text: 'Medication management' }],
    subject: createReference(patient), participant: [{ individual: createReference(practitioner) }], period: { start: new Date(Date.now() - 3600000).toISOString() },
    extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.patientLocationState, valueCode: 'WA' }],
  });
  return { patient, coverage, encounter };
}

function completeNote(base: NoteData): NoteData {
  return {
    ...base,
    sections: { ...base.sections, chiefComplaint: 'Follow-up', intervalHistory: 'Mood stable.', assessment: 'Stable on current regimen.', plan: 'Continue sertraline 100 mg daily.', followUp: 'Return in 4 weeks.' },
    mse: { appearance: 'Well groomed', behavior: 'Calm', speech: 'Normal', mood: 'good', affect: 'Euthymic', thoughtProcess: 'Linear', thoughtContent: 'No SI', cognition: 'Alert' },
    risk: { suicidalIdeation: 'denied', homicidalIdeation: 'denied', selfHarm: 'none', level: 'low' },
    diagnoses: [{ code: 'F41.1', display: 'Generalized anxiety disorder' }],
    billing: { ...base.billing, emMethod: 'mdm', mdm: 'moderate', primaryCode: '99214', addOnCode: undefined },
    medsReviewed: true,
  };
}

async function signNote(provider: MedplumClient, visit: Visit): Promise<void> {
  const profile = provider.getProfile() as ProfileResource;
  const ctx = await loadVisit(provider, visit.encounter.id as string);
  const data = completeNote(await newNote(provider, visit.encounter));
  const draft = await provider.createResource({ ...buildComposition(ctx, data, profile), identifier: TAG });
  await provider.updateResource({ ...buildComposition({ ...ctx, note: draft }, data, profile, { sign: true }), identifier: TAG });
}

const capturedCharge = (admin: MedplumClient, visit: Visit) =>
  eventually(() => admin.searchOne('ChargeItem', { context: `Encounter/${visit.encounter.id}` }, { cache: 'no-cache' }).then((c) => c ?? undefined));

function withExt<T extends ChargeItem | Claim>(r: T, url: string, value: { valueString?: string; valueCode?: string }): T {
  return { ...r, extension: [...(r.extension ?? []).filter((e) => e.url !== url), { url, ...value }] };
}

function claimFor(visit: Visit, charge: ChargeItem, practitioner: Practitioner, over: Partial<Claim> = {}): Claim {
  const line = chargeLineOf(charge) as ChargeLine;
  return {
    resourceType: 'Claim', identifier: [TAG], status: 'active', use: 'claim', created: new Date().toISOString(),
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] }, priority: { coding: [{ code: 'normal' }] },
    patient: createReference(visit.patient), provider: createReference(practitioner), billablePeriod: { start: charge.occurrenceDateTime, end: charge.occurrenceDateTime },
    insurance: [{ sequence: 1, focal: true, coverage: createReference(visit.coverage) }],
    diagnosis: (charge.reason ?? []).map((r, i) => ({ sequence: i + 1, diagnosisCodeableConcept: r })),
    item: [{
      sequence: 1, productOrService: { coding: [{ system: CPT_SYSTEM, code: line.code }] }, modifier: line.modifiers.map((m) => ({ coding: [{ code: m }] })),
      diagnosisSequence: [...line.diagnosisPointers], quantity: { value: 1 }, unitPrice: charge.priceOverride, net: charge.priceOverride,
      locationCodeableConcept: { coding: [{ system: 'https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set', code: line.pos }] },
      encounter: [createReference(visit.encounter)], extension: [{ url: REVENUE_EXT.chargeItem, valueReference: { reference: `ChargeItem/${charge.id}` } }],
    }],
    total: charge.priceOverride,
    extension: [{ url: REVENUE_EXT.claimStatus, valueCode: 'draft' }, { url: REVENUE_EXT.billingPayer, valueString: PAYER }],
    ...over,
  };
}

const setStatus = (c: Claim, status: string): Claim => withExt(c, REVENUE_EXT.claimStatus, { valueCode: status });

async function main(): Promise<void> {
  const admin = await connect();
  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const biller = await connectAsPassword('biller@teleemon.test', PASSWORD);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const worker = new Client({ baseUrl: baseUrl(), cacheTime: 0 });
  await worker.startClientLogin(process.env.TELEEMON_WORKER_CLIENT_ID as string, process.env.TELEEMON_WORKER_CLIENT_SECRET as string);
  const practitioner = (await admin.searchOne('Practitioner', { identifier: `${SEED_IDENTIFIER_SYSTEM}|prac-provider` })) as Practitioner;
  const token = process.env.LEDGER_INTERNAL_TOKEN ?? '';
  if (token.length < 32) throw new Error('LEDGER_INTERNAL_TOKEN is not set. Run `npm run setup`.');

  const ledger = await startLedger();
  const ch = new MockClearinghouse({ statePath: null, fees: (await readSettings(admin, 'billing')).fees });
  const ledgerClient = new LedgerClient(ledger.url, token);
  const billing = async () => {
    const counts = await processBilling(worker, ch, ledgerClient, new Date());
    if (process.argv.includes('--verbose')) console.log(`    worker pass: ${JSON.stringify(counts)}`);
    return counts;
  };
  const tied = async (label: string) => {
    const r = await reconcile(ledger.store);
    const bad = r.checks.filter((c) => !c.ok);
    report(bad.length === 0, `Ledger balances to the cent and A/R ties to it — ${label}`, bad.map((c) => `${c.label}: ${c.expectedCents} vs ${c.actualCents}`).join('; '));
  };

  try {
    console.log(`Phase 8 revenue cycle (ledger database ${LEDGER_DB}, mock test payer)\n`);
    const paid = await syntheticVisit(admin, provider, practitioner, `Paid${RUN}`, `SYN${RUN}`.toUpperCase());
    const denied = await syntheticVisit(admin, provider, practitioner, `Denied${RUN}`, `DENY${RUN}`.toUpperCase());
    const rejected = await syntheticVisit(admin, provider, practitioner, `Rejected${RUN}`, `REJ${RUN}`.toUpperCase());

    console.log('Charge capture and charge review (charge-capture, charge-rules)');
    for (const v of [paid, denied, rejected]) await signNote(provider, v);
    const charge = await capturedCharge(admin, paid);
    report(!!charge && charge.status === 'planned' && charge.code?.coding?.[0]?.code === '99214', 'Signing the note creates a 99214 charge waiting for review', charge?.status);
    if (!charge) return;
    report(chargeLineOf(charge)?.modifiers.includes('95') === true, 'The telehealth modifier for the payer is added', JSON.stringify(chargeLineOf(charge)?.modifiers));

    const fdRead = await attempt(() => frontdesk.readResource('ChargeItem', charge.id as string));
    report(!fdRead.ok, 'Front desk cannot read charges (server policy)', fdRead.error);
    const del = await attempt(() => admin.deleteResource('ChargeItem', charge.id as string));
    report(!del.ok, 'A charge cannot be deleted, even by an administrator', del.error);
    const billedByHand = await attempt(() => biller.updateResource({ ...charge, status: 'billed' }));
    report(!billedByHand.ok && /claim submission|cannot move/.test(billedByHand.error ?? ''), 'A biller cannot mark a charge billed by hand', billedByHand.error);
    const noDx = await attempt(() => biller.updateResource({ ...charge, status: 'billable', reason: [] }));
    report(!noDx.ok && /diagnosis/.test(noDx.error ?? ''), 'A charge without a diagnosis cannot be released', noDx.error);

    // AI-suggested code: a biller-entered charge flagged as AI-suggested and not yet accepted.
    const aiLine: ChargeLine = { ...(chargeLineOf(charge) as ChargeLine), code: '90833', chargeCents: 9000, aiSuggested: true, providerAccepted: false };
    const aiCharge = await biller.createResource<ChargeItem>({
      ...charge, id: undefined, meta: undefined, identifier: [TAG], code: { coding: [{ system: CPT_SYSTEM, code: '90833' }] }, priceOverride: centsMoney(9000),
      extension: [{ url: REVENUE_EXT.chargeLine, valueString: JSON.stringify(aiLine) }, { url: REVENUE_EXT.billingPayer, valueString: PAYER }],
    });
    const aiRelease = await attempt(() => biller.updateResource({ ...aiCharge, status: 'billable' }));
    report(!aiRelease.ok && /suggested by AI/.test(aiRelease.error ?? ''), 'An AI-suggested code cannot be released before the provider accepts it', aiRelease.error);
    const accepted = (l: ChargeLine) => ({ ...aiCharge, extension: [{ url: REVENUE_EXT.chargeLine, valueString: JSON.stringify(l) }, { url: REVENUE_EXT.billingPayer, valueString: PAYER }] });
    const billerAccepts = await attempt(() => biller.updateResource(accepted({ ...aiLine, providerAccepted: true })));
    report(!billerAccepts.ok && /rendering provider/.test(billerAccepts.error ?? ''), 'A biller cannot accept an AI-suggested code for the provider', billerAccepts.error);
    const providerAccepts = await attempt(() => provider.updateResource(accepted({ ...aiLine, providerAccepted: true })));
    report(providerAccepts.ok, 'The rendering provider accepts the AI-suggested code', providerAccepts.error);
    if (providerAccepts.value) await biller.updateResource(withExt({ ...providerAccepts.value, status: 'not-billable' }, REVENUE_EXT.holdReason, { valueString: 'Verification only; not billed' }));

    const released: ChargeItem[] = [];
    for (const v of [paid, denied, rejected]) {
      const c = v === paid ? charge : await capturedCharge(admin, v);
      const r = c ? await attempt(() => biller.updateResource({ ...c, status: 'billable' })) : { ok: false, error: 'no charge captured' };
      if (r.ok && 'value' in r && r.value) released.push(r.value);
    }
    report(released.length === 3, 'The biller releases the three visit charges', `${released.length} released`);

    console.log('\nLedger posting (worker → ledger service)');
    await billing();
    const posted = await admin.readResource('ChargeItem', charge.id as string, { cache: 'no-cache' });
    const journalKey = posted.extension?.find((e) => e.url === REVENUE_EXT.ledgerJournal)?.valueString;
    report(!!journalKey && !!(await ledger.store.journal(journalKey)), 'The released charge is posted to the ledger once, keyed by ChargeItem version', journalKey);
    await tied('after charges');
    const reprice = await attempt(() => biller.updateResource({ ...posted, priceOverride: centsMoney(1) }));
    report(!reprice.ok, 'A posted charge cannot be re-priced in place', reprice.error);
    const forgedPosting = await attempt(() => biller.updateResource(withExt(posted, REVENUE_EXT.ledgerJournal, { valueString: 'charge:forged:1' })));
    report(!forgedPosting.ok, 'Only the worker records a ledger posting', forgedPosting.error);

    console.log('\nClaims (claim-rules; server-side scrub)');
    const forged = await attempt(() => biller.createResource(withExt(claimFor(paid, posted, practitioner), REVENUE_EXT.scrubResult, { valueString: JSON.stringify({ at: 'now', hash: 'x', findings: [] }) })));
    report(!forged.ok && /recorded by the server/.test(forged.error ?? ''), 'A client-written "clean" scrub result is refused', forged.error);
    const fdClaim = await attempt(() => frontdesk.createResource(claimFor(paid, posted, practitioner)));
    report(!fdClaim.ok, 'Front desk cannot create claims (server policy)', fdClaim.error);
    const draft = await attempt(() => biller.createResource(claimFor(paid, posted, practitioner)));
    report(draft.ok && claimStatusOf(draft.value as Claim) === 'draft', 'The biller creates a draft claim for the visit', draft.error);
    if (!draft.value) return;
    const skip = await attempt(() => biller.updateResource(setStatus(draft.value as Claim, 'submitted')));
    report(!skip.ok && /cannot move from draft to submitted/.test(skip.error ?? ''), 'A draft cannot be submitted without scrubbing', skip.error);
    const second = await attempt(() => biller.createResource(claimFor(paid, posted, practitioner)));
    report(!second.ok && /already has a live claim/.test(second.error ?? ''), 'A visit cannot be billed on two live claims', second.error);
    const fakeReplacement = await attempt(() => biller.createResource({ ...claimFor(paid, posted, practitioner), related: [{ relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship', code: 'prior' }] }, claim: { reference: 'Claim/nonexistent-original' } }] }));
    report(!fakeReplacement.ok, 'An unrelated or nonexistent replacement reference cannot bypass duplicate protection', fakeReplacement.error);
    const scrubbed = await attempt(() => biller.updateResource(setStatus(draft.value as Claim, 'scrubbed')));
    report(scrubbed.ok && !!scrubStampOf(scrubbed.value as Claim), 'Scrubbing runs on the server and stores its own result', scrubbed.error);
    if (!scrubbed.value) return;
    const submitted = await attempt(() => biller.updateResource(setStatus(scrubbed.value as Claim, 'submitted')));
    report(submitted.ok, 'A clean claim is submitted', submitted.error);
    if (!submitted.value) return;
    const byHand = await attempt(() => biller.updateResource(setStatus(submitted.value as Claim, 'accepted')));
    report(!byHand.ok && /clearinghouse/.test(byHand.error ?? ''), 'A biller cannot record a payer outcome by hand', byHand.error);
    const edit = await attempt(() => biller.updateResource({ ...(submitted.value as Claim), total: centsMoney(1) }));
    report(!edit.ok && /cannot be edited/.test(edit.error ?? ''), 'A submitted claim is locked', edit.error);

    // The other two claims, straight to submission.
    const others: Claim[] = [];
    for (const v of [denied, rejected]) {
      const c = released.find((r) => r.context?.reference === `Encounter/${v.encounter.id}`) as ChargeItem;
      const d = await biller.createResource(claimFor(v, await admin.readResource('ChargeItem', c.id as string, { cache: 'no-cache' }), practitioner));
      const s = await biller.updateResource(setStatus(d, 'scrubbed'));
      others.push(await biller.updateResource(setStatus(s, 'submitted')));
    }

    console.log('\nClearinghouse round trip (mock test payer: 837P, 277CA, 835)');
    for (let i = 0; i < 4; i++) await billing();
    const after = await admin.readResource('Claim', submitted.value.id as string, { cache: 'no-cache' });
    report(['paid', 'partially-paid'].includes(claimStatusOf(after)), 'The test claim is accepted and paid by the test payer', claimStatusOf(after));
    report(!!after.identifier?.some((i) => i.system?.endsWith('/identifier/clearinghouse')), 'The clearinghouse id is recorded on the claim');
    const remits = await ledger.store.remittances();
    const prs = await admin.searchResources('PaymentReconciliation', { _count: '50', _sort: '-_lastUpdated' }, { cache: 'no-cache' });
    const ours = remits.filter((r) => prs.some((p) => p.identifier?.some((i) => i.system === REMITTANCE_IDENTIFIER_SYSTEM && i.value === r.traceNumber)));
    report(ours.length > 0 && ours.every((r) => r.postedCashCents === r.paidCents), 'Posted cash equals each ERA total', ours.map((r) => `${r.traceNumber}: ${r.postedCashCents}/${r.paidCents}`).join(', '));
    await tied('after the 835');
    const balance = await ledger.store.patientBalance(`Patient/${paid.patient.id}`);
    report(balance.owedCents === 2500, "The patient's copay moves to the patient account", `${balance.owedCents} cents`);

    const deniedClaim = await admin.readResource('Claim', others[0].id as string, { cache: 'no-cache' });
    const denial = await admin.searchOne('Task', { code: `${CODE_SYSTEMS.taskCode}|${BILLING_TASKS.denial}`, focus: `Claim/${deniedClaim.id}` }, { cache: 'no-cache' });
    report(claimStatusOf(deniedClaim) === 'denied' && !!denial?.restriction?.period?.end, 'A denied claim opens a denial task with an appeal deadline', `${claimStatusOf(deniedClaim)} · ${denial?.restriction?.period?.end}`);
    const rejectedClaim = await admin.readResource('Claim', others[1].id as string, { cache: 'no-cache' });
    const rejection = await admin.searchOne('Task', { code: `${CODE_SYSTEMS.taskCode}|${BILLING_TASKS.claimRejected}`, focus: `Claim/${rejectedClaim.id}` }, { cache: 'no-cache' });
    report(claimStatusOf(rejectedClaim) === 'rejected' && !!rejection, 'A rejected claim opens a claim-rejected task', claimStatusOf(rejectedClaim));

    console.log('\nLedger service rules (HTTP, bypassing the staff app)');
    const pid = paid.patient.id as string;
    const bt = biller.getAccessToken();
    const ft = frontdesk.getAccessToken();
    const pt = provider.getAccessToken();
    report((await ledgerHttp(ledger.url, undefined, 'POST', '/api/ledger/internal/payments', { paymentId: 'sbx_forged_1', patientRef: `Patient/${pid}`, cents: 100 })).status === 401, 'Internal ledger routes refuse calls without the service token');
    // Providers do billing work (practice decision, 18 Oct 2026); front desk does not.
    report((await ledgerHttp(ledger.url, pt, 'GET', `/api/ledger/ar`)).status === 200, 'A provider can read the A/R dashboard');
    report((await ledgerHttp(ledger.url, ft, 'GET', `/api/ledger/ar`)).status === 403, 'Front desk cannot read the A/R dashboard');
    report((await ledgerHttp(ledger.url, ft, 'POST', `/api/ledger/patients/${pid}/write-offs`, { cents: 100, reason: 'small-balance', key: `wo-${RUN}-fd` })).status === 403, 'Front desk cannot write off a balance');
    report((await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/patients/${pid}/write-offs`, { cents: 600, reason: 'small-balance', key: `wo-${RUN}-big` })).status === 403, 'A small-balance write-off over the policy limit is refused');
    report((await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/patients/${pid}/write-offs`, { cents: 300, reason: 'courtesy', key: `wo-${RUN}-courtesy` })).status === 403, 'A courtesy write-off needs an administrator');
    const cash = await ledgerHttp(ledger.url, ft, 'POST', `/api/ledger/patients/${pid}/payments`, { method: 'cash', cents: 3000, receipt: `R${RUN}` });
    report(cash.status === 200, 'Front desk records a $30 cash payment', JSON.stringify(cash.body));
    const replay = await ledgerHttp(ledger.url, ft, 'POST', `/api/ledger/patients/${pid}/payments`, { method: 'cash', cents: 3000, receipt: `R${RUN}` });
    report(replay.status === 200 && JSON.stringify(replay.body).includes('"created":false'), 'Recording the same receipt twice posts once');
    const after30 = await ledger.store.patientBalance(`Patient/${pid}`);
    report(after30.owedCents === 0 && after30.creditCents === 500, 'The $5 overpayment is held as credit', JSON.stringify(after30));
    report((await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/patients/${pid}/refunds`, { cents: 600, refundId: `rf-${RUN}-over` })).status === 400, 'A refund larger than the credit is refused');
    report((await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/patients/${pid}/refunds`, { cents: 500, refundId: `rf-${RUN}-ok` })).status === 200, 'The biller approves a $5 refund');
    report((await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/refunds/rf-${RUN}-ok/paid`, { method: 'card' })).status === 200, 'The refund is recorded as paid');
    const cashKey = `payment:cash-R${RUN}`;
    report((await ledgerHttp(ledger.url, bt, 'POST', '/api/ledger/reversals', { key: cashKey, reason: 'Verification reversal' })).status === 200, 'A payment is reversed with a reason');
    report((await ledgerHttp(ledger.url, bt, 'POST', '/api/ledger/reversals', { key: cashKey, reason: 'Again' })).status === 409, 'A journal can be reversed only once');
    await tied('after payments, refunds and reversals');

    console.log('\nDenied balance and statements');
    const dEnc = denied.encounter.id as string;
    const visitBal = await ledgerHttp(ledger.url, bt, 'GET', `/api/ledger/visits/${dEnc}`);
    const payerOwes = Number(visitBal.body.payerOwesCents);
    report(visitBal.status === 200 && payerOwes > 0, 'After the denial the payer still owes the full visit charge', `${payerOwes} cents`);
    const adj = (over: Record<string, unknown>) => ledgerHttp(ledger.url, bt, 'POST', '/api/ledger/payer-adjustments', { key: `pa-${RUN}-${Math.random().toString(36).slice(2, 10)}`, claimId: deniedClaim.id, encounterId: dEnc, payerRef: PAYER, cents: payerOwes, reason: 'denial-final', ...over });
    const wrongPatientTransfer = await ledgerHttp(ledger.url, bt, 'POST', '/api/ledger/transfers', { key: `wrong-patient-${RUN}`, claimId: deniedClaim.id, encounterId: dEnc, payerRef: PAYER, patientId: paid.patient.id, cents: 1 });
    report(wrongPatientTransfer.status === 400, 'A biller cannot transfer one patient’s payer balance to another patient', String(wrongPatientTransfer.body.message));
    const wrongVisitTransfer = await ledgerHttp(ledger.url, bt, 'POST', '/api/ledger/transfers', { key: `wrong-visit-${RUN}`, claimId: deniedClaim.id, encounterId: paid.encounter.id, payerRef: PAYER, patientId: denied.patient.id, cents: 1 });
    report(wrongVisitTransfer.status === 400, 'A biller cannot post a transfer using an unrelated visit', String(wrongVisitTransfer.body.message));
    report((await adj({ reason: 'timely-filing' })).status === 403, 'A timely-filing write-off needs an administrator');
    report((await adj({ cents: payerOwes + 1 })).status === 400, 'A payer write-down larger than the payer owes is refused');
    report((await adj({})).status === 200, 'The biller writes down the finally denied balance');
    await tied('after the payer write-down');
    const run = await biller.createResource<Task>({
      resourceType: 'Task', identifier: [TAG], status: 'requested', intent: 'order', priority: 'routine', authoredOn: new Date().toISOString(),
      code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: BILLING_TASKS.statementRun }], text: 'Statement run' },
      performerType: [{ coding: [{ system: 'https://fhir.teleemon.com/CodeSystem/team', code: 'biller' }] }],
    });
    await billing();
    const doneRun = await admin.readResource('Task', run.id as string, { cache: 'no-cache' });
    const invoice = await admin.searchOne('Invoice', { subject: `Patient/${pid}`, _sort: '-_lastUpdated' }, { cache: 'no-cache' });
    const owedNow = (await ledger.store.patientBalance(`Patient/${pid}`)).netCents;
    report(doneRun.status === 'completed' && invoice?.status === 'draft' && Math.round((invoice.totalNet?.value ?? 0) * 100) === owedNow, 'A statement run prepares a draft statement for the amount the ledger says is owed', `${doneRun.status} · ${invoice?.status} · ${invoice?.totalNet?.value} vs ${owedNow / 100}`);
    const noticeKey = `${GENERATED_IDENTIFIER_SYSTEM}|statement-notice:${invoice?.id}`;
    await billing();
    report(!(await admin.searchOne('Communication', { identifier: noticeKey }, { cache: 'no-cache' })), 'Nothing is sent to the patient before a biller issues the statement');
    if (invoice) await biller.updateResource({ ...invoice, status: 'issued', date: new Date().toISOString() });
    await billing();
    report(!!(await admin.searchOne('Communication', { identifier: noticeKey }, { cache: 'no-cache' })), 'Issuing the statement sends the patient one notice, without amounts');
    report(!/approved by|Practitioner\//.test(JSON.stringify(invoice?.lineItem ?? [])), 'Statement lines carry no staff memo or staff ids');

    console.log('\nVoiding a posted charge');
    const deniedCharge = released.find((r) => r.context?.reference === `Encounter/${denied.encounter.id}`) as ChargeItem;
    const current = await admin.readResource('ChargeItem', deniedCharge.id as string, { cache: 'no-cache' });
    const voided = await attempt(() => biller.updateResource(withExt({ ...current, status: 'entered-in-error' }, REVENUE_EXT.holdReason, { valueString: 'Verification: billed in error' })));
    report(voided.ok, 'A posted charge is marked entered in error with a reason', voided.error);
    await billing();
    await billing();
    const reversedKey = (await admin.readResource('ChargeItem', deniedCharge.id as string, { cache: 'no-cache' })).extension?.find((e) => e.url === REVENUE_EXT.ledgerReversal)?.valueString;
    report(!!reversedKey && !!(await ledger.store.journal(reversedKey)), 'The worker reverses it in the ledger exactly once', reversedKey);
    await tied('after the void');

    console.log('\nEligibility (270/271, mock)');
    const inactive = await syntheticVisit(admin, provider, practitioner, `Inactive${RUN}`, `INACTIVE${RUN}`.toUpperCase());
    await biller.createResource({ resourceType: 'CoverageEligibilityRequest', identifier: [TAG], status: 'active', purpose: ['benefits'], patient: createReference(inactive.patient), created: new Date().toISOString(), insurer: { display: 'Synthetic Commercial Health (test)' }, insurance: [{ coverage: createReference(inactive.coverage) }] });
    await billing();
    const issue = await admin.searchOne('Task', { code: `${CODE_SYSTEMS.taskCode}|${BILLING_TASKS.eligibilityIssue}`, patient: `Patient/${inactive.patient.id}` }, { cache: 'no-cache' });
    report(!!issue, 'Inactive coverage opens an eligibility task for the biller', (issue as Task | undefined)?.description);

    console.log('\nManual ERA status recovery');
    const manual = await syntheticVisit(admin, provider, practitioner, `Manual${RUN}`, `SYNMANUAL${RUN}`.toUpperCase());
    await signNote(provider, manual);
    const manualCharge = await capturedCharge(admin, manual);
    if (!manualCharge) throw new Error('The synthetic manual ERA visit did not create a charge.');
    const releasedManual = await biller.updateResource<ChargeItem>({ ...manualCharge, status: 'billable' });
    await billing();
    const manualDraft = await biller.createResource(claimFor(manual, releasedManual, practitioner));
    const manualScrubbed = await biller.updateResource(setStatus(manualDraft, 'scrubbed'));
    const manualSubmitted = await biller.updateResource(setStatus(manualScrubbed, 'submitted'));
    await worker.updateResource(setStatus(manualSubmitted, 'accepted'));
    const manualCents = chargeItemCents(releasedManual)!;
    const manualTrace = `MANUAL-${RUN}`;
    await ledger.store.postRemittance({ traceNumber: manualTrace, payerRef: PAYER, paidCents: manualCents, paymentDate: new Date().toISOString().slice(0, 10), claimCount: 1 }, [], 'service:verification');
    const manualBody = { payerClaimControl: `PCC-${RUN}`, claimRef: `Claim/${manualDraft.id}`, patientRef: `Patient/${manual.patient.id}`, encounterRef: `Encounter/${manual.encounter.id}`, paidCents: manualCents, contractualCents: 0, patientResponsibilityCents: 0, occurredAt: new Date().toISOString() };
    const manualPosted = await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/remittances/${manualTrace}/claims`, manualBody);
    const pendingManual = await ledger.store.claimProjectionJobs();
    report(manualPosted.status === 200 && pendingManual.jobs.some((job) => job.claimRef === `Claim/${manualDraft.id}`), 'Manual ERA posting durably queues the matching claim status update');
    await billing();
    const manualAfter = await admin.readResource('Claim', manualDraft.id!, { cache: 'no-cache' });
    report(claimStatusOf(manualAfter) === 'paid' && !(await ledger.store.claimProjectionJobs()).jobs.some((job) => job.claimRef === `Claim/${manualDraft.id}`), 'The worker applies and acknowledges a manually posted ERA claim status', claimStatusOf(manualAfter));
    const manualReplay = await ledgerHttp(ledger.url, bt, 'POST', `/api/ledger/remittances/${manualTrace}/claims`, manualBody);
    report(manualReplay.status === 200 && (manualReplay.body as unknown as { created?: boolean }[]).every((entry) => !entry.created), 'Replaying manual ERA posting does not duplicate the money');
    await tied('after manual ERA and status recovery');

    console.log('\nA/R dashboard over HTTP');
    const ar = await ledgerHttp(ledger.url, bt, 'GET', '/api/ledger/reconciliation');
    report(ar.status === 200 && ar.body.ok === true, 'The reconciliation endpoint reports every check passing', JSON.stringify((ar.body.checks as { label: string; ok: boolean }[] | undefined)?.filter((c) => !c.ok)));
  } finally {
    await ledger.close();
  }
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  console.log('(Charges and claims are never deleted; the synthetic records stay on the "Billing Verification" patients.)');
  console.log(failures === 0 ? '✓ Phase 8 server-side checks passed' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(normalizeErrorString(err));
  process.exit(1);
});


