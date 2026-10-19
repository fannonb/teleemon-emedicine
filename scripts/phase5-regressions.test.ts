import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { MedicationRequest, MedicationStatement, Practitioner, Task } from '@medplum/fhirtypes';
import type { RxDraft } from '@teleemon/core';
import {
  CODE_SYSTEMS, ERX_IDENTIFIER_SYSTEM, EXT, addBusinessDays, buildMedicationRequest, buildPdmpTask, buildRenewalTask, deaScheduleCode, erxStatus,
  findMedication, prescriptionProblems, rxUpdateProblem, toQualification,
} from '@teleemon/core';
import { handler as rxRules } from '../bots/src/prescription-rules';
import { handler as pdmpRules } from '../bots/src/task-rules';
import { MockErxAdapter, processPrescriptions } from '../services/worker/src/erx';

const day = (offset: number): string => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const ALL = ['2', '2N', '3', '3N', '4', '5'];
const practitioner = (deas: { state: string; end: number; schedules: string[] }[] = [{ state: 'WA', end: 300, schedules: ALL }], authority?: boolean): Practitioner => ({
  resourceType: 'Practitioner', id: 'prov',
  qualification: [
    toQualification({ kind: 'state-license', state: 'WA', number: 'L1', start: day(-500), end: day(300), prescriptiveAuthority: authority }),
    toQualification({ kind: 'state-license', state: 'CA', number: 'L2', start: day(-500), end: day(300) }),
    toQualification({ kind: 'state-license', state: 'CO', number: 'L3', start: day(-500), end: day(300) }),
    ...deas.map((d) => toQualification({ kind: 'dea-registration', state: d.state, number: `D-${d.state}`, start: day(-500), end: day(d.end), schedules: d.schedules })),
  ],
});
const rx = (over: Partial<RxDraft> = {}): RxDraft => ({ medication: 'Sertraline', sig: 'Take 1 tablet daily', quantity: 30, unit: 'tablet', daysSupply: 30, refills: 2, pharmacy: 'Synthetic Pharmacy', state: 'WA', substitutionAllowed: true, ...over });
const pdmp = (state: string, hoursAgo: number, id = `pdmp-${state}-${hoursAgo}`): Task => ({
  ...buildPdmpTask({ patient: { reference: 'Patient/p' }, practitioner: { reference: 'Practitioner/prov' }, state, result: 'no-concerns', checkedAt: new Date(Date.now() - hoursAgo * 3600000).toISOString() }), id,
});
// Medplum stamps the acting user into meta.author before pre-commit Bots run (event.requester is not set).
const event = <T extends { meta?: object }>(input: T, author = 'Practitioner/prov'): BotEvent<T> => ({
  input: { ...input, meta: { ...(input.meta ?? {}), author: { reference: author } } }, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {},
});
const client = (methods: object): MedplumClient => methods as MedplumClient;
const has = (problems: string[], text: RegExp): boolean => problems.some((p) => text.test(p));

test('DEA schedule codes distinguish narcotic and non-narcotic schedules II and III', () => {
  assert.equal(deaScheduleCode(findMedication('Lisdexamfetamine')!), '2N');
  assert.equal(deaScheduleCode(findMedication('Buprenorphine/naloxone')!), '3');
  assert.equal(deaScheduleCode(findMedication('Clonazepam')!), '4');
  assert.equal(deaScheduleCode(findMedication('Sertraline')!), undefined);
});

test('a complete non-controlled prescription in a licensed state has no problems', () => {
  assert.deepEqual(prescriptionProblems(rx(), { practitioner: practitioner(), pdmpChecks: [] }), []);
});

test('licensure follows the patient: unlicensed state and missing location are blocked', () => {
  assert.ok(has(prescriptionProblems(rx({ state: 'TX' }), { practitioner: practitioner(), pdmpChecks: [] }), /not licensed in TX/));
  assert.ok(has(prescriptionProblems(rx({ state: '' }), { practitioner: practitioner(), pdmpChecks: [] }), /location/));
  assert.ok(has(prescriptionProblems(rx(), { practitioner: practitioner(undefined, false), pdmpChecks: [] }), /prescriptive authority/));
  assert.ok(has(prescriptionProblems(rx(), { practitioner: undefined, pdmpChecks: [] }), /Only a provider/));
});

test('controlled substances need a current PDMP check for the same state', () => {
  const stim = rx({ medication: 'Lisdexamfetamine', refills: 0 });
  const p = practitioner();
  assert.ok(has(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [] }), /PDMP check/));
  assert.deepEqual(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [pdmp('WA', 2)] }), []);
  assert.ok(has(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [pdmp('WA', 25)] }), /PDMP check/), 'older than 24 hours');
  assert.ok(has(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [pdmp('WA', -2)] }), /PDMP check/), 'future-dated');
  assert.ok(has(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [pdmp('CA', 1)] }), /PDMP check/), 'another state');
  assert.ok(has(prescriptionProblems(stim, { practitioner: p, pdmpChecks: [{ ...pdmp('WA', 1), status: 'entered-in-error' }] }), /PDMP check/), 'entered in error');
});

test('DEA registration must exist, be current and cover the schedule in the patient state', () => {
  const stim = rx({ medication: 'Lisdexamfetamine', refills: 0, state: 'CO' });
  assert.ok(has(prescriptionProblems(stim, { practitioner: practitioner(), pdmpChecks: [pdmp('CO', 1)] }), /no active DEA registration in CO/));
  const expired = practitioner([{ state: 'WA', end: -1, schedules: ALL }]);
  assert.ok(has(prescriptionProblems(rx({ medication: 'Lisdexamfetamine', refills: 0 }), { practitioner: expired, pdmpChecks: [pdmp('WA', 1)] }), /no active DEA/));
  const ivOnly = practitioner([{ state: 'WA', end: 300, schedules: ['4', '5'] }]);
  assert.ok(has(prescriptionProblems(rx({ medication: 'Lisdexamfetamine', refills: 0 }), { practitioner: ivOnly, pdmpChecks: [pdmp('WA', 1)] }), /does not cover schedule 2N/));
  assert.deepEqual(prescriptionProblems(rx({ medication: 'Clonazepam', refills: 1 }), { practitioner: ivOnly, pdmpChecks: [pdmp('WA', 1)] }), []);
});

test('refill limits: none for C-II, five for C-III to C-V, eleven otherwise', () => {
  const p = practitioner();
  const checks = [pdmp('WA', 1)];
  assert.ok(has(prescriptionProblems(rx({ medication: 'Methylphenidate', refills: 1 }), { practitioner: p, pdmpChecks: checks }), /cannot have refills/));
  assert.ok(has(prescriptionProblems(rx({ medication: 'Alprazolam', refills: 6 }), { practitioner: p, pdmpChecks: checks }), /at most 5 refills/));
  assert.deepEqual(prescriptionProblems(rx({ medication: 'Alprazolam', refills: 5 }), { practitioner: p, pdmpChecks: checks }), []);
  assert.ok(has(prescriptionProblems(rx({ refills: 12 }), { practitioner: p, pdmpChecks: [] }), /11 refills/));
  assert.ok(has(prescriptionProblems(rx({ daysSupply: 120 }), { practitioner: p, pdmpChecks: [] }), /Days supply/));
  assert.ok(has(prescriptionProblems(rx({ medication: 'Unlisted drug' }), { practitioner: p, pdmpChecks: [] }), /catalogue/));
});

test('a sent prescription is locked; only stop/cancel is allowed and terminal states stay terminal', () => {
  const sent = { ...buildMedicationRequest(rx(), { patient: { reference: 'Patient/p' }, requester: { reference: 'Practitioner/prov' }, send: true }), id: 'mr' };
  assert.equal(rxUpdateProblem({ ...sent, status: 'draft' }, { ...sent, dosageInstruction: [{ text: 'changed' }] }), undefined, 'drafts are editable');
  assert.match(rxUpdateProblem(sent, { ...sent, dosageInstruction: [{ text: 'Take 2 tablets' }] }) ?? '', /cannot be edited/);
  assert.match(rxUpdateProblem(sent, { ...sent, dispenseRequest: { ...sent.dispenseRequest, numberOfRepeatsAllowed: 9 } }) ?? '', /cannot be edited/);
  assert.match(rxUpdateProblem(sent, { ...sent, status: 'cancelled' }) ?? '', /cancellation/);
  assert.equal(rxUpdateProblem(sent, { ...sent, status: 'cancelled', extension: [...(sent.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'cancel-requested' }] }), undefined);
  assert.match(rxUpdateProblem({ ...sent, status: 'cancelled' }, { ...sent, status: 'active' }) ?? '', /cannot be reactivated/);
  assert.match(rxUpdateProblem(sent, { ...sent, status: 'draft' }) ?? '', /cannot return to draft/);
});

test('renewal requests are due in two business days, skipping weekends', () => {
  const friday = new Date('2026-10-16T15:00:00Z');
  assert.equal(addBusinessDays(friday, 2).toISOString().slice(0, 10), '2026-10-20');
  const task = buildRenewalTask({ patient: { reference: 'Patient/p' }, prescriber: { reference: 'Practitioner/prov' }, medication: 'Sertraline', from: 'Synthetic Pharmacy', received: friday });
  assert.equal(task.restriction?.period?.end?.slice(0, 10), '2026-10-20');
  assert.equal(task.code?.coding?.[0].code, 'rx-renewal');
});

// ---- Pre-commit Bots ----

const botClient = (opts: { before?: MedicationRequest; pdmp?: Task[]; prac?: Practitioner } = {}): MedplumClient => client({
  readResource: async () => { if (!opts.before) throw new Error('not found'); return opts.before; },
  readReference: async () => opts.prac ?? practitioner(),
  searchResources: async () => opts.pdmp ?? [],
});
const send = (draft: RxDraft, pdmpTaskId?: string): MedicationRequest =>
  buildMedicationRequest(draft, { patient: { reference: 'Patient/p' }, requester: { reference: 'Practitioner/prov' }, send: true, pdmpTaskId });

test('prescription Bot enforces the rules on send, including the cited PDMP check and prescriber identity', async () => {
  await assert.doesNotReject(rxRules(botClient(), event(send(rx()))));
  const stim = rx({ medication: 'Lisdexamfetamine', refills: 0 });
  await assert.rejects(rxRules(botClient(), event(send(stim))), /PDMP check/);
  await assert.rejects(rxRules(botClient({ pdmp: [pdmp('WA', 1, 'good')] }), event(send(stim))), /Link a current PDMP check/);
  await assert.rejects(rxRules(botClient({ pdmp: [pdmp('WA', 1, 'good'), pdmp('WA', 30, 'old')] }), event(send(stim, 'old'))), /Link a current PDMP check/);
  await assert.doesNotReject(rxRules(botClient({ pdmp: [pdmp('WA', 1, 'good')] }), event(send(stim, 'good'))));
  await assert.rejects(rxRules(botClient({ pdmp: [pdmp('WA', 1, 'good')] }), event(send(stim, 'good'), 'Practitioner/someone-else')), /prescriber named/);
  await assert.rejects(rxRules(botClient(), event(send(rx()), 'ClientApplication/service')), /prescriber named/);
  // Another provider's PDMP review does not count for this prescriber.
  const theirs = { ...pdmp('WA', 1, 'theirs'), owner: { reference: 'Practitioner/other' } };
  await assert.rejects(rxRules(botClient({ pdmp: [theirs] }), event(send(stim, 'theirs'))), /PDMP check/);
  // Hiding the schedule from the server does not work: it is derived from the drug.
  const hidden = { ...send(stim, 'good'), extension: send(stim, 'good').extension?.filter((e) => e.url !== EXT.controlledSchedule) };
  await assert.rejects(rxRules(botClient({ pdmp: [pdmp('WA', 1, 'good')] }), event(hidden)), /controlled substance/);
  // A client cannot claim it was already sent.
  const claimed = { ...send(rx()), extension: [...(send(rx()).extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'sent' }] };
  await assert.rejects(rxRules(botClient(), event(claimed)), /queued/);
});

test('prescription Bot locks sent prescriptions and re-checks a retry after failure', async () => {
  const sent: MedicationRequest = { ...send(rx()), id: 'mr', meta: { versionId: '2' } };
  await assert.rejects(rxRules(botClient({ before: sent }), event({ ...sent, dosageInstruction: [{ text: 'Take 3' }] })), /cannot be edited/);
  await assert.rejects(rxRules(botClient({ before: sent }), event({ ...sent, status: 'cancelled' })), /cancellation/);
  const failed: MedicationRequest = { ...sent, extension: [...(sent.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'failed' }] };
  const retry: MedicationRequest = { ...failed, extension: [...(failed.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'queued' }] };
  await assert.rejects(rxRules(botClient({ before: failed, prac: practitioner([], false) }), event(retry)), /prescriptive authority/);
});

test('PDMP Bot: recorded at the time of review, by its owner, and immutable once completed', async () => {
  const fresh = pdmp('WA', 0);
  const tasks = client({ readResource: async () => { throw new Error('new'); } });
  await assert.doesNotReject(pdmpRules(tasks, event({ ...fresh, id: undefined })));
  await assert.rejects(pdmpRules(tasks, event({ ...pdmp('WA', 3), id: undefined })), /within the last 60 minutes/);
  await assert.rejects(pdmpRules(tasks, event({ ...fresh, id: undefined }, 'Practitioner/other')), /your own name/);
  await assert.rejects(pdmpRules(client({ readResource: async () => fresh }), event({ ...fresh, status: 'entered-in-error', statusReason: { text: 'Recorded for the wrong state' } }, 'Practitioner/other')), /your own name/);
  await assert.rejects(pdmpRules(tasks, event({ ...fresh, id: undefined, input: [] })), /name the state/);
  const stored = client({ readResource: async () => fresh });
  await assert.rejects(pdmpRules(stored, event({ ...fresh, extension: [{ url: EXT.pdmpResult, valueCode: 'concerns-discussed' }] })), /cannot be changed/);
  await assert.doesNotReject(pdmpRules(stored, event({ ...fresh, status: 'entered-in-error', statusReason: { text: 'Recorded for the wrong state' } })));
  const other: Task = { resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'lab-monitoring' }] } };
  await assert.doesNotReject(pdmpRules(client({ readResource: async () => { throw new Error('new'); } }), event(other, 'Practitioner/frontdesk')));
  const deleted = { ...event(fresh, 'ClientApplication/admin'), headers: { 'X-Medplum-Deleted-Resource': 'Task/x' } };
  await assert.doesNotReject(pdmpRules(stored, deleted));
});

// ---- Worker ----

function fakeStore(initial: MedicationRequest[]): { m: MedplumClient; rows: Map<string, MedicationRequest>; created: (MedicationStatement | Task)[] } {
  const rows = new Map(initial.map((r) => [r.id as string, { ...r, meta: { versionId: '1' } }]));
  const created: (MedicationStatement | Task)[] = [];
  const m = client({
    searchResourcePages: async function* () { yield [...rows.values()]; },
    searchResources: async () => [...rows.values()],
    readResource: async (_t: string, id: string) => structuredClone(rows.get(id)),
    readReference: async (r: { reference: string }) => (r.reference.startsWith('Patient') ? { resourceType: 'Patient', id: 'p' } : practitioner()),
    updateResource: async (r: MedicationRequest, o: { headers: Record<string, string> }) => {
      const cur = rows.get(r.id as string)!;
      if (o?.headers?.['If-Match'] !== `W/"${cur.meta?.versionId}"`) throw new Error('version conflict');
      const next = { ...r, meta: { versionId: String(Number(cur.meta?.versionId) + 1) } };
      rows.set(r.id as string, next);
      return next;
    },
    createResourceIfNoneExist: async (r: MedicationStatement | Task) => { created.push(r); return r; },
    searchOne: async () => undefined,
  });
  return { m, rows, created };
}

test('worker sends queued prescriptions once, writes the chart medication, and surfaces failures', async () => {
  const ok = { ...send(rx()), id: 'ok' };
  const bad = { ...send(rx({ pharmacy: 'FAIL Pharmacy' })), id: 'bad' };
  const store = fakeStore([ok, bad]);
  const result = await processPrescriptions(store.m, new MockErxAdapter());
  assert.deepEqual(result, { sent: 1, failed: 1, cancelled: 0 });
  assert.equal(erxStatus(store.rows.get('ok')!), 'sent');
  assert.equal(store.rows.get('ok')!.identifier?.find((i) => i.system === ERX_IDENTIFIER_SYSTEM)?.value, 'MOCK-ok');
  assert.equal(erxStatus(store.rows.get('bad')!), 'failed');
  assert.ok(store.created.some((r) => r.resourceType === 'MedicationStatement' && r.basedOn?.[0].reference === 'MedicationRequest/ok'));
  assert.ok(store.created.some((r) => r.resourceType === 'Task' && r.priority === 'urgent' && r.focus?.reference === 'MedicationRequest/bad'));
  // A second pass sends nothing again.
  assert.deepEqual(await processPrescriptions(store.m, new MockErxAdapter()), { sent: 0, failed: 0, cancelled: 0 });
});

test('worker completes a cancellation, including one requested before transmission', async () => {
  const cancelled = { ...send(rx()), id: 'c', status: 'cancelled' as const };
  cancelled.extension = [...(cancelled.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'cancel-requested' }];
  const store = fakeStore([cancelled]);
  assert.deepEqual(await processPrescriptions(store.m, new MockErxAdapter()), { sent: 0, failed: 0, cancelled: 1 });
  assert.equal(erxStatus(store.rows.get('c')!), 'cancelled');
  assert.equal(store.rows.get('c')!.status, 'cancelled');
});

test('prescription validation rejects non-finite quantities and a PDMP decision not to prescribe', () => {
  assert.ok(has(prescriptionProblems(rx({ quantity: Infinity }), { practitioner: practitioner(), pdmpChecks: [] }), /finite quantity/));
  const check = pdmp('WA', 0);
  check.extension = [{ url: EXT.pdmpResult, valueCode: 'not-prescribing' }];
  assert.ok(has(prescriptionProblems(rx({ medication: 'Lisdexamfetamine' }), { practitioner: practitioner(), pdmpChecks: [check] }), /decision not to prescribe/));
});

test('transmission states and all sent clinical instructions stay protected', () => {
  const queued = { ...send(rx()), id: 'q' };
  assert.match(rxUpdateProblem(undefined, { ...queued, status: 'on-hold' }) ?? '', /draft or queued/);
  assert.match(rxUpdateProblem(queued, { ...queued, extension: [] }) ?? '', /transmission status/);
  assert.match(rxUpdateProblem(queued, { ...queued, note: [{ text: 'Change the medication instructions' }] }) ?? '', /cannot be edited/);
  const done = { ...queued, extension: [...queued.extension!.filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'cancelled' }] };
  assert.match(rxUpdateProblem(queued, done) ?? '', /Invalid.*status/);
});

test('worker rechecks current credentials before dispatch and does not call a vendor after revocation', async () => {
  const store = fakeStore([{ ...send(rx()), id: 'blocked' }]);
  Object.assign(store.m, { readReference: async (r: { reference: string }) => r.reference.startsWith('Patient/') ? { resourceType: 'Patient', id: 'p' } : practitioner([], false) });
  let calls = 0;
  const adapter = { mode: 'test', transmit: async () => { calls++; return { vendorId: 'unexpected' }; }, cancel: async () => undefined };
  assert.equal((await processPrescriptions(store.m, adapter)).failed, 1);
  assert.equal(calls, 0);
  assert.equal(erxStatus(store.rows.get('blocked')!), 'failed');
});

test('worker repairs a sent prescription medication projection without sending it again', async () => {
  const saved = { ...send(rx()), id: 'saved' };
  saved.extension = [...saved.extension!.filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'sent' }];
  const store = fakeStore([saved]);
  let calls = 0;
  await processPrescriptions(store.m, { mode: 'test', transmit: async () => { calls++; return { vendorId: 'unexpected' }; }, cancel: async () => undefined });
  assert.equal(calls, 0);
  assert.ok(store.created.some((r) => r.resourceType === 'MedicationStatement'));
});

test('an active transmission lease prevents a second concurrent dispatch', async () => {
  const saved = { ...send(rx()), id: 'leased' };
  saved.extension = [...saved.extension!.filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'sending' }, { url: 'https://fhir.teleemon.com/StructureDefinition/erx-attempt-at', valueInstant: new Date().toISOString() }];
  const store = fakeStore([saved]);
  let calls = 0;
  await processPrescriptions(store.m, { mode: 'test', transmit: async () => { calls++; return { vendorId: 'unexpected' }; }, cancel: async () => undefined });
  assert.equal(calls, 0);
});
