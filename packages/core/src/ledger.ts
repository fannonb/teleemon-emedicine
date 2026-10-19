// Ledger posting rules (ADR-005). Pure functions: each builder turns one billing event into one
// balanced journal draft. services/ledger persists drafts unchanged, and the database re-checks
// every invariant (balance, two or more entries, append-only, exact reversals, idempotency).
//
// Sign convention, as in services/ledger/schema.sql: integer cents, debits positive, credits negative.

export type AccountKind =
  | 'patient_receivable'
  | 'insurance_receivable'
  | 'patient_credit'
  | 'cash'
  | 'card_clearing'
  | 'revenue'
  | 'contractual_adjustment'
  | 'write_off'
  | 'refund_payable';

export type JournalKind = 'charge' | 'payment' | 'adjustment' | 'refund' | 'transfer' | 'reversal';

export type PracticeAccountKind = Exclude<AccountKind, 'patient_receivable' | 'insurance_receivable' | 'patient_credit'>;

export interface AccountKey {
  readonly kind: AccountKind;
  /** `Patient/<id>` for patient receivable and patient credit. */
  readonly patientRef?: string;
  /** `Organization/<id>` or `payer:<code>` for insurance receivable. */
  readonly payerRef?: string;
}

export interface JournalLine {
  readonly account: AccountKey;
  /** Integer cents; debit positive, credit negative, never zero. */
  readonly cents: number;
  readonly encounterRef?: string;
  readonly claimRef?: string;
  readonly chargeItemRef?: string;
}

export interface JournalDraft {
  readonly kind: JournalKind;
  /** One per source event (ERA claim, card charge, ChargeItem version): posting twice is a no-op. */
  readonly idempotencyKey: string;
  /** ISO timestamp of the business event (service date, ERA date, payment time). */
  readonly occurredAt: string;
  /** Where the event came from, e.g. 'charge-review', 'era:<trace>', 'portal'. */
  readonly source: string;
  readonly memo?: string;
  /** Idempotency key of the journal this one reverses (kind 'reversal' only). */
  readonly reverses?: string;
  readonly lines: readonly JournalLine[];
}

const PATIENT_REF = /^Patient\/[A-Za-z0-9.-]{1,64}$/;
const PAYER_REF = /^(Organization\/[A-Za-z0-9.-]{1,64}|payer:[A-Za-z0-9._-]{1,64})$/;
const REF = { encounterRef: /^Encounter\/[A-Za-z0-9.-]{1,64}$/, claimRef: /^Claim\/[A-Za-z0-9.-]{1,64}$/, chargeItemRef: /^ChargeItem\/[A-Za-z0-9.-]{1,64}$/ } as const;

export const practiceAccount = (kind: PracticeAccountKind): AccountKey => ({ kind });
export const patientReceivable = (patientRef: string): AccountKey => ({ kind: 'patient_receivable', patientRef });
export const patientCredit = (patientRef: string): AccountKey => ({ kind: 'patient_credit', patientRef });
export const insuranceReceivable = (payerRef: string): AccountKey => ({ kind: 'insurance_receivable', payerRef });

/** Same owner rules as the `account_owner` constraint, so a bad key fails before reaching the database. */
export function accountProblem(a: AccountKey): string | undefined {
  if (a.patientRef !== undefined && !PATIENT_REF.test(a.patientRef)) return `${a.kind}: patient must be a Patient/<id> reference`;
  if (a.payerRef !== undefined && !PAYER_REF.test(a.payerRef)) return `${a.kind}: payer must be an Organization/<id> or payer:<code> reference`;
  switch (a.kind) {
    case 'patient_receivable':
    case 'patient_credit':
      return a.patientRef && !a.payerRef ? undefined : `${a.kind} needs a patient and no payer`;
    case 'insurance_receivable':
      return a.payerRef && !a.patientRef ? undefined : 'insurance_receivable needs a payer and no patient';
    default:
      return a.patientRef || a.payerRef ? `${a.kind} is a practice account and has no owner` : undefined;
  }
}

/** Stable text key for an account, used to group lines and look accounts up. */
export const accountId = (a: AccountKey): string => `${a.kind}|${a.patientRef ?? ''}|${a.payerRef ?? ''}`;

/** Why a draft would be refused, or undefined when it is postable. */
export function journalProblem(j: JournalDraft): string | undefined {
  if (j.idempotencyKey.length < 3 || j.idempotencyKey.length > 200) return 'idempotency key must be 3–200 characters';
  if (j.source.length < 3 || j.source.length > 200) return 'source must be 3–200 characters';
  if (j.memo && j.memo.length > 500) return 'memo is longer than 500 characters';
  if (Number.isNaN(Date.parse(j.occurredAt))) return 'occurredAt is not a timestamp';
  if ((j.kind === 'reversal') !== Boolean(j.reverses)) return 'a reversal, and only a reversal, names the journal it reverses';
  if (j.lines.length < 2) return 'a journal needs at least two entries';
  let total = 0;
  for (const l of j.lines) {
    if (!Number.isSafeInteger(l.cents) || l.cents === 0) return 'every entry is a non-zero whole number of cents';
    const problem = accountProblem(l.account);
    if (problem) return problem;
    for (const k of Object.keys(REF) as (keyof typeof REF)[]) {
      const v = l[k];
      if (v !== undefined && !REF[k].test(v)) return `${k} must be a FHIR id reference`;
    }
    total += l.cents;
  }
  return total === 0 ? undefined : `journal does not balance: entries sum to ${total} cents`;
}

function draft(j: Omit<JournalDraft, 'lines'> & { lines: (JournalLine | false | undefined)[] }): JournalDraft {
  const lines = j.lines.filter((l): l is JournalLine => Boolean(l) && (l as JournalLine).cents !== 0);
  const out = { ...j, lines };
  const problem = journalProblem(out);
  if (problem) throw new Error(`ledger: ${j.idempotencyKey}: ${problem}`);
  return out;
}

const cents = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n)) throw new Error(`ledger: ${what} must be whole cents`);
  return n;
};

// --- Money -------------------------------------------------------------------------------------

/** "$1,234.5" / "1234.50" / "-3" to integer cents, exactly (no floating point). Undefined if not money. */
export function parseDollars(text: string): number | undefined {
  const m = /^\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!m) return undefined;
  const whole = Number(m[2].replaceAll(',', ''));
  const frac = Number((m[3] ?? '0').padEnd(2, '0'));
  const v = whole * 100 + frac;
  if (!Number.isSafeInteger(v)) return undefined;
  return m[1] && v !== 0 ? -v : v;
}

/** 123456 → "$1,234.56"; -500 → "-$5.00". */
export function formatCents(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error('ledger: formatCents takes whole cents');
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${n < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Sum of integer cents, refusing anything that is not whole cents. */
export function sumCents(values: readonly number[]): number {
  return values.reduce((t, v) => t + cents(v, 'amount'), 0);
}

// --- Posting rules -----------------------------------------------------------------------------

export interface ChargeEvent {
  readonly chargeItemId: string;
  /** ChargeItem meta.versionId: a re-priced charge is a reversal plus a charge for the new version. */
  readonly version: string;
  readonly patientRef: string;
  /** Payer billed first; undefined for self-pay (the patient is billed directly). */
  readonly payerRef?: string;
  readonly cents: number;
  readonly occurredAt: string;
  readonly encounterRef?: string;
  readonly claimRef?: string;
  readonly postedFrom?: string;
}

/** Charge: debit the payer (or self-pay patient) receivable, credit revenue. */
export function chargeJournal(e: ChargeEvent): JournalDraft {
  const amount = cents(e.cents, 'charge');
  if (amount <= 0) throw new Error('ledger: a charge must be positive; corrections are reversals');
  const refs = { encounterRef: e.encounterRef, claimRef: e.claimRef, chargeItemRef: `ChargeItem/${e.chargeItemId}` };
  return draft({
    kind: 'charge',
    idempotencyKey: `charge:${e.chargeItemId}:${e.version}`,
    occurredAt: e.occurredAt,
    source: e.postedFrom ?? 'charge-review',
    lines: [
      { account: e.payerRef ? insuranceReceivable(e.payerRef) : patientReceivable(e.patientRef), cents: amount, ...refs },
      { account: practiceAccount('revenue'), cents: -amount, ...refs },
    ],
  });
}

export interface EraClaimEvent {
  /** Check or EFT trace number of the 835 (TRN02). */
  readonly traceNumber: string;
  /** Payer's claim control number for this claim payment (CLP07), so a re-sent 835 posts once. */
  readonly payerClaimControl: string;
  readonly claimRef: string;
  readonly payerRef: string;
  readonly patientRef: string;
  readonly occurredAt: string;
  /** CLP04: amount paid. Negative for a take-back. */
  readonly paidCents: number;
  /** CO, OA and PI adjustments: the payer's write-down the practice cannot bill the patient. */
  readonly contractualCents: number;
  /** PR adjustments: deductible, coinsurance and copay moved to the patient. */
  readonly patientResponsibilityCents: number;
  readonly encounterRef?: string;
}

/**
 * One ERA claim payment, posted atomically: cash in, payer write-down, patient share, all out of
 * the payer's receivable. Any amount may be negative (take-backs and reversals in the 835).
 */
export function eraClaimJournal(e: EraClaimEvent): JournalDraft {
  const paid = cents(e.paidCents, 'paid');
  const contractual = cents(e.contractualCents, 'contractual adjustment');
  const pr = cents(e.patientResponsibilityCents, 'patient responsibility');
  const total = paid + contractual + pr;
  const refs = { claimRef: e.claimRef, encounterRef: e.encounterRef };
  return draft({
    kind: 'payment',
    idempotencyKey: `era:${e.traceNumber}:${e.payerClaimControl}`,
    occurredAt: e.occurredAt,
    source: `era:${e.traceNumber}`.slice(0, 200),
    lines: [
      { account: practiceAccount('cash'), cents: paid, ...refs },
      { account: practiceAccount('contractual_adjustment'), cents: contractual, ...refs },
      { account: patientReceivable(e.patientRef), cents: pr, ...refs },
      { account: insuranceReceivable(e.payerRef), cents: -total, ...refs },
    ],
  });
}

/** How a patient payment splits between what they owe and credit held on the account. */
export function applyPatientPayment(owedCents: number, paidCents: number): { applied: number; credit: number } {
  cents(owedCents, 'owed');
  if (cents(paidCents, 'payment') <= 0) throw new Error('ledger: a payment must be positive');
  const applied = Math.max(0, Math.min(owedCents, paidCents));
  return { applied, credit: paidCents - applied };
}

export interface PatientPaymentEvent {
  /** Processor charge id (Stripe `ch_…`, sandbox `sbx_…`) or a receipt number for cash and check. */
  readonly paymentId: string;
  readonly patientRef: string;
  readonly method: 'card' | 'cash' | 'check';
  readonly cents: number;
  /** The patient's balance before this payment; any excess is held as credit. */
  readonly owedCents: number;
  readonly occurredAt: string;
  readonly source: 'portal' | 'front-desk' | 'statement';
}

/** Patient payment: debit card clearing (or cash), credit what they owe, hold the rest as credit. */
export function patientPaymentJournal(e: PatientPaymentEvent): JournalDraft {
  const { applied, credit } = applyPatientPayment(e.owedCents, e.cents);
  return draft({
    kind: 'payment',
    idempotencyKey: `payment:${e.paymentId}`,
    occurredAt: e.occurredAt,
    source: e.source,
    lines: [
      { account: practiceAccount(e.method === 'card' ? 'card_clearing' : 'cash'), cents: e.cents },
      { account: patientReceivable(e.patientRef), cents: -applied },
      { account: patientCredit(e.patientRef), cents: -credit },
    ],
  });
}

export type WriteOffReason = 'small-balance' | 'courtesy' | 'bad-debt' | 'timely-filing';

/** Write-off of a patient balance; the caller has already checked approval under the billing policy. */
export function writeOffJournal(e: { key: string; patientRef: string; cents: number; reason: WriteOffReason; approvedBy: string; occurredAt: string; claimRef?: string }): JournalDraft {
  if (cents(e.cents, 'write-off') <= 0) throw new Error('ledger: a write-off must be positive');
  if (e.approvedBy.trim().length < 3) throw new Error('ledger: a write-off names who approved it');
  return draft({
    kind: 'adjustment',
    idempotencyKey: `writeoff:${e.key}`,
    occurredAt: e.occurredAt,
    source: 'billing',
    memo: `${e.reason}; approved by ${e.approvedBy}`.slice(0, 500),
    lines: [
      { account: practiceAccount('write_off'), cents: e.cents, claimRef: e.claimRef },
      { account: patientReceivable(e.patientRef), cents: -e.cents, claimRef: e.claimRef },
    ],
  });
}

/**
 * A self-pay missed-visit fee (no-show or late cancellation). Charged to the patient, never to
 * insurance; one per appointment. The amount comes from the billing policy, not from the caller.
 */
export function visitFeeJournal(e: { appointmentId: string; patientRef: string; cents: number; kind: 'no-show' | 'late-cancel'; postedBy: string; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'fee') <= 0) throw new Error('ledger: a fee must be positive');
  return draft({
    kind: 'charge',
    idempotencyKey: `fee:${e.appointmentId}`,
    occurredAt: e.occurredAt,
    source: 'front-desk',
    memo: `${e.kind === 'no-show' ? 'No-show' : 'Late cancellation'} fee; posted by ${e.postedBy}`.slice(0, 500),
    lines: [
      { account: patientReceivable(e.patientRef), cents: e.cents },
      { account: practiceAccount('revenue'), cents: -e.cents },
    ],
  });
}

/** Use credit held on the account against a balance the patient now owes. */
export function applyCreditJournal(e: { key: string; patientRef: string; cents: number; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'credit') <= 0) throw new Error('ledger: applied credit must be positive');
  return draft({
    kind: 'transfer',
    idempotencyKey: `credit:${e.key}`,
    occurredAt: e.occurredAt,
    source: 'billing',
    lines: [
      { account: patientCredit(e.patientRef), cents: e.cents },
      { account: patientReceivable(e.patientRef), cents: -e.cents },
    ],
  });
}

/** An approved refund moves credit to refund payable; paying it moves it out of cash or the card processor. */
export function refundApprovedJournal(e: { refundId: string; patientRef: string; cents: number; approvedBy: string; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'refund') <= 0) throw new Error('ledger: a refund must be positive');
  if (e.approvedBy.trim().length < 3) throw new Error('ledger: a refund names who approved it');
  return draft({
    kind: 'refund',
    idempotencyKey: `refund:${e.refundId}:approved`,
    occurredAt: e.occurredAt,
    source: 'billing',
    memo: `approved by ${e.approvedBy}`.slice(0, 500),
    lines: [
      { account: patientCredit(e.patientRef), cents: e.cents },
      { account: practiceAccount('refund_payable'), cents: -e.cents },
    ],
  });
}

export function refundPaidJournal(e: { refundId: string; cents: number; method: 'card' | 'check'; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'refund') <= 0) throw new Error('ledger: a refund must be positive');
  return draft({
    kind: 'refund',
    idempotencyKey: `refund:${e.refundId}:paid`,
    occurredAt: e.occurredAt,
    source: 'billing',
    lines: [
      { account: practiceAccount('refund_payable'), cents: e.cents },
      { account: practiceAccount(e.method === 'card' ? 'card_clearing' : 'cash'), cents: -e.cents },
    ],
  });
}

/** Card processor payout settles card clearing into the bank. */
export function payoutJournal(e: { payoutId: string; cents: number; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'payout') <= 0) throw new Error('ledger: a payout must be positive');
  return draft({
    kind: 'transfer',
    idempotencyKey: `payout:${e.payoutId}`,
    occurredAt: e.occurredAt,
    source: 'card-processor',
    lines: [
      { account: practiceAccount('cash'), cents: e.cents },
      { account: practiceAccount('card_clearing'), cents: -e.cents },
    ],
  });
}

/** Move what is still owed on a claim from the payer to the patient (denial or no coverage). */
export function transferToPatientJournal(e: { key: string; claimRef: string; encounterRef?: string; payerRef: string; patientRef: string; cents: number; occurredAt: string; memo?: string }): JournalDraft {
  if (cents(e.cents, 'transfer') <= 0) throw new Error('ledger: a transfer must be positive');
  return draft({
    kind: 'transfer',
    idempotencyKey: `transfer:${e.key}`,
    occurredAt: e.occurredAt,
    source: 'billing',
    memo: e.memo,
    lines: [
      { account: patientReceivable(e.patientRef), cents: e.cents, claimRef: e.claimRef, encounterRef: e.encounterRef },
      { account: insuranceReceivable(e.payerRef), cents: -e.cents, claimRef: e.claimRef, encounterRef: e.encounterRef },
    ],
  });
}

export type PayerAdjustmentReason = 'contractual' | 'timely-filing' | 'denial-final' | 'small-balance';

/**
 * Write down what a payer still owes on a visit and will not pay (a final denial, timely filing,
 * a payer write-down missed on the 835). Contractual reductions go to contractual adjustment; the
 * rest are write-offs. The patient balance is not touched; use transferToPatientJournal for that.
 */
export function payerAdjustmentJournal(e: { key: string; claimRef: string; encounterRef?: string; payerRef: string; cents: number; reason: PayerAdjustmentReason; approvedBy: string; occurredAt: string }): JournalDraft {
  if (cents(e.cents, 'adjustment') <= 0) throw new Error('ledger: a payer adjustment must be positive');
  if (e.approvedBy.trim().length < 3) throw new Error('ledger: a payer adjustment names who approved it');
  const refs = { claimRef: e.claimRef, encounterRef: e.encounterRef };
  return draft({
    kind: 'adjustment',
    idempotencyKey: `payer-adjustment:${e.key}`,
    occurredAt: e.occurredAt,
    source: 'billing',
    memo: `${e.reason}; approved by ${e.approvedBy}`.slice(0, 500),
    lines: [
      { account: practiceAccount(e.reason === 'contractual' ? 'contractual_adjustment' : 'write_off'), cents: e.cents, ...refs },
      { account: insuranceReceivable(e.payerRef), cents: -e.cents, ...refs },
    ],
  });
}

/** The exact mirror of a posted journal. The database refuses anything else, and a second reversal. */
export function reversalJournal(original: JournalDraft, e: { reason: string; occurredAt: string; by: string }): JournalDraft {
  if (original.kind === 'reversal') throw new Error('ledger: a reversal is not reversed; post the original again under a new key');
  return draft({
    kind: 'reversal',
    // Keys are at most 200 characters; never truncate (two reversals could collide), refuse instead.
    idempotencyKey: `reversal:${original.idempotencyKey}`,
    occurredAt: e.occurredAt,
    source: e.by,
    memo: e.reason.slice(0, 500),
    reverses: original.idempotencyKey,
    lines: original.lines.map((l) => ({ ...l, cents: -l.cents })),
  });
}

// --- Balances ----------------------------------------------------------------------------------

/** Net balance per account across drafts (debit positive). */
export function balances(journals: readonly JournalDraft[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of journals) for (const l of j.lines) out.set(accountId(l.account), (out.get(accountId(l.account)) ?? 0) + l.cents);
  return out;
}
