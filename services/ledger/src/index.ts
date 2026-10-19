// Teleemon ledger service (ADR-005, SYSTEM-DESIGN.md §3). The only writer of the money ledger.
//
// Staff routes (/api/ledger/...) take the user's Medplum token and check their role: billers and
// administrators post adjustments, refunds, transfers and reversals; front desk records cash and
// check payments and reads balances. Internal routes (/api/ledger/internal/...) take the shared
// LEDGER_INTERNAL_TOKEN and are used by the worker (charges, 835s) and the portal service (card
// payments). Every posting is a journal draft from @teleemon/core, keyed by its source event.
//
//   npm run ledger     http://127.0.0.1:3130/api/ledger (proxied by the staff app)

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { ChargeEvent, EraClaimEvent, JournalDraft, PayerAdjustmentReason, VisitFeeKind, WriteOffReason } from '@teleemon/core';
import {
  applyCreditJournal, claimPayerId, eraClaimJournal, payerAdjustmentJournal, payerIdOf, readSettings, refundApprovedJournal, refundPaidJournal, transferToPatientJournal, writeOffJournal,
  EXT, REVENUE_EXT, visitFeeCents, visitFeeJournal,
} from '@teleemon/core';
import type { Appointment, ChargeItem, Claim, Coverage, Encounter } from '@medplum/fhirtypes';
import { HttpError, Router, badRequest, readJson } from '../../portal/src/http';
import type { StaffCaller } from './auth';
import { BILLING_ROLES, requirePatientAccess, requireRole, serviceCaller, staffCaller } from './auth';
import { arReport, openItems, queryLedgerReport, reconcile } from './reports';
import type { RemittanceRecord } from './store';
import { LedgerError, LedgerStore } from './store';

const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envFile)) for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) process.env[key] ??= value;

const KEY = /^[A-Za-z0-9-]{8,64}$/;
const ID = /^[A-Za-z0-9.-]{1,64}$/;
const PAYER = /^(Organization\/[A-Za-z0-9.-]{1,64}|payer:[A-Za-z0-9._-]{1,64})$/;
const WRITE_OFF_REASONS: readonly WriteOffReason[] = ['small-balance', 'courtesy', 'bad-debt', 'timely-filing'];

function positiveCents(v: unknown, what = 'Amount'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw badRequest(`${what} must be a positive whole number of cents.`);
  return v;
}
function text(v: unknown, what: string, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) throw badRequest(`${what} is missing or not valid.`);
  return v;
}

/** LedgerError → HttpError, so the router sends its status and message. */
async function ledger<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LedgerError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

export interface LedgerRouterOptions {
  /** Test seam; production routes keep validating the bearer token through staffCaller. */
  readonly authenticateStaff?: (req: IncomingMessage) => Promise<StaffCaller>;
}

interface BillingClaimLink {
  readonly claim: Claim;
  readonly encounterRef?: string;
  readonly chargeItemRefs: string[];
}

function fhirId(reference: string | undefined, type: string): string | undefined {
  const match = reference?.match(new RegExp(`(?:^|/)${type}/([A-Za-z0-9.-]{1,64})$`));
  return match?.[1];
}

/** Resolve the actual FHIR chain for a posting instead of trusting IDs supplied in its body. */
async function validateClaimLink(
  c: StaffCaller,
  input: { claimId: string; patientRef?: string; payerRef: string; encounterId?: string }
): Promise<BillingClaimLink> {
  const unavailable = () => new HttpError(400, 'The claim, patient, payer and visit do not match. Refresh the claim and try again.');
  let claim: Claim;
  try {
    claim = await c.medplum.readResource('Claim', input.claimId, { cache: 'no-cache' });
  } catch {
    throw new HttpError(404, 'Claim not found.');
  }
  const claimPatientId = fhirId(claim.patient?.reference, 'Patient');
  const requestedPatientId = input.patientRef ? fhirId(input.patientRef, 'Patient') : claimPatientId;
  if (!claimPatientId || !requestedPatientId || requestedPatientId !== claimPatientId) throw unavailable();
  const patientRef = await requirePatientAccess(c, claimPatientId);
  const coverageRefs = (claim.insurance ?? []).map((i) => i.coverage?.reference).filter((r): r is string => Boolean(r));
  if (coverageRefs.length === 0) throw unavailable();
  let matchingCoverage: Coverage | undefined;
  for (const ref of coverageRefs) {
    const coverageId = fhirId(ref, 'Coverage');
    if (!coverageId) continue;
    let coverage: Coverage;
    try {
      coverage = await c.medplum.readResource('Coverage', coverageId, { cache: 'no-cache' });
    } catch {
      continue;
    }
    if (fhirId(coverage.beneficiary?.reference, 'Patient') === claimPatientId && payerIdOf(coverage) === input.payerRef) matchingCoverage = coverage;
  }
  if (!matchingCoverage || claimPayerId(claim, matchingCoverage) !== input.payerRef) throw unavailable();

  const encounterRef = input.encounterId ? `Encounter/${input.encounterId}` : undefined;
  const itemEncounters = (claim.item ?? []).flatMap((item) => item.encounter?.map((ref) => ref.reference).filter((r): r is string => Boolean(r)) ?? []);
  if (input.encounterId && !itemEncounters.some((ref) => fhirId(ref, 'Encounter') === input.encounterId)) throw unavailable();
  if (input.encounterId) {
    let encounter: Encounter;
    try {
      encounter = await c.medplum.readResource('Encounter', input.encounterId, { cache: 'no-cache' });
    } catch {
      throw unavailable();
    }
    if (fhirId(encounter.subject?.reference, 'Patient') !== claimPatientId) throw unavailable();
  }

  const chargeItemRefs = [...new Set((claim.item ?? []).flatMap((item) =>
    (item.extension ?? []).filter((e) => e.url === REVENUE_EXT.chargeItem).flatMap((e) => {
      const id = fhirId(e.valueReference?.reference, 'ChargeItem');
      return id ? [`ChargeItem/${id}`] : [];
    })
  ))];
  for (const ref of chargeItemRefs) {
    const chargeId = fhirId(ref, 'ChargeItem') as string;
    let charge: ChargeItem;
    try {
      charge = await c.medplum.readResource('ChargeItem', chargeId, { cache: 'no-cache' });
    } catch {
      throw unavailable();
    }
    if (fhirId(charge.subject?.reference, 'Patient') !== claimPatientId || (input.encounterId && fhirId(charge.context?.reference, 'Encounter') !== input.encounterId)) throw unavailable();
  }
  return { claim, encounterRef, chargeItemRefs };
}

export function buildRouter(store: LedgerStore, now: () => Date = () => new Date(), options: LedgerRouterOptions = {}): Router {
  const r = new Router();
  const staff = (req: IncomingMessage): Promise<StaffCaller> => (options.authenticateStaff ?? staffCaller)(req);
  const policyFor = async (c: StaffCaller) => (await readSettings(c.medplum, 'billing')).policy;

  r.add('GET', '/api/ledger/health', async () => ({ available: true }));

  // ---- Reads ----
  r.add('GET', '/api/ledger/patients/:id', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES, 'frontdesk');
    const patientRef = await requirePatientAccess(c, p.id);
    const [balance, entries] = await Promise.all([store.patientBalance(patientRef), store.entries({ patientRef })]);
    const own = entries.filter((e) => e.account.patientRef === patientRef);
    return { patientRef, ...balance, entries: own, openItems: openItems(own) };
  });
  r.add('GET', '/api/ledger/ar', async (req) => {
    requireRole(await staff(req), ...BILLING_ROLES);
    // The read is capped at 10,000 entries. Say whether that covered the whole ledger, so the
    // dashboard can warn instead of silently showing partial totals.
    const [entries, totals] = await Promise.all([store.entries({ limit: 10000 }), store.totals()]);
    return { ...arReport(entries, now()), complete: entries.length === totals.entries };
  });
  r.add('GET', '/api/ledger/reconciliation', async (req) => {
    requireRole(await staff(req), ...BILLING_ROLES);
    return reconcile(store, now());
  });
  r.add('GET', '/api/ledger/reports/:reportId', async (req, p, q) => {
    requireRole(await staff(req), ...BILLING_ROLES);
    return ledger(() => queryLedgerReport(store, p.reportId, {
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
      asOf: q.get('asOf') ?? undefined,
    }, now()));
  });
  r.add('GET', '/api/ledger/journal', async (req, _p, q) => {
    requireRole(await staff(req), ...BILLING_ROLES);
    const j = await store.journal(q.get('key') ?? '');
    if (!j) throw new HttpError(404, 'Journal not found.');
    return j;
  });

  // ---- Staff postings ----
  r.add('POST', '/api/ledger/patients/:id/payments', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES, 'frontdesk');
    const patientRef = await requirePatientAccess(c, p.id);
    const b = await readJson<Record<string, unknown>>(req);
    if (b.method !== 'cash' && b.method !== 'check') throw badRequest('Card payments are taken through the card processor, not entered by hand.');
    const receipt = text(b.receipt, 'Receipt or check number', /^[A-Za-z0-9-]{3,40}$/);
    const cents = positiveCents(b.cents);
    return ledger(() => store.postPatientPayment({ paymentId: `${b.method}-${receipt}`, patientRef, method: b.method as 'cash' | 'check', cents, occurredAt: now().toISOString(), source: 'front-desk' }, c.actor));
  });
  // Self-pay missed-visit fee. The server decides everything: the visit must be a no-show or a
  // late cancellation for a self-pay patient, and the amount comes from the billing policy.
  r.add('POST', '/api/ledger/appointments/:id/fee', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES, 'frontdesk');
    let appt: Appointment;
    try {
      appt = await c.medplum.readResource('Appointment', p.id);
    } catch {
      throw new HttpError(404, 'Appointment not found.');
    }
    const kind: VisitFeeKind | undefined = appt.status === 'noshow' ? 'no-show'
      : appt.status === 'cancelled' && appt.cancelationReason?.coding?.some((x) => x.code === 'late-cancel') ? 'late-cancel' : undefined;
    if (!kind) throw badRequest('A fee applies only to a no-show or a late cancellation.');
    const patientId = appt.participant?.map((x) => x.actor?.reference ?? '').find((r) => r.startsWith('Patient/'))?.split('/')[1];
    if (!patientId) throw badRequest('The appointment has no patient.');
    const patientRef = await requirePatientAccess(c, patientId);
    const patient = await c.medplum.readResource('Patient', patientId);
    if (!patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true)) throw badRequest('Missed-visit fees are charged to self-pay patients only, never to insurance.');
    const cents = visitFeeCents((await policyFor(c)), kind);
    if (cents <= 0) throw badRequest('The practice has not set this fee (Settings → Payers, fees & codes → Billing policy).');
    return ledger(() => store.post([visitFeeJournal({ appointmentId: p.id, patientRef, cents, kind, postedBy: c.actor, occurredAt: appt.start ?? now().toISOString() })], c.actor));
  });
  r.add('POST', '/api/ledger/patients/:id/write-offs', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const patientRef = await requirePatientAccess(c, p.id);
    const b = await readJson<Record<string, unknown>>(req);
    const reason = b.reason as WriteOffReason;
    if (!WRITE_OFF_REASONS.includes(reason)) throw badRequest('Choose a write-off reason.');
    const cents = positiveCents(b.cents);
    const policy = await policyFor(c);
    if (reason === 'small-balance' && cents > policy.smallBalanceWriteOffCents) throw new HttpError(403, `Small-balance write-offs are limited to ${policy.smallBalanceWriteOffCents} cents under the billing policy.`);
    if (reason !== 'small-balance' && !c.roles.includes('admin')) throw new HttpError(403, 'Courtesy, bad-debt and timely-filing write-offs need an administrator.');
    const draft = writeOffJournal({ key: text(b.key, 'Request key', KEY), patientRef, cents, reason, approvedBy: c.actor, occurredAt: now().toISOString() });
    return ledger(() => store.postWithinPatientLimits(draft, c.actor, { patientRef, cents, limit: 'owed' }));
  });
  r.add('POST', '/api/ledger/patients/:id/apply-credit', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const patientRef = await requirePatientAccess(c, p.id);
    const b = await readJson<Record<string, unknown>>(req);
    const cents = positiveCents(b.cents);
    const draft = applyCreditJournal({ key: text(b.key, 'Request key', KEY), patientRef, cents, occurredAt: now().toISOString() });
    return ledger(() => store.postWithinPatientLimits(draft, c.actor, { patientRef, cents, limit: 'credit-and-owed' }));
  });
  r.add('POST', '/api/ledger/patients/:id/refunds', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const patientRef = await requirePatientAccess(c, p.id);
    const b = await readJson<Record<string, unknown>>(req);
    const cents = positiveCents(b.cents);
    const draft = refundApprovedJournal({ refundId: text(b.refundId, 'Refund id', KEY), patientRef, cents, approvedBy: c.actor, occurredAt: now().toISOString() });
    return ledger(() => store.postWithinPatientLimits(draft, c.actor, { patientRef, cents, limit: 'credit' }));
  });
  r.add('POST', '/api/ledger/refunds/:refundId/paid', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const b = await readJson<Record<string, unknown>>(req);
    const approved = await store.journal(`refund:${p.refundId}:approved`);
    if (!approved) throw new HttpError(404, 'That refund has not been approved.');
    const cents = approved.lines.find((l) => l.account.kind === 'refund_payable')?.cents ?? 0;
    if (b.method !== 'card' && b.method !== 'check') throw badRequest('Choose how the refund was paid.');
    return ledger(() => store.post([refundPaidJournal({ refundId: p.refundId, cents: -cents, method: b.method as 'card' | 'check', occurredAt: now().toISOString() })], c.actor));
  });
  r.add('POST', '/api/ledger/transfers', async (req) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const b = await readJson<Record<string, unknown>>(req);
    const patientRef = await requirePatientAccess(c, text(b.patientId, 'Patient', ID));
    const payerRef = text(b.payerRef, 'Payer', PAYER);
    const encounterRef = `Encounter/${text(b.encounterId, 'Visit', ID)}`;
    const cents = positiveCents(b.cents);
    const claimId = text(b.claimId, 'Claim', ID);
    const link = await validateClaimLink(c, { claimId, patientRef, payerRef, encounterId: encounterRef.slice('Encounter/'.length) });
    const draft = transferToPatientJournal({ key: text(b.key, 'Request key', KEY), claimRef: `Claim/${claimId}`, encounterRef, payerRef, patientRef, cents, occurredAt: now().toISOString(), memo: typeof b.memo === 'string' ? b.memo.slice(0, 500) : undefined });
    return ledger(() => store.postWithinPayerClaimLimit(draft, c.actor, { payerRef, claimRef: `Claim/${claimId}`, encounterRef, chargeItemRefs: link.chargeItemRefs, cents }));
  });
  // What is still owed on one visit, by payer and patient (P31, P34).
  r.add('GET', '/api/ledger/visits/:id', async (req, p) => {
    requireRole(await staff(req), ...BILLING_ROLES);
    const encounterRef = `Encounter/${p.id}`;
    const items = openItems(await store.entries({ encounterRef })).filter((i) => i.encounterRef === encounterRef);
    const sum = (kind: string) => items.filter((i) => i.account.kind === kind).reduce((t, i) => t + i.cents, 0);
    return { encounterRef, payerOwesCents: sum('insurance_receivable'), patientOwesCents: sum('patient_receivable'), openItems: items };
  });
  r.add('POST', '/api/ledger/payer-adjustments', async (req) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const b = await readJson<Record<string, unknown>>(req);
    const reason = b.reason as PayerAdjustmentReason;
    if (!['contractual', 'timely-filing', 'denial-final', 'small-balance'].includes(reason)) throw badRequest('Choose why the payer balance is written down.');
    if (reason === 'timely-filing' && !c.roles.includes('admin')) throw new HttpError(403, 'Timely-filing write-offs need an administrator.');
    const payerRef = text(b.payerRef, 'Payer', PAYER);
    const encounterRef = `Encounter/${text(b.encounterId, 'Visit', ID)}`;
    const cents = positiveCents(b.cents);
    const claimId = text(b.claimId, 'Claim', ID);
    const link = await validateClaimLink(c, { claimId, payerRef, encounterId: encounterRef.slice('Encounter/'.length) });
    const draft = payerAdjustmentJournal({ key: text(b.key, 'Request key', KEY), claimRef: `Claim/${claimId}`, encounterRef, payerRef, cents, reason, approvedBy: c.actor, occurredAt: now().toISOString() });
    return ledger(() => store.postWithinPayerClaimLimit(draft, c.actor, { payerRef, claimRef: `Claim/${claimId}`, encounterRef, chargeItemRefs: link.chargeItemRefs, cents }));
  });
  r.add('POST', '/api/ledger/reversals', async (req) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const b = await readJson<Record<string, unknown>>(req);
    if (typeof b.reason !== 'string') throw badRequest('Give a reason for the reversal.');
    return ledger(() => store.reverse(text(b.key, 'Journal', /^[A-Za-z0-9:._-]{3,200}$/), b.reason as string, c.actor, now().toISOString()));
  });
  // P33 exceptions: a biller posts one claim of a recorded 835 by hand, under its trace number.
  r.add('POST', '/api/ledger/remittances/:trace/claims', async (req, p) => {
    const c = await staff(req);
    requireRole(c, ...BILLING_ROLES);
    const remit = await store.remittance(p.trace);
    if (!remit) throw new HttpError(404, 'That remittance has not been received.');
    const b = await readJson<Omit<EraClaimEvent, 'traceNumber' | 'payerRef'>>(req);
    const patientRef = await requirePatientAccess(c, String(b.patientRef ?? '').replace(/^Patient\//, ''));
    const claimId = text(String(b.claimRef ?? '').replace(/^Claim\//, ''), 'Claim', ID);
    const encounterId = b.encounterRef ? text(String(b.encounterRef).replace(/^Encounter\//, ''), 'Visit', ID) : undefined;
    const link = await validateClaimLink(c, { claimId, patientRef, payerRef: remit.payerRef, encounterId });
    let draft: JournalDraft;
    try {
      draft = eraClaimJournal({ ...b, patientRef, claimRef: `Claim/${claimId}`, encounterRef: link.encounterRef, traceNumber: remit.traceNumber, payerRef: remit.payerRef, occurredAt: now().toISOString() });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message.replace(/^ledger: /, '') : 'That posting is not valid.');
    }
    return ledger(async () => [await store.postEraWithProjection(draft, c.actor, {
      claimRef: `Claim/${claimId}`,
      targetStatus: b.patientResponsibilityCents === 0 ? 'paid' : 'partially-paid',
    })]);
  });

  // ---- Internal (worker, portal) ----
  r.add('GET', '/api/ledger/internal/claim-projections', async (req, _p, q) => {
    serviceCaller(req);
    return ledger(() => store.claimProjectionJobs(100, q.get('after') ?? undefined));
  });
  r.add('POST', '/api/ledger/internal/claim-projections/:id/complete', async (req, p) => {
    serviceCaller(req);
    await readJson<Record<string, unknown>>(req);
    if (!await store.completeClaimProjection(p.id)) throw new HttpError(404, 'Claim projection job not found.');
    return { ok: true };
  });
  r.add('POST', '/api/ledger/internal/charges', async (req) => {
    const s = serviceCaller(req);
    const e = await readJson<ChargeEvent>(req);
    return ledger(async () => {
      try {
        return await store.postCharge(e, s.actor);
      } catch (err) {
        if (err instanceof Error && /^ledger: /.test(err.message)) throw new LedgerError(400, err.message.replace(/^ledger: /, ''));
        throw err;
      }
    });
  });
  r.add('POST', '/api/ledger/internal/reversals', async (req) => {
    const s = serviceCaller(req);
    const b = await readJson<{ key?: string; reason?: string }>(req);
    const key = text(b.key, 'Journal', /^[A-Za-z0-9:._-]{3,200}$/);
    const reversalKey = `reversal:${key}`;
    if (await store.journal(reversalKey)) return { idempotencyKey: reversalKey, created: false };
    return ledger(() => store.reverse(key, String(b.reason ?? ''), s.actor, now().toISOString()));
  });
  r.add('POST', '/api/ledger/internal/remittances', async (req) => {
    const s = serviceCaller(req);
    const b = await readJson<{ remittance: RemittanceRecord; journals: JournalDraft[] }>(req, 2 * 1024 * 1024);
    if (!b.remittance || !Array.isArray(b.journals)) throw badRequest('A remittance and its journals are required.');
    text(b.remittance.payerRef, 'Payer', PAYER);
    text(b.remittance.traceNumber, 'Trace number', /^[A-Za-z0-9-]{1,80}$/);
    if (!Number.isSafeInteger(b.remittance.paidCents)) throw badRequest('Remittance total must be whole cents.');
    return ledger(() => store.postRemittance(b.remittance, b.journals, s.actor));
  });
  r.add('POST', '/api/ledger/internal/payments', async (req) => {
    const s = serviceCaller(req);
    const b = await readJson<Record<string, unknown>>(req);
    const patientRef = `Patient/${text(String(b.patientRef ?? '').replace(/^Patient\//, ''), 'Patient', ID)}`;
    const paymentId = text(b.paymentId, 'Payment id', /^[A-Za-z0-9_-]{6,80}$/);
    const cents = positiveCents(b.cents);
    return ledger(() => store.postPatientPayment({ paymentId, patientRef, method: 'card', cents, occurredAt: now().toISOString(), source: 'portal' }, s.actor));
  });
  r.add('GET', '/api/ledger/internal/patient-balances', async (req) => {
    serviceCaller(req);
    return store.patientBalances();
  });
  r.add('GET', '/api/ledger/internal/patients/:id/balance', async (req, p) => {
    serviceCaller(req);
    const patientRef = `Patient/${p.id}`;
    const [balance, entries] = await Promise.all([store.patientBalance(patientRef), store.entries({ patientRef })]);
    return { patientRef, ...balance, entries: entries.filter((e) => e.account.patientRef === patientRef) };
  });
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = new LedgerStore();
  const router = buildRouter(store);
  const allowed = (process.env.LEDGER_ALLOWED_ORIGINS ?? 'http://localhost:3100').split(',');
  // Render supplies PORT; LEDGER_PORT stays for local development.
  const port = Number(process.env.PORT ?? process.env.LEDGER_PORT ?? 3130);
  if ((process.env.LEDGER_INTERNAL_TOKEN ?? '').length < 32) console.warn('[ledger] LEDGER_INTERNAL_TOKEN is not set; internal routes refuse every request. Run `npm run setup`.');
  createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowed.includes(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: 'Origin not allowed' }));
      return;
    }
    void router.handle(req, res);
  }).listen(port, process.env.LEDGER_HOST ?? '127.0.0.1', () => console.log(`[ledger] API on http://127.0.0.1:${port}/api/ledger; amounts and FHIR ids only, no names are logged`));
}
