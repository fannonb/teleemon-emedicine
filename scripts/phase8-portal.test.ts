// Phase 8 (X08) portal bill pay: amount rules, full-access rules, idempotent charges, the ledger
// posting and its fallback, the rate limit, and plain-language descriptions. No servers: the ledger,
// Medplum and Stripe are replaced with in-memory fakes (Stripe's fetch is stubbed for one test).

import assert from 'node:assert/strict';
import test from 'node:test';
import type { MedplumClient } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import type { CardOnFile, JournalKind } from '@teleemon/core';
import { EXT } from '@teleemon/core';
import { billingView, dayIn, patientDescription, payBalance, payProblem, recentActivity } from '../services/portal/src/billing';
import type { LedgerClient, LedgerEntry, PatientBalance, PaymentPosting } from '../services/portal/src/ledgerClient';
import { HttpError, RateLimiter } from '../services/portal/src/http';
import { SandboxPayments, StripeTestPayments } from '../services/portal/src/payments';
import type { PortalSession } from '../services/portal/src/session';

// --- Fixtures ----------------------------------------------------------------------------------

const PATIENT_ID = 'synthetic-patient-1';
const PATIENT_REF = `Patient/${PATIENT_ID}`;
const KEY = '6f1c2b3a-1111-4222-8333-444455556666';
const uuid = (i: number): string => `00000000-0000-4000-8000-00000000000${i}`;

const sandboxCard = (last4 = '4242'): CardOnFile => ({
  provider: 'sandbox', customer: 'sandbox_cus_test', paymentMethod: 'sandbox_pm_test', brand: 'visa', last4, expMonth: 12, expYear: 2029, savedAt: '2026-10-01T00:00:00Z',
});

function patient(card: CardOnFile | undefined): Patient {
  return {
    resourceType: 'Patient', id: PATIENT_ID, name: [{ given: ['Synthetic'], family: 'Patient' }], birthDate: '1980-01-01',
    extension: card ? [{ url: EXT.cardOnFile, valueString: JSON.stringify(card) }] : [],
  };
}

function session(opts: { access?: 'self' | 'full' | 'limited'; card?: CardOnFile | null } = {}): PortalSession {
  const card = opts.card === null ? undefined : (opts.card ?? sandboxCard());
  return { actor: `Patient/${PATIENT_ID}`, actorName: 'Synthetic Patient', patient: patient(card), patientRef: PATIENT_REF, access: opts.access ?? 'self' };
}

/** Records every charge the processor would see; the sandbox still decides the outcome. */
class CountingPayments extends SandboxPayments {
  readonly charged: number[] = [];
  override async charge(card: CardOnFile, cents: number, idempotencyKey: string) {
    this.charged.push(cents);
    return super.charge(card, cents, idempotencyKey);
  }
}

/** A ledger that, like the real one, ignores a replayed paymentId. */
class FakeLedger implements LedgerClient {
  readonly posted = new Map<string, number>();
  constructor(private owed: number, private readonly failPosts = false, private readonly entries: LedgerEntry[] = []) {}
  get owedCents(): number {
    return this.owed;
  }
  async balance(patientRef: string): Promise<PatientBalance> {
    return { patientRef, owedCents: this.owed, creditCents: 0, netCents: this.owed, entries: this.entries };
  }
  async postPayment(p: PaymentPosting): Promise<void> {
    if (this.failPosts) throw new HttpError(503, 'Billing is not available right now. Please try again in a few minutes, or call us.', 'ledger-unavailable');
    if (this.posted.has(p.paymentId)) return;
    this.posted.set(p.paymentId, p.cents);
    this.owed -= p.cents;
  }
}

function harness(opts: { owed: number; failPosts?: boolean; invoices?: unknown[]; entries?: LedgerEntry[] }) {
  const ledger = new FakeLedger(opts.owed, opts.failPosts ?? false, opts.entries ?? []);
  const payments = new CountingPayments();
  const tasks: Task[] = [];
  const service = {
    createResourceIfNoneExist: async (task: Task) => {
      tasks.push(task);
      return task;
    },
    searchResources: async () => opts.invoices ?? [],
  } as unknown as MedplumClient;
  return { ledger, payments, tasks, deps: { service, payments, ledger, payLimiter: new RateLimiter(5, 3600000) } };
}

/** Ledger lines as the balance route returns them, with the internal fields it also carries. */
const line = (over: Record<string, unknown>): LedgerEntry =>
  ({
    postedAt: '2026-10-01T16:00:00Z', source: 'era:TRACE-123', memo: 'approved by Practitioner/staff-9', postedBy: 'Practitioner/staff-9', reversed: false,
    claimRef: 'Claim/claim-1', encounterRef: 'Encounter/enc-1', chargeItemRef: 'ChargeItem/ci-1', ...over,
  }) as unknown as LedgerEntry;
const own = { kind: 'patient_receivable', patientRef: PATIENT_REF } as const;
const credit = { kind: 'patient_credit', patientRef: PATIENT_REF } as const;

// --- Amount and access rules -------------------------------------------------------------------

test('amount rules refuse zero, negatives, fractions, non-numbers and anything over the balance', () => {
  assert.match(payProblem(0, 5000) ?? '', /greater than \$0\.00/);
  assert.match(payProblem(-100, 5000) ?? '', /greater than \$0\.00/);
  assert.match(payProblem(12.5, 5000) ?? '', /dollars and cents/);
  assert.match(payProblem('1000', 5000) ?? '', /dollars and cents/);
  assert.match(payProblem(5001, 5000) ?? '', /up to \$50\.00/);
  assert.match(payProblem(100, 0) ?? '', /Nothing is owed/);
  assert.equal(payProblem(5000, 5000), undefined, 'the full balance can be paid');
  assert.equal(payProblem(1, 5000), undefined, 'a partial payment can be made');
});

test('limited proxies are refused on the balance and on payment, before any charge', async () => {
  const h = harness({ owed: 5000 });
  const limited = session({ access: 'limited' });
  await assert.rejects(billingView(h.deps, limited), (e: unknown) => e instanceof HttpError && e.status === 403);
  await assert.rejects(payBalance(h.deps, limited, { cents: 1000, key: KEY }), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.deepEqual(h.payments.charged, []);
  assert.equal(h.ledger.posted.size, 0);
});

test('payment requests that are malformed, over the balance, or without a usable card never reach the processor', async () => {
  const h = harness({ owed: 5000 });
  for (const body of [{ cents: 0, key: KEY }, { cents: -100, key: KEY }, { cents: 10.5, key: KEY }, { cents: 6000, key: KEY }, { cents: 1000, key: 'not-a-key' }]) {
    await assert.rejects(payBalance(h.deps, session(), body), (e: unknown) => e instanceof HttpError && e.status === 400);
  }
  await assert.rejects(payBalance(h.deps, session({ card: null }), { cents: 1000, key: KEY }), (e: unknown) => e instanceof HttpError && e.code === 'no-card');
  await assert.rejects(payBalance(h.deps, session({ card: { ...sandboxCard(), provider: 'stripe' } }), { cents: 1000, key: KEY }), (e: unknown) => e instanceof HttpError && e.code === 'card-mismatch');
  assert.deepEqual(h.payments.charged, []);
  assert.equal(h.ledger.posted.size, 0);
});

test('a declined card is refused in plain words and nothing is posted', async () => {
  const h = harness({ owed: 5000 });
  await assert.rejects(payBalance(h.deps, session({ card: sandboxCard('0002') }), { cents: 1000, key: KEY }), (e: unknown) => e instanceof HttpError && e.status === 402 && e.code === 'card-declined');
  assert.equal(h.ledger.posted.size, 0);
  assert.equal(h.ledger.owedCents, 5000);
});

test('the portal allows five payment attempts an hour, then refuses', async () => {
  const h = harness({ owed: 100000 });
  for (let i = 1; i <= 5; i++) assert.equal((await payBalance(h.deps, session(), { cents: 100, key: uuid(i) })).status, 'posted');
  await assert.rejects(payBalance(h.deps, session(), { cents: 100, key: uuid(6) }), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(h.payments.charged.length, 5);
});

// --- Charges and the ledger --------------------------------------------------------------------

test('a sandbox charge is deterministic for the same key and amount, and differs otherwise', async () => {
  const sandbox = new SandboxPayments();
  const first = await sandbox.charge(sandboxCard(), 1000, `portal-pay:${PATIENT_ID}:${KEY}`);
  const again = await sandbox.charge(sandboxCard(), 1000, `portal-pay:${PATIENT_ID}:${KEY}`);
  assert.equal(first.status, 'succeeded');
  assert.match(first.chargeId, /^sbx_[0-9a-f]{24}$/);
  assert.equal(again.chargeId, first.chargeId, 'the same key charges to the same id');
  assert.notEqual((await sandbox.charge(sandboxCard(), 1000, 'portal-pay:other:key')).chargeId, first.chargeId);
  assert.notEqual((await sandbox.charge(sandboxCard(), 2000, `portal-pay:${PATIENT_ID}:${KEY}`)).chargeId, first.chargeId, 'a different amount is a different charge');
  const declined = await sandbox.charge(sandboxCard('0002'), 1000, 'k');
  assert.equal(declined.status, 'declined');
  assert.match(declined.message ?? '', /declined/);
});

test('replaying the same payment request posts it to the ledger once', async () => {
  const h = harness({ owed: 5000 });
  const first = await payBalance(h.deps, session(), { cents: 1000, key: KEY });
  const again = await payBalance(h.deps, session(), { cents: 1000, key: KEY });
  assert.equal(first.status, 'posted');
  assert.equal(again.receiptId, first.receiptId);
  assert.equal(h.ledger.posted.size, 1);
  assert.equal(h.ledger.owedCents, 4000);
});

test('a charge that cannot be posted is queued for billing and still reported as on its way', async () => {
  const h = harness({ owed: 5000, failPosts: true });
  const result = await payBalance(h.deps, session(), { cents: 1500, key: KEY }, new Date('2026-10-18T12:00:00Z'));
  assert.equal(result.status, 'processing');
  assert.match(result.message, /do not need to pay again/);
  assert.match(result.message, new RegExp(`receipt ${result.receiptId}`));
  assert.equal(h.tasks.length, 1);
  const [task] = h.tasks;
  assert.equal(task.code?.coding?.[0]?.code, 'billing-error');
  assert.equal(task.focus?.reference, PATIENT_REF);
  assert.doesNotMatch(JSON.stringify(task), /sandbox_cus|sandbox_pm|4242|visa|last4|paymentMethod/);
});

test('a Stripe charge sends the portal key as Idempotency-Key and maps outcomes to plain words', async () => {
  const realFetch = globalThis.fetch;
  const seen: { headers: Record<string, string>; body: string }[] = [];
  const answers: { status: number; body: unknown }[] = [
    { status: 402, body: { error: { type: 'card_error', code: 'card_declined', payment_intent: { id: 'pi_test_declined' } } } },
    { status: 200, body: { id: 'pi_test_ok', status: 'succeeded', latest_charge: 'ch_test_ok' } },
  ];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const stripe = new StripeTestPayments('sk_test_synthetic', 'pk_test_synthetic');
    const card = { ...sandboxCard(), provider: 'stripe', customer: 'cus_test_1', paymentMethod: 'pm_test_1' } as CardOnFile;
    const declined = await stripe.charge(card, 1000, `portal-pay:${PATIENT_ID}:${KEY}`);
    assert.equal(declined.status, 'declined');
    assert.equal(declined.chargeId, 'pi_test_declined');
    assert.match(declined.message ?? '', /bank declined/);
    assert.equal(seen[0].headers['Idempotency-Key'], `portal-pay:${PATIENT_ID}:${KEY}`);
    assert.match(seen[0].body, /amount=1000/);
    assert.match(seen[0].body, /off_session=true/);
    assert.doesNotMatch(seen[0].body, /metadata|name=|email=/, 'the processor sees no name, email or metadata');

    const ok = await stripe.charge(card, 1000, `portal-pay:${PATIENT_ID}:${KEY}`);
    assert.deepEqual(ok, { chargeId: 'ch_test_ok', status: 'succeeded' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- What the patient sees ---------------------------------------------------------------------

test('every journal kind has a plain patient description with no codes, payers or staff', () => {
  const allowed = new Set(['Visit charge', 'Your payment', 'Insurance payment', 'Account adjustment', 'Credit applied', 'Insurance adjustment', 'Account update', 'Refund', 'Correction']);
  const kinds: JournalKind[] = ['charge', 'payment', 'adjustment', 'refund', 'transfer', 'reversal'];
  const keys = ['payment:sbx_1', 'era:TRACE123:CLM9', 'writeoff:wo-1', 'transfer:t-1', 'credit:c-1', 'refund:r-1:approved', 'reversal:x', 'payout:p-1'];
  for (const kind of kinds) for (const key of keys) assert.ok(allowed.has(patientDescription(kind, key)), `${kind} ${key}`);
  assert.equal(patientDescription('payment', 'payment:sbx_1'), 'Your payment');
  assert.equal(patientDescription('payment', 'era:TRACE123:CLM9'), 'Insurance payment');
  assert.equal(patientDescription('transfer', 'transfer:t-1'), 'Insurance adjustment');
});

test('recent activity nets each journal over the patient lines only, newest first, and leaks no internal detail', () => {
  const entries: LedgerEntry[] = [
    line({ journalId: 'j1', idempotencyKey: 'charge:ci-1:v1', kind: 'charge', occurredAt: '2026-10-01T15:00:00Z', account: own, cents: 14000 }),
    line({ journalId: 'j1', idempotencyKey: 'charge:ci-1:v1', kind: 'charge', occurredAt: '2026-10-01T15:00:00Z', account: { kind: 'insurance_receivable', payerRef: 'payer:acme' }, cents: -14000 }),
    line({ journalId: 'j2', idempotencyKey: 'era:TRACE-123:CLM9', kind: 'payment', occurredAt: '2026-10-05T15:00:00Z', account: own, cents: 2000 }),
    line({ journalId: 'j3', idempotencyKey: 'payment:sbx_abc', kind: 'payment', occurredAt: '2026-10-08T15:00:00Z', account: own, cents: -4000 }),
    line({ journalId: 'j3', idempotencyKey: 'payment:sbx_abc', kind: 'payment', occurredAt: '2026-10-08T15:00:00Z', account: credit, cents: -1000 }),
    line({ journalId: 'j4', idempotencyKey: 'credit:c-1', kind: 'transfer', occurredAt: '2026-10-09T15:00:00Z', account: credit, cents: 1000 }),
    line({ journalId: 'j4', idempotencyKey: 'credit:c-1', kind: 'transfer', occurredAt: '2026-10-09T15:00:00Z', account: own, cents: -1000 }),
    line({ journalId: 'j5', idempotencyKey: 'refund:r-1:approved', kind: 'refund', occurredAt: '2026-10-10T15:00:00Z', account: credit, cents: 500 }),
  ];
  const recent = recentActivity(entries);
  assert.deepEqual(recent, [
    { date: '2026-10-10', description: 'Refund', cents: 500 },
    { date: '2026-10-08', description: 'Your payment', cents: -5000 },
    { date: '2026-10-05', description: 'Insurance payment', cents: 2000 },
    { date: '2026-10-01', description: 'Visit charge', cents: 14000 },
  ]);
  assert.doesNotMatch(JSON.stringify(recent), /Claim|Encounter|Practitioner|era:|TRACE|payer|approved|charge:|sbx_|CPT|ICD/);
});

test('the billing view shows statements, the card, and recent activity without internal detail', async () => {
  const invoice = { resourceType: 'Invoice', id: 'inv-1', status: 'issued', date: '2026-10-01T15:00:00Z', totalNet: { value: 50, currency: 'USD' } };
  const entries = [line({ journalId: 'j1', idempotencyKey: 'charge:ci-1:v1', kind: 'charge', occurredAt: '2026-10-01T15:00:00Z', account: own, cents: 5000 })];
  const h = harness({ owed: 5000, invoices: [invoice], entries });
  const view = await billingView(h.deps, session());
  assert.equal(view.owedCents, 5000);
  assert.equal(view.creditCents, 0);
  assert.deepEqual(view.statements, [{ id: 'inv-1', date: '2026-10-01', totalCents: 5000 }]);
  assert.deepEqual(view.card, { brand: 'visa', last4: '4242' });
  assert.deepEqual(view.recent, [{ date: '2026-10-01', description: 'Visit charge', cents: 5000 }]);
  assert.equal((await billingView(h.deps, session({ card: null }))).card, null);
});

test('calendar days follow the practice time zone', () => {
  assert.equal(dayIn('2026-10-01T03:00:00Z'), '2026-09-30', 'early UTC morning is still the evening before in Los Angeles');
  assert.equal(dayIn('2026-10-01T15:00:00Z'), '2026-10-01');
  assert.equal(dayIn(undefined), '');
});
