// Worker regressions for durable manual ERA -> FHIR Claim status projection.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MedplumClient } from '@medplum/core';
import type { Claim, Task } from '@medplum/fhirtypes';
import { REVENUE_EXT, claimStatusOf } from '@teleemon/core';
import { processClaimProjections } from '../services/worker/src/billing';
import type { BillingCounts } from '../services/worker/src/billing';
import type { ClaimProjectionJob, ClaimProjectionPage, LedgerClient } from '../services/worker/src/ledgerClient';

const NOW = new Date('2026-10-18T10:00:00.000Z');
const JOB_TIME = '2026-10-18T09:00:00.000Z';
const BASE_JOB: ClaimProjectionJob = {
  id: '10000000-0000-4000-8000-000000000001',
  sourceKey: 'era:TRACE-1:PCN-1',
  journalId: '20000000-0000-4000-8000-000000000001',
  claimRef: 'Claim/claim-1',
  targetStatus: 'paid',
  occurredAt: JOB_TIME,
  reversed: false,
};

function makeClaim(status: string, lastUpdated = '2026-10-18T08:00:00.000Z'): Claim {
  return {
    resourceType: 'Claim',
    id: 'claim-1',
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    created: '2026-10-17T08:00:00.000Z',
    provider: { reference: 'Practitioner/provider-1' },
    priority: { coding: [{ code: 'normal' }] },
    patient: { reference: 'Patient/patient-1' },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: 'Coverage/coverage-1' } }],
    meta: { versionId: '1', lastUpdated },
    extension: [{ url: REVENUE_EXT.claimStatus, valueCode: status }],
  };
}

function counts(): BillingCounts {
  return {
    charges: 0, submitted: 0, submissionsRefused: 0, acknowledged: 0, rejected: 0,
    remittances: 0, denials: 0, exceptions: 0, eligibilityChecks: 0, eligibilityRequestsQueued: 0,
    statements: 0, statementNotices: 0, refundReviews: 0, smallBalances: 0, failures: 0,
  };
}

function harness(initial: Claim, initialJobs: ClaimProjectionJob[], pages?: Map<string, ClaimProjectionPage>) {
  const claims = new Map([[initial.id as string, initial]]);
  const tasks = new Map<string, Task>();
  const completed: string[] = [];
  const writes: Array<{ claim: Claim; ifMatch?: string }> = [];
  let updateInterceptor: (() => void) | undefined;
  const ledger = {
    async pendingClaimProjections(after?: string) {
      return pages?.get(after ?? 'start') ?? (after ? { jobs: [] } : { jobs: initialJobs });
    },
    async completeClaimProjection(id: string) {
      completed.push(id);
      return { ok: true as const };
    },
  } as unknown as LedgerClient;
  const medplum = {
    async readResource(_type: string, id: string) {
      const found = claims.get(id);
      if (!found) throw new Error(`Claim/${id} not found`);
      return found;
    },
    async updateResource(resource: Claim | Task, options?: { headers?: Record<string, string> }) {
      const ifMatch = options?.headers?.['If-Match'];
      if (resource.resourceType === 'Claim') {
        updateInterceptor?.();
        writes.push({ claim: resource, ifMatch });
      }
      const version = resource.meta?.versionId === '1' ? '2' : `${Number(resource.meta?.versionId ?? 0) + 1}`;
      const saved = { ...resource, meta: { ...resource.meta, versionId: version, lastUpdated: NOW.toISOString() } };
      if (resource.resourceType === 'Claim') claims.set(resource.id as string, saved as Claim);
      else {
        const identifier = resource.identifier?.[0];
        const key = identifier ? `${identifier.system}|${identifier.value}` : undefined;
        if (key) tasks.set(key, saved as Task);
      }
      return saved;
    },
    async searchOne(type: string, query: { identifier?: string }) {
      if (type !== 'Task' || !query.identifier) return undefined;
      return tasks.get(query.identifier);
    },
    async createResourceIfNoneExist(resource: Task) {
      const identifier = resource.identifier?.[0];
      const key = identifier ? `${identifier.system}|${identifier.value}` : undefined;
      const saved = { ...resource, id: `task-${tasks.size + 1}`, meta: { versionId: '1', lastUpdated: NOW.toISOString() } };
      if (key) tasks.set(key, saved);
      return saved;
    },
  } as unknown as MedplumClient;
  return { medplum, ledger, claims, tasks, completed, writes, setUpdateInterceptor: (fn?: () => void) => { updateInterceptor = fn; } };
}

test('manual ERA projection writes an eligible Claim with If-Match before acknowledging the ledger job', async () => {
  const h = harness(makeClaim('accepted'), [BASE_JOB]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].ifMatch, 'W/"1"');
  assert.equal(claimStatusOf(h.claims.get('claim-1') as Claim), 'paid');
  assert.deepEqual(h.completed, [BASE_JOB.id]);
});

test('a retry after the FHIR write sees the target status and acknowledges without a duplicate write', async () => {
  const h = harness(makeClaim('paid', NOW.toISOString()), [BASE_JOB]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());

  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.completed, [BASE_JOB.id]);
});

test('denied claims stay pending for a human appeal decision', async () => {
  const h = harness(makeClaim('denied'), [BASE_JOB]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());

  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.completed, []);
  assert.equal(h.tasks.size, 1);
});

test('an appealed denied claim can be projected after the human review step', async () => {
  const h = harness(makeClaim('denied'), [BASE_JOB]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  h.claims.set('claim-1', makeClaim('appealed', '2026-10-18T09:30:00.000Z'));

  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.equal(claimStatusOf(h.claims.get('claim-1') as Claim), 'paid');
  assert.deepEqual(h.completed, [BASE_JOB.id]);
  const reviewTask = [...h.tasks.values()][0];
  assert.equal(reviewTask.status, 'completed');
});

test('a newer claim update is not overwritten by an older projection', async () => {
  const h = harness(makeClaim('partially-paid', '2026-10-18T09:30:00.000Z'), [BASE_JOB]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());

  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.completed, []);
  assert.equal(h.tasks.size, 1);
});

test('an If-Match conflict preserves the concurrent claim decision and leaves the job pending', async () => {
  const h = harness(makeClaim('accepted'), [BASE_JOB]);
  h.setUpdateInterceptor(() => {
    h.setUpdateInterceptor(undefined);
    h.claims.set('claim-1', makeClaim('partially-paid', NOW.toISOString()));
    throw Object.assign(new Error('version conflict'), { status: 412 });
  });

  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.equal(claimStatusOf(h.claims.get('claim-1') as Claim), 'partially-paid');
  assert.deepEqual(h.completed, []);
  assert.equal(h.writes.length, 0);

  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.equal(claimStatusOf(h.claims.get('claim-1') as Claim), 'partially-paid');
  assert.deepEqual(h.completed, []);
  assert.equal(h.writes.length, 0);
});

test('reversed ledger events are acknowledged for review without changing Claim status', async () => {
  const h = harness(makeClaim('accepted'), [{ ...BASE_JOB, reversed: true }]);
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());

  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.completed, [BASE_JOB.id]);
  assert.equal(h.tasks.size, 1);
});

test('an FHIR write failure leaves the job pending and a later pass can complete it', async () => {
  const h = harness(makeClaim('accepted'), [BASE_JOB]);
  let failWrite = true;
  h.setUpdateInterceptor(() => { if (failWrite) throw new Error('simulated FHIR outage'); });

  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.deepEqual(h.completed, []);
  assert.equal(h.tasks.size, 1);

  failWrite = false;
  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.deepEqual(h.completed, [BASE_JOB.id]);
  assert.equal(claimStatusOf(h.claims.get('claim-1') as Claim), 'paid');
});

test('cursor traversal continues after an older review-held job', async () => {
  const accepted = { ...BASE_JOB, id: '10000000-0000-4000-8000-000000000002', claimRef: 'Claim/claim-2', sourceKey: 'era:TRACE-2:PCN-2' };
  const pages = new Map<string, ClaimProjectionPage>([
    ['start', { jobs: [BASE_JOB], nextCursor: 'page-2' }],
    ['page-2', { jobs: [accepted] }],
  ]);
  const h = harness(makeClaim('denied'), [BASE_JOB], pages);
  h.claims.set('claim-2', { ...makeClaim('accepted'), id: 'claim-2' });

  await processClaimProjections(h.medplum, h.ledger, NOW, counts());
  assert.deepEqual(h.completed, [accepted.id]);
  assert.equal(claimStatusOf(h.claims.get('claim-2') as Claim), 'paid');
  assert.equal(h.tasks.size, 1);
});
