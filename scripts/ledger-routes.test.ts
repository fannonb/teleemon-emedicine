import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { Claim, Coverage, Encounter, Patient, Practitioner } from '@medplum/fhirtypes';
import { PAYER_IDENTIFIER_SYSTEM, REVENUE_EXT } from '@teleemon/core';
import { buildRouter } from '../services/ledger/src/index';
import type { StaffCaller } from '../services/ledger/src/auth';
import type { LedgerStore } from '../services/ledger/src/store';

const PATIENT = { resourceType: 'Patient', id: 'patient-1' } as Patient;
const COVERAGE = {
  resourceType: 'Coverage', id: 'coverage-1', beneficiary: { reference: 'Patient/patient-1' },
  payor: [{ identifier: { system: PAYER_IDENTIFIER_SYSTEM, value: 'payer:synthetic-commercial' } }],
} as unknown as Coverage;
const ENCOUNTER = { resourceType: 'Encounter', id: 'encounter-1', subject: { reference: 'Patient/patient-1' } } as unknown as Encounter;
const CLAIM = {
  resourceType: 'Claim', id: 'claim-1', patient: { reference: 'Patient/patient-1' },
  insurance: [{ sequence: 1, focal: true, coverage: { reference: 'Coverage/coverage-1' } }],
  item: [{ sequence: 1, encounter: [{ reference: 'Encounter/encounter-1' }], extension: [{ url: REVENUE_EXT.chargeItem, valueReference: { reference: 'ChargeItem/charge-1' } }] }],
  extension: [{ url: REVENUE_EXT.billingPayer, valueString: 'payer:synthetic-commercial' }],
} as unknown as Claim;
const CHARGE = { resourceType: 'ChargeItem', id: 'charge-1', subject: { reference: 'Patient/patient-1' }, context: { reference: 'Encounter/encounter-1' } } as any;
const PRACTITIONER = { resourceType: 'Practitioner', id: 'biller-1' } as Practitioner;

function rig() {
  const reads: string[] = [];
  const calls: string[] = [];
  const medplum = {
    async readResource(type: string, id: string) {
      reads.push(`${type}/${id}`);
      const resources: Record<string, unknown> = {
        'Patient/patient-1': PATIENT,
        'Patient/patient-2': { resourceType: 'Patient', id: 'patient-2' },
        'Coverage/coverage-1': COVERAGE,
        'Encounter/encounter-1': ENCOUNTER,
        'Encounter/encounter-2': { ...ENCOUNTER, id: 'encounter-2' },
        'Claim/claim-1': CLAIM,
        'ChargeItem/charge-1': CHARGE,
      };
      const value = resources[`${type}/${id}`];
      if (!value) throw new Error('not found');
      return value;
    },
  };
  const caller: StaffCaller = { kind: 'staff', actor: 'Practitioner/biller-1', roles: ['biller'], medplum: medplum as any };
  const store = {
    async postPatientPayment(...args: unknown[]) { calls.push('patient-payment'); return [{ journalId: 'pay-j1', idempotencyKey: 'payment:test', created: true }]; },
    async postWithinPayerClaimLimit(...args: unknown[]) { calls.push('payer-limit'); return [{ journalId: 'j1', idempotencyKey: 'key', created: true }]; },
    async postEraWithProjection(...args: unknown[]) { calls.push('era-projection'); return { journalId: 'j2', idempotencyKey: 'era:key', created: true }; },
    async remittance() { return { traceNumber: 'trace-1', payerRef: 'payer:synthetic-commercial', paidCents: 900, paymentDate: '2026-10-17', claimCount: 1 }; },
    async claimProjectionJobs() { calls.push('projection-page'); return { jobs: [], nextCursor: undefined }; },
    async completeClaimProjection() { calls.push('projection-complete'); return true; },
  } as unknown as LedgerStore;
  const router = buildRouter(store, () => new Date('2026-10-17T12:00:00Z'), { authenticateStaff: async () => caller });
  return { router, reads, calls };
}

async function call(router: ReturnType<typeof buildRouter>, url: string, body: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  const path = url.split('?')[0];
  Object.assign(req, { method: path === '/api/ledger/internal/claim-projections' ? 'GET' : 'POST', url, headers });
  let status = 0;
  let responseBody = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(value?: string) { responseBody = value ?? ''; },
  } as unknown as ServerResponse;
  await router.handle(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : undefined };
}

const transfer = (over: Record<string, unknown> = {}) => ({
  key: 'transfer-key-01', patientId: 'patient-1', claimId: 'claim-1', encounterId: 'encounter-1',
  payerRef: 'payer:synthetic-commercial', cents: 500, ...over,
});

test('transfer route derives and checks the authenticated FHIR claim chain before posting', async () => {
  const { router, calls, reads } = rig();
  const response = await call(router, '/api/ledger/transfers', transfer());
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['payer-limit']);
  for (const resource of ['Patient/patient-1', 'Claim/claim-1', 'Coverage/coverage-1', 'Encounter/encounter-1', 'ChargeItem/charge-1']) assert.ok(reads.includes(resource), resource);
});

test('transfer route rejects a cross-patient claim before ledger posting', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/transfers', transfer({ patientId: 'patient-2' }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('transfer route rejects a caller supplied payer that differs from Claim and Coverage', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/transfers', transfer({ payerRef: 'payer:other' }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('transfer route rejects a visit unrelated to the claim', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/transfers', transfer({ encounterId: 'encounter-2' }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('payer adjustment derives its patient from the claim and checks the visit link', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/payer-adjustments', {
    key: 'adjust-key-01', claimId: 'claim-1', encounterId: 'encounter-1', payerRef: 'payer:synthetic-commercial', cents: 200, reason: 'denial-final',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['payer-limit']);
});

test('staff and portal receipt routes delegate splitting and replay checks to the transactional store', async () => {
  const previous = process.env.LEDGER_INTERNAL_TOKEN;
  process.env.LEDGER_INTERNAL_TOKEN = 'synthetic-ledger-internal-token-for-tests';
  try {
    const { router, calls } = rig();
    const frontDesk = await call(router, '/api/ledger/patients/patient-1/payments', { method: 'check', receipt: 'CHECK-123', cents: 1000 });
    assert.equal(frontDesk.status, 200);
    const portal = await call(router, '/api/ledger/internal/payments', { paymentId: 'stripe-payment-123', patientRef: 'Patient/patient-1', cents: 1000 }, { authorization: `Bearer ${process.env.LEDGER_INTERNAL_TOKEN}` });
    assert.equal(portal.status, 200);
    assert.deepEqual(calls, ['patient-payment', 'patient-payment']);
  } finally {
    if (previous === undefined) delete process.env.LEDGER_INTERNAL_TOKEN;
    else process.env.LEDGER_INTERNAL_TOKEN = previous;
  }
});

test('manual ERA route refuses a cross-patient claim before posting or enqueueing a projection', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/remittances/trace-1/claims', {
    claimRef: 'Claim/claim-1', patientRef: 'Patient/patient-2', encounterRef: 'Encounter/encounter-1',
    payerClaimControl: 'payer-control-1', paidCents: 100, contractualCents: 0, patientResponsibilityCents: 0,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('manual ERA route persists a Claim status projection together with the posted line', async () => {
  const { router, calls } = rig();
  const response = await call(router, '/api/ledger/remittances/trace-1/claims', {
    claimRef: 'Claim/claim-1', patientRef: 'Patient/patient-1', encounterRef: 'Encounter/encounter-1',
    payerClaimControl: 'payer-control-1', paidCents: 100, contractualCents: 0, patientResponsibilityCents: 0,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['era-projection']);
  assert.deepEqual(response.body, [{ journalId: 'j2', idempotencyKey: 'era:key', created: true }], 'P33 continues to receive the posting-results array used by its replay UI');
});

test('projection outbox endpoints require the internal token and expose stable pages', async () => {
  const previous = process.env.LEDGER_INTERNAL_TOKEN;
  process.env.LEDGER_INTERNAL_TOKEN = 'synthetic-ledger-internal-token-for-tests';
  try {
    const { router, calls } = rig();
    const denied = await call(router, '/api/ledger/internal/claim-projections', {});
    assert.equal(denied.status, 401);
    const listed = await call(router, '/api/ledger/internal/claim-projections?after=opaque', {}, { authorization: `Bearer ${process.env.LEDGER_INTERNAL_TOKEN}` });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { jobs: [] });
    const completed = await call(router, '/api/ledger/internal/claim-projections/00000000-0000-4000-8000-000000000001/complete', {}, { authorization: `Bearer ${process.env.LEDGER_INTERNAL_TOKEN}` });
    assert.equal(completed.status, 200);
    assert.deepEqual(calls, ['projection-page', 'projection-complete']);
  } finally {
    if (previous === undefined) delete process.env.LEDGER_INTERNAL_TOKEN;
    else process.env.LEDGER_INTERNAL_TOKEN = previous;
  }
});

test('the A/R route says whether its capped entry read covered the whole ledger', async () => {
  // A biller reading /ar; the store reports the true entry count so truncation is visible.
  const routerFor = (totalEntries: number) => {
    const store = {
      async entries() { return []; },
      async totals() { return { entrySumCents: 0, journals: 0, entries: totalEntries, unbalancedJournals: 0 }; },
    } as unknown as LedgerStore;
    const caller: StaffCaller = { kind: 'staff', actor: 'Practitioner/biller-1', roles: ['biller'], medplum: {} as StaffCaller['medplum'] };
    return buildRouter(store, () => new Date('2026-10-17T12:00:00Z'), { authenticateStaff: async () => caller });
  };
  const getAr = async (router: ReturnType<typeof buildRouter>): Promise<{ status: number; body: { complete?: boolean; rows: unknown[] } }> => {
    const req = Readable.from([]) as IncomingMessage;
    Object.assign(req, { method: 'GET', url: '/api/ledger/ar', headers: {} });
    let status = 0;
    let body = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(value?: string) { body = value ?? ''; } } as unknown as ServerResponse;
    await router.handle(req, res);
    return { status, body: body ? JSON.parse(body) : { rows: [] } };
  };
  assert.equal((await getAr(routerFor(0))).body.complete, true, 'a ledger that fits the read is complete');
  const partial = await getAr(routerFor(3));
  assert.equal(partial.status, 200);
  assert.equal(partial.body.complete, false, 'a read capped below the true entry count is reported as incomplete');
  assert.deepEqual(partial.body.rows, []);
});
