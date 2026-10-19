// Bill pay (X08). The ledger holds the money: what the patient owes and holds as credit, and every
// posting. The portal reads that balance, shows statements (Invoice resources the worker issued) and
// takes a card payment on the card on file. A payment is charged first, then posted to the ledger
// under the charge id, so a replay of the same request never posts twice.
//
// Rules: full access only (limited proxies are refused); never more than is owed; one payment per
// account at a time; five attempts an hour per signed-in person. Patient-facing text carries no
// billing codes, payer details or staff names: activity is described from the journal kind only.

import type { MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import type { CardOnFile, JournalKind } from '@teleemon/core';
import { BILLING_TASKS, CODE_SYSTEMS, GENERATED_IDENTIFIER_SYSTEM, PRACTICE_TIME_ZONE, cardOnFile, formatCents, moneyCents, teamCoding } from '@teleemon/core';
import type { LedgerClient, LedgerEntry } from './ledgerClient';
import type { PaymentAdapter } from './payments';
import { HttpError, RateLimiter, badRequest } from './http';
import type { PortalSession } from './session';
import { requireClinicalAccess } from './session';

export const PAY_ATTEMPTS_PER_HOUR = 5;
const HOUR_MS = 3600000;
const RECENT_LIMIT = 20;
const STATEMENT_LIMIT = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BillingView {
  readonly owedCents: number;
  readonly creditCents: number;
  readonly statements: { readonly id: string; readonly date: string; readonly totalCents: number }[];
  /** Newest first. `cents` is the change to what the patient owes: positive adds, negative reduces. */
  readonly recent: { readonly date: string; readonly description: string; readonly cents: number }[];
  readonly card: { readonly brand: string; readonly last4: string } | null;
}

export interface PayResult {
  readonly status: 'posted' | 'processing';
  /** The processor's charge id: the receipt number. */
  readonly receiptId: string;
  readonly cents: number;
  readonly message: string;
  readonly balance?: { readonly owedCents: number; readonly creditCents: number };
}

export interface BillingDeps {
  readonly service: MedplumClient;
  readonly payments: PaymentAdapter;
  readonly ledger: LedgerClient;
  readonly payLimiter: RateLimiter;
}

/** Accounts with a payment in progress. One process serves the portal, so this is enough. */
const paymentsInFlight = new Set<string>();

/** Calendar day (YYYY-MM-DD) in the practice's time zone. */
export function dayIn(iso: string | undefined, zone = PRACTICE_TIME_ZONE): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * What a journal means to the patient, from its kind and the start of its key. Never a code, a
 * payer, a claim or a staff name: those stay in the ledger.
 */
export function patientDescription(kind: JournalKind, idempotencyKey: string): string {
  switch (kind) {
    case 'charge':
      return 'Visit charge';
    case 'payment':
      return idempotencyKey.startsWith('payment:') ? 'Your payment' : 'Insurance payment';
    case 'adjustment':
      return 'Account adjustment';
    case 'transfer':
      if (idempotencyKey.startsWith('credit:')) return 'Credit applied';
      return idempotencyKey.startsWith('transfer:') ? 'Insurance adjustment' : 'Account update';
    case 'refund':
      return 'Refund';
    case 'reversal':
      return 'Correction';
  }
}

/** Journals grouped into one line each, newest first. Only the patient's own lines count. */
export function recentActivity(entries: readonly LedgerEntry[], zone = PRACTICE_TIME_ZONE, limit = RECENT_LIMIT): BillingView['recent'] {
  const journals = new Map<string, { at: string; kind: JournalKind; key: string; cents: number }>();
  for (const e of entries) {
    if (e.account.kind !== 'patient_receivable' && e.account.kind !== 'patient_credit') continue;
    const j = journals.get(e.journalId) ?? { at: e.occurredAt, kind: e.kind, key: e.idempotencyKey, cents: 0 };
    journals.set(e.journalId, { ...j, cents: j.cents + e.cents });
  }
  return [...journals.values()]
    .filter((j) => j.cents !== 0) // a credit moved from owed to held changes nothing the patient sees in total
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit)
    .map((j) => ({ date: dayIn(j.at, zone), description: patientDescription(j.kind, j.key), cents: j.cents }));
}

/** Why an amount cannot be paid, in plain words, or undefined when it can. */
export function payProblem(cents: unknown, owedCents: number): string | undefined {
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents)) return 'Enter the amount in dollars and cents.';
  if (cents <= 0) return 'Enter an amount greater than $0.00.';
  if (owedCents <= 0) return 'Nothing is owed right now.';
  if (cents > owedCents) return `You can pay up to ${formatCents(owedCents)}, the amount you owe.`;
  return undefined;
}

const cardView = (c: CardOnFile | undefined): BillingView['card'] => (c ? { brand: c.brand, last4: c.last4 } : null);

/** Balance, statements, recent activity and the card on file, for the billing page. */
export async function billingView(deps: BillingDeps, s: PortalSession, zone = PRACTICE_TIME_ZONE): Promise<BillingView> {
  requireClinicalAccess(s);
  const [balance, invoices] = await Promise.all([
    deps.ledger.balance(s.patientRef),
    deps.service.searchResources('Invoice', { subject: s.patientRef, status: 'issued', _sort: '-date', _count: String(STATEMENT_LIMIT) }, { cache: 'no-cache' }),
  ]);
  return {
    owedCents: Math.max(0, balance.owedCents),
    creditCents: Math.max(0, balance.creditCents),
    statements: invoices.map((i) => ({ id: i.id as string, date: dayIn(i.date, zone), totalCents: moneyCents(i.totalNet) ?? 0 })),
    recent: recentActivity(balance.entries, zone),
    card: cardView(cardOnFile(s.patient)),
  };
}

/** Charges the card on file for `cents`, then posts it to the ledger. Refusals are HttpErrors. */
export async function payBalance(deps: BillingDeps, s: PortalSession, body: { cents?: unknown; key?: unknown }, now = new Date()): Promise<PayResult> {
  requireClinicalAccess(s);
  if (typeof body.key !== 'string' || !UUID.test(body.key)) throw badRequest('This payment could not be started. Refresh the page and try again.', 'key');
  const card = cardOnFile(s.patient);
  if (!card) throw badRequest('Add a card in your profile before you pay online.', 'no-card');
  if (card.provider !== deps.payments.mode) throw badRequest('Your saved card needs to be added again. Add a card in your profile.', 'card-mismatch');
  if (paymentsInFlight.has(s.patientRef)) throw new HttpError(409, 'A payment is already being processed for this account. Wait a moment, then check your balance.', 'in-flight');
  paymentsInFlight.add(s.patientRef);
  try {
    const before = await deps.ledger.balance(s.patientRef);
    const problem = payProblem(body.cents, Math.max(0, before.owedCents));
    if (problem) throw badRequest(problem, 'amount');
    const cents = body.cents as number;
    try {
      deps.payLimiter.take(s.actor);
    } catch {
      throw new HttpError(429, 'You have tried to pay several times this hour. Please wait a while, or call us if you need help.', 'rate-limited');
    }
    const charge = await deps.payments.charge(card, cents, `portal-pay:${s.patient.id}:${body.key}`);
    if (charge.status === 'declined') throw new HttpError(402, charge.message ?? 'Your card was declined. Try another card in your profile.', 'card-declined');

    let posted = true;
    try {
      await deps.ledger.postPayment({ paymentId: charge.chargeId, patientRef: s.patientRef, cents });
    } catch {
      posted = false;
      // The money has moved, so a biller must post it. The patient is still told it went through.
      // Logs carry the processor's charge id only: no amount, card or patient.
      await openBillingError(deps.service, s.patientRef, charge.chargeId, cents, now).then(
        () => console.error(`[portal] payment ${charge.chargeId} charged but not posted to the ledger; a billing task was requested`),
        () => console.error(`[portal] payment ${charge.chargeId} charged but not posted to the ledger, and the billing task could not be created`),
      );
    }
    const after = await deps.ledger.balance(s.patientRef).catch(() => undefined);
    const balance = after ? { owedCents: Math.max(0, after.owedCents), creditCents: Math.max(0, after.creditCents) } : undefined;
    return posted
      ? { status: 'posted', receiptId: charge.chargeId, cents, message: `Thank you. Your payment of ${formatCents(cents)} was received.`, balance }
      : {
          status: 'processing',
          receiptId: charge.chargeId,
          cents,
          message: `Your payment of ${formatCents(cents)} went through. Your account will update shortly, so you do not need to pay again. If it has not updated in a day, call us and give receipt ${charge.chargeId}.`,
          balance,
        };
  } finally {
    paymentsInFlight.delete(s.patientRef);
  }
}

/** Work for the biller team when a charge did not reach the ledger. One Task per charge id. */
async function openBillingError(service: MedplumClient, patientRef: string, chargeId: string, cents: number, now: Date): Promise<void> {
  const value = `${BILLING_TASKS.billingError}:portal-pay:${chargeId}`;
  const task: Task = {
    resourceType: 'Task',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value }],
    status: 'requested',
    intent: 'order',
    priority: 'urgent',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: BILLING_TASKS.billingError }], text: 'Card payment not posted' },
    description: `A card payment of ${formatCents(cents)} from the patient portal was charged but did not post to the ledger. Post it to this account under payment ${chargeId}. Do not charge the card again.`,
    focus: { reference: patientRef },
    for: { reference: patientRef },
    performerType: teamCoding('biller'),
    authoredOn: now.toISOString(),
  };
  await service.createResourceIfNoneExist(task, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${value}` }).toString());
}

/** Five payment attempts an hour per signed-in person (only attempts that reach the card are counted). */
export function paymentLimiter(): RateLimiter {
  return new RateLimiter(PAY_ATTEMPTS_PER_HOUR, HOUR_MS);
}
