// Phase 8 Bot regression tests: charge capture from signed notes, the ChargeItem rules
// (charge-rules) and the Claim rules (claim-rules). No server needed; `npm run verify:phase8` proves the same rules against
// local Medplum.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { ChargeItem, Claim, Composition, Encounter, Patient } from '@medplum/fhirtypes';
import type { ChargeLine, NoteData } from '@teleemon/core';
import { CHARGE_QUEUE_SYSTEM, CPT_SYSTEM, DEFAULT_BILLING, EXT, ICD10CM_SYSTEM, REVENUE_EXT, centsMoney, emptyNote, findTemplate } from '@teleemon/core';
import { handler as chargeCapture } from '../bots/src/charge-capture';
import { handler as chargeRules } from '../bots/src/charge-rules';
import { handler as claimRules } from '../bots/src/claim-rules';

const event = <T extends { meta?: object }>(input: T, author = 'Practitioner/prov'): BotEvent<T> => ({
  input: { ...input, meta: { ...(input.meta ?? {}), author: { reference: author } } }, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {},
});
const notFound = async (): Promise<never> => {
  throw Object.assign(new Error('Not found'), { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] } });
};
const settingsBasic = { resourceType: 'Basic', extension: [{ url: EXT.settingsJson, valueString: JSON.stringify(DEFAULT_BILLING) }] };

const line = (over: Partial<ChargeLine> = {}): ChargeLine => ({ code: '99214', modifiers: ['95'], units: 1, diagnosisPointers: [1], chargeCents: 18000, pos: '10', ...over });
const charge = (over: Partial<ChargeItem> = {}, l: ChargeLine = line()): ChargeItem => ({
  resourceType: 'ChargeItem', id: 'ci1', status: 'planned', code: { coding: [{ system: CPT_SYSTEM, code: l.code }] },
  subject: { reference: 'Patient/p' }, context: { reference: 'Encounter/e' }, performer: [{ actor: { reference: 'Practitioner/prov' } }],
  priceOverride: centsMoney(l.chargeCents), reason: [{ coding: [{ system: ICD10CM_SYSTEM, code: 'F33.1' }] }], occurrenceDateTime: '2026-10-01T16:00:00Z',
  extension: [{ url: REVENUE_EXT.chargeLine, valueString: JSON.stringify(l) }, { url: REVENUE_EXT.billingPayer, valueString: 'payer:synthetic-commercial' }],
  ...over,
});
const withExt = (c: ChargeItem, url: string, valueString: string): ChargeItem => ({ ...c, extension: [...(c.extension ?? []).filter((e) => e.url !== url), { url, valueString }] });
const rulesClient = (before?: ChargeItem): MedplumClient => ({ readResource: before ? async () => before : notFound }) as unknown as MedplumClient;
const run = (c: ChargeItem, before?: ChargeItem, author?: string) => chargeRules(rulesClient(before), event(c, author));

test('a new charge must start in review', async () => {
  await assert.rejects(run(charge({ id: undefined, status: 'billable' })), /starts in charge review/);
  assert.ok(await run(charge({ id: undefined })));
});

test('releasing a charge needs a payer, a diagnosis and a positive whole-cent amount', async () => {
  const planned = charge();
  assert.ok(await run(charge({ status: 'billable' }), planned, 'Practitioner/biller'));
  const noPayer = charge({ status: 'billable', extension: charge().extension?.filter((e) => e.url !== REVENUE_EXT.billingPayer) });
  await assert.rejects(run(noPayer, planned, 'Practitioner/biller'), /payer/);
  await assert.rejects(run(charge({ status: 'billable', reason: [] }), planned, 'Practitioner/biller'), /diagnosis/);
  await assert.rejects(run(charge({ status: 'billable', priceOverride: { value: 180.005, currency: 'USD' } }), planned, 'Practitioner/biller'), /whole cents/);
  await assert.rejects(run(charge({ status: 'billable', priceOverride: centsMoney(17000) }), planned, 'Practitioner/biller'), /disagree/);
});

test('an AI-suggested code is billable only after the rendering provider accepts it', async () => {
  const ai = line({ aiSuggested: true, providerAccepted: false });
  const planned = charge({}, ai);
  await assert.rejects(run(charge({ status: 'billable' }, ai), planned, 'Practitioner/biller'), /suggested by AI/);
  const accepted = line({ aiSuggested: true, providerAccepted: true });
  await assert.rejects(run(charge({}, accepted), planned, 'Practitioner/biller'), /rendering provider/);
  assert.ok(await run(charge({}, accepted), planned, 'Practitioner/prov'));
  await assert.rejects(run(charge({}, line({ aiSuggested: false, providerAccepted: true })), planned, 'Practitioner/prov'), /cannot be removed/);
});

test('only the worker marks a charge billed or records the ledger posting', async () => {
  const billable = charge({ status: 'billable' });
  await assert.rejects(run(charge({ status: 'billed' }), billable, 'Practitioner/biller'), /claim submission/);
  assert.ok(await run(charge({ status: 'billed' }), billable, 'ClientApplication/worker'));
  await assert.rejects(run(withExt(billable, REVENUE_EXT.ledgerJournal, 'charge:ci1:2'), billable, 'Practitioner/biller'), /ledger worker/);
});

test('a posted charge is frozen and its posting cannot be removed', async () => {
  const posted = withExt(charge({ status: 'billable' }), REVENUE_EXT.ledgerJournal, 'charge:ci1:2');
  await assert.rejects(run({ ...posted, priceOverride: centsMoney(1) }, posted, 'Practitioner/biller'), /posted to the ledger|disagree/);
  await assert.rejects(run(charge({ status: 'billable' }), posted, 'ClientApplication/worker'), /cannot be changed or removed/);
  const voided = withExt({ ...posted, status: 'entered-in-error' }, REVENUE_EXT.holdReason, 'Billed to the wrong visit');
  assert.ok(await run(voided, posted, 'Practitioner/biller'));
  await assert.rejects(run({ ...voided, status: 'planned' }, voided, 'Practitioner/biller'), /entered in error cannot be changed/);
});

test('every write keeps the work-queue tags in step (R4 has no ChargeItem status search)', async () => {
  const tags = (c: ChargeItem | boolean) => (c as ChargeItem).meta?.tag?.filter((t) => t.system === CHARGE_QUEUE_SYSTEM).map((t) => t.code).sort();
  assert.deepEqual(tags(await run(charge({ status: 'billable' }), charge(), 'Practitioner/biller')), ['ledger-pending', 'status-billable']);
  const posted = withExt(charge({ status: 'billable' }), REVENUE_EXT.ledgerJournal, 'charge:ci1:2');
  assert.deepEqual(tags(await run(posted, charge({ status: 'billable' }), 'ClientApplication/worker')), ['status-billable']);
  const voided = withExt({ ...posted, status: 'entered-in-error' }, REVENUE_EXT.holdReason, 'Billed to the wrong visit');
  assert.deepEqual(tags(await run(voided, posted, 'Practitioner/biller')), ['reversal-pending', 'status-entered-in-error']);
  assert.deepEqual(tags(await run(withExt(voided, REVENUE_EXT.ledgerReversal, 'reversal:charge:ci1:2'), voided, 'ClientApplication/worker')), ['status-entered-in-error']);
});

test('holds and voids need a reason; charges are never deleted', async () => {
  await assert.rejects(run(charge({ status: 'not-billable' }), charge(), 'Practitioner/biller'), /reason/);
  assert.ok(await run(withExt(charge({ status: 'not-billable' }), REVENUE_EXT.holdReason, 'Awaiting prior auth'), charge(), 'Practitioner/biller'));
  const del = { ...event(charge()), headers: { 'X-Medplum-Deleted-Resource': 'ChargeItem/ci1' } } as BotEvent<ChargeItem>;
  await assert.rejects(chargeRules(rulesClient(charge()), del), /never deleted/);
});

test('charge capture: one ChargeItem per billed code from a signed note, none for addenda', async () => {
  const note: NoteData = { ...emptyNote(findTemplate('med-mgmt')!, 'video'), diagnoses: [{ code: 'F33.1', display: 'Major depressive disorder, recurrent, moderate' }] } as NoteData;
  note.billing = { ...note.billing, primaryCode: '99214', mdm: 'moderate' } as NoteData['billing'];
  const comp: Composition = {
    resourceType: 'Composition', id: 'c1', status: 'final', type: { text: 'Note' }, date: '2026-10-01T17:00:00Z', title: 'Note', author: [{ reference: 'Practitioner/prov' }],
    subject: { reference: 'Patient/p' }, encounter: { reference: 'Encounter/e' }, attester: [{ mode: 'legal', party: { reference: 'Practitioner/prov' }, time: '2026-10-01T17:00:00Z' }],
    extension: [{ url: EXT.noteData, valueString: JSON.stringify(note) }],
  };
  const created: ChargeItem[] = [];
  const medplum = {
    readReference: async (r: { reference: string }) => (r.reference.startsWith('Encounter') ? ({ resourceType: 'Encounter', id: 'e', status: 'finished', class: { code: 'VR' }, period: { start: '2026-10-01T16:00:00Z' } } as Encounter) : ({ resourceType: 'Patient', id: 'p' } as Patient)),
    searchOne: async (type: string) => (type === 'Basic' ? settingsBasic : { resourceType: 'Coverage', id: 'cov', status: 'active', payor: [{ display: 'Plan', identifier: { system: 'https://fhir.teleemon.com/identifier/payer', value: 'payer:synthetic-commercial' } }] }),
    createResourceIfNoneExist: async (c: ChargeItem, q: string) => {
      assert.match(q, /charge:c1:/);
      created.push(c);
      return c;
    },
  } as unknown as MedplumClient;
  const out = await chargeCapture(medplum, event(comp, 'Practitioner/prov'));
  assert.equal(out.length, 1);
  assert.equal(created[0].status, 'planned');
  assert.equal(created[0].code?.coding?.[0]?.code, '99214');
  assert.equal(created[0].extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString, 'payer:synthetic-commercial');
  assert.deepEqual(await chargeCapture(medplum, event({ ...comp, relatesTo: [{ code: 'appends', targetReference: { reference: 'Composition/c0' } }] })), []);
  assert.deepEqual(await chargeCapture(medplum, event({ ...comp, status: 'preliminary' })), []);
});

// --- claim-rules ---------------------------------------------------------------------------------

const claimOf = (status: string, over: Partial<Claim> = {}): Claim => ({
  resourceType: 'Claim', id: 'cl1', status: 'active', use: 'claim', created: '2026-10-02', type: { coding: [{ code: 'professional' }] },
  patient: { reference: 'Patient/p' }, provider: { reference: 'Practitioner/prov' }, priority: { coding: [{ code: 'normal' }] },
  insurance: [{ sequence: 1, focal: true, coverage: { reference: 'Coverage/cov' } }],
  item: [{ sequence: 1, productOrService: { coding: [{ system: CPT_SYSTEM, code: '99214' }] }, encounter: [{ reference: 'Encounter/e' }], extension: [{ url: REVENUE_EXT.chargeItem, valueReference: { reference: 'ChargeItem/ci1' } }] }],
  extension: [{ url: REVENUE_EXT.claimStatus, valueCode: status }, { url: REVENUE_EXT.billingPayer, valueString: 'payer:synthetic-commercial' }],
  ...over,
});
const claimClient = (before?: Claim, extra: Record<string, unknown> = {}): MedplumClient => {
  const searchResources = (extra.searchResources as ((type: string, query: Record<string, string>) => Promise<Claim[]>) | undefined) ?? (async () => []);
  const readReference = (extra.readReference as ((ref: { reference: string }) => Promise<unknown>) | undefined) ?? (async (r: { reference: string }) => (r.reference.startsWith('ChargeItem') ? charge({ status: 'billable' }) : notFound()));
  return ({
  readResource: before ? async () => before : notFound,
  readReference,
  searchResourcePages: async function* (type: string, query: Record<string, string>) { yield await searchResources(type, query); },
  searchResources,
  searchOne: async () => settingsBasic,
  ...extra,
  }) as unknown as MedplumClient;
};
const runClaim = (c: Claim, before?: Claim, author = 'Practitioner/biller', extra?: Record<string, unknown>) => claimRules(claimClient(before, extra), event(c, author));
const claimReplacement = (id = 'replacement', originalId = 'original'): Claim => claimOf('draft', {
  id,
  related: [{ relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship', code: 'prior' }] }, claim: { reference: `Claim/${originalId}` } }],
});

test('claims start as drafts, move in order, and payer outcomes come only from the clearinghouse', async () => {
  await assert.rejects(runClaim(claimOf('submitted', { id: undefined })), /starts as a draft/);
  assert.equal(await runClaim(claimOf('draft', { id: undefined })), true);
  await assert.rejects(runClaim(claimOf('submitted'), claimOf('draft')), /cannot move from draft to submitted/);
  await assert.rejects(runClaim(claimOf('accepted'), claimOf('submitted')), /from the clearinghouse/);
  assert.equal(await runClaim(claimOf('accepted'), claimOf('submitted'), 'ClientApplication/worker'), true);
});

test('a client-written scrub result is refused; the server scrubs on submission', async () => {
  const forged = claimOf('draft', { extension: [...claimOf('draft').extension!, { url: REVENUE_EXT.scrubResult, valueString: JSON.stringify({ at: 'x', hash: 'x', findings: [] }) }] });
  await assert.rejects(runClaim(forged, claimOf('draft')), /recorded by the server/);
  await assert.rejects(runClaim(forged, undefined), /recorded by the server|starts as a draft/);
  // Server scrub with no coverage on record: refused, never trusted.
  await assert.rejects(runClaim(claimOf('scrubbed'), claimOf('draft'), 'Practitioner/biller', { readReference: async (r: { reference: string }) => (r.reference.startsWith('ChargeItem') ? charge({ status: 'billable' }) : notFound()) }), /incomplete|scrubber/);
});

test('submitted claims are locked; one live claim per visit; lines must be released charges', async () => {
  const submitted = claimOf('submitted');
  await assert.rejects(runClaim({ ...submitted, item: [{ ...submitted.item![0], productOrService: { coding: [{ system: CPT_SYSTEM, code: '99215' }] } }] }, submitted, 'ClientApplication/worker'), /cannot be edited/);
  await assert.rejects(runClaim(claimOf('draft'), claimOf('draft'), 'Practitioner/biller', { searchResources: async () => [claimOf('submitted', { id: 'other' })] }), /already has a live claim/);
  await assert.rejects(runClaim(claimOf('draft'), claimOf('draft'), 'Practitioner/biller', { readReference: async () => charge({ status: 'planned' }) }), /not been released/);
  const del = { ...event(claimOf('draft')), headers: { 'X-Medplum-Deleted-Resource': 'Claim/cl1' } } as BotEvent<Claim>;
  await assert.rejects(claimRules(claimClient(claimOf('draft')), del), /never deleted/);
});

test('a valid frequency-7 replacement names the eligible original claim for the same patient, visit and payer', async () => {
  const original = claimOf('submitted', { id: 'original' });
  const replacement = claimReplacement();
  assert.equal(await runClaim(replacement, undefined, 'Practitioner/biller', {
    readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? original : charge({ status: 'billable' }),
    searchResources: async () => [original],
  }), true);
});

test('a replacement cannot bypass the live-claim guard with a missing, unrelated or ineligible original', async () => {
  const original = claimOf('submitted', { id: 'original' });
  const replacement = claimReplacement();
  const refs = { readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? original : r.reference.startsWith('Claim/') ? notFound() : charge({ status: 'billable' }), searchResources: async () => [original] };
  await assert.rejects(runClaim(claimReplacement('bad-ref', 'NoSuchClaim'), undefined, 'Practitioner/biller', refs), /does not exist or cannot be read/);
  await assert.rejects(runClaim(claimOf('draft', { related: [{ claim: { reference: 'Encounter/e' } }] }), undefined, 'Practitioner/biller', refs), /must name an existing original claim/);
  await assert.rejects(runClaim(replacement, undefined, 'Practitioner/biller', { ...refs, readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? claimOf('draft', { id: 'original' }) : charge({ status: 'billable' }) }), /not in a status that can be replaced/);
  await assert.rejects(runClaim(replacement, undefined, 'Practitioner/biller', { ...refs, readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? claimOf('submitted', { id: 'original', patient: { reference: 'Patient/other' } }) : charge({ status: 'billable' }) }), /different patient/);
  await assert.rejects(runClaim(replacement, undefined, 'Practitioner/biller', { ...refs, readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? claimOf('submitted', { id: 'original', item: [{ ...claimOf('submitted').item![0], encounter: [{ reference: 'Encounter/other' }] }] }) : charge({ status: 'billable' }) }), /different visit/);
  await assert.rejects(runClaim(replacement, undefined, 'Practitioner/biller', { ...refs, readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? claimOf('submitted', { id: 'original', extension: [{ url: REVENUE_EXT.claimStatus, valueCode: 'submitted' }, { url: REVENUE_EXT.billingPayer, valueString: 'payer:other' }] }) : charge({ status: 'billable' }) }), /same payer/);
});

test('a claim cannot bypass replacement checks by omitting the visit context on its charge', async () => {
  await assert.rejects(runClaim(claimReplacement(), undefined, 'Practitioner/biller', {
    readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? claimOf('submitted', { id: 'original' }) : charge({ status: 'billable', context: undefined }),
    searchResources: async () => [claimOf('submitted', { id: 'original' })],
  }), /Every charge on a claim belongs to one visit/);
});

test('a second live replacement of the same original is refused', async () => {
  const original = claimOf('submitted', { id: 'original' });
  const sibling = claimReplacement('sibling');
  await assert.rejects(runClaim(claimReplacement(), undefined, 'Practitioner/biller', {
    readReference: async (r: { reference: string }) => r.reference === 'Claim/original' ? original : charge({ status: 'billable' }),
    searchResources: async () => [original, sibling],
  }), /already has a live replacement/);
});
