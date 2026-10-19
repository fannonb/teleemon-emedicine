import type { MedplumClient } from '@medplum/core';
import type { AccountKey, EraClaimEvent, JournalDraft, JournalKind, PayerAdjustmentReason, WriteOffReason } from '@teleemon/core';

// Typed client for the staff routes of the ledger service (services/ledger, mounted at /api/ledger
// by the Vite proxy). Amounts are whole cents. The server checks roles and every invariant; this
// file only shapes requests and turns refusals into readable messages.

export type PaymentMethod = 'cash' | 'check';
export type RefundMethod = 'card' | 'check';

export interface LedgerEntry {
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly kind: JournalKind;
  readonly occurredAt: string;
  readonly postedAt: string;
  readonly source: string;
  readonly memo?: string;
  readonly postedBy: string;
  /** True once a reversal of this journal exists. */
  readonly reversed: boolean;
  readonly reverses?: string;
  readonly account: AccountKey;
  /** Debit positive (the patient owes more), credit negative. */
  readonly cents: number;
  readonly encounterRef?: string;
  readonly claimRef?: string;
  readonly chargeItemRef?: string;
}

export interface OpenItem {
  readonly account: AccountKey;
  readonly encounterRef?: string;
  /** Date of service; aging starts here. */
  readonly serviceDate: string;
  /** Still owed (positive), or unapplied money (negative). */
  readonly cents: number;
}

export interface PatientAccount {
  readonly patientRef: string;
  readonly owedCents: number;
  readonly creditCents: number;
  readonly netCents: number;
  readonly entries: LedgerEntry[];
  readonly openItems: OpenItem[];
}

export interface PostResult {
  readonly journalId: string;
  readonly idempotencyKey: string;
  /** False when the same request had already been posted; nothing changed. */
  readonly created: boolean;
}

export type AgingCounts = Record<'0-30' | '31-60' | '61-90' | '91-120' | '120+', number>;

export interface ArReport {
  readonly asOf: string;
  readonly rows: { readonly key: string; readonly kind: 'insurance' | 'patient'; readonly ref: string; readonly buckets: AgingCounts; readonly totalCents: number }[];
  readonly totals: { readonly insurance: AgingCounts; readonly patient: AgingCounts; readonly insuranceCents: number; readonly patientCents: number; readonly creditCents: number; readonly totalCents: number };
  /** False when the ledger holds more entries than this read returned, so the totals are partial. */
  readonly complete?: boolean;
}

/** One remittance as the ledger holds it (services/ledger `remittances()`). */
export interface LedgerRemittance {
  readonly traceNumber: string;
  readonly payerRef: string;
  readonly paidCents: number;
  readonly postedCashCents: number;
  readonly journalCount: number;
  readonly paymentDate: string;
  readonly claimCount: number;
  readonly recordedAt: string;
}

export interface ReconciliationReport {
  readonly ok: boolean;
  readonly checks: { readonly label: string; readonly ok: boolean; readonly expectedCents?: number; readonly actualCents?: number }[];
  readonly ar: ArReport;
  readonly remittances: readonly LedgerRemittance[];
}

/** What is still owed on one visit, by payer and by patient (biller). */
export interface VisitBalance {
  readonly encounterRef: string;
  readonly payerOwesCents: number;
  readonly patientOwesCents: number;
  readonly openItems: OpenItem[];
}

/** A refusal from the ledger service. `message` is the server's own plain-English reason. */
export class LedgerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'LedgerApiError';
  }
}

/**
 * Request key for an idempotent posting. Generate it once when the dialog opens, so a double click
 * or a retry after a dropped response replays the same posting rather than making a second one.
 */
export const newRequestKey = (): string => crypto.randomUUID();

async function call<T>(medplum: MedplumClient, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/ledger${path}`, {
      method,
      headers: { Authorization: `Bearer ${medplum.getAccessToken()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new LedgerApiError(0, 'The ledger service is not reachable. Nothing was recorded; try again in a moment.');
  }
  const text = await res.text();
  let json: { message?: unknown; code?: unknown } | undefined;
  try {
    json = text ? (JSON.parse(text) as { message?: unknown; code?: unknown }) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const message = typeof json?.message === 'string' ? json.message : `The ledger could not complete this (HTTP ${res.status}). Check the account before trying again.`;
    throw new LedgerApiError(res.status, message, typeof json?.code === 'string' ? json.code : undefined);
  }
  return json as T;
}

const patientPath = (patientId: string): string => `/patients/${encodeURIComponent(patientId)}`;

export const ledgerApi = {
  /** Balances, entries and open items for one patient (biller and front desk). */
  account: (medplum: MedplumClient, patientId: string) => call<PatientAccount>(medplum, 'GET', patientPath(patientId)),
  /** Aging across the practice (biller). */
  ar: (medplum: MedplumClient) => call<ArReport>(medplum, 'GET', '/ar'),
  /** Ledger, A/R and remittance checks (biller). */
  reconciliation: (medplum: MedplumClient) => call<ReconciliationReport>(medplum, 'GET', '/reconciliation'),
  /** One posted journal by its key (biller). Used to tell whether a refund has been paid. */
  journal: (medplum: MedplumClient, key: string) => call<JournalDraft>(medplum, 'GET', `/journal?key=${encodeURIComponent(key)}`),

  /** Cash or check from the patient. The receipt number is the idempotency key for the payment. */
  recordPayment: (medplum: MedplumClient, patientId: string, body: { method: PaymentMethod; receipt: string; cents: number }) =>
    call<PostResult[]>(medplum, 'POST', `${patientPath(patientId)}/payments`, body),
  /** Self-pay missed-visit fee for an appointment. The server checks the visit and takes the amount from policy. */
  visitFee: (medplum: MedplumClient, appointmentId: string) =>
    call<PostResult[]>(medplum, 'POST', `/appointments/${encodeURIComponent(appointmentId)}/fee`),
  /** Write-off of a patient balance. Small balances only, unless the caller is an administrator. */
  writeOff: (medplum: MedplumClient, patientId: string, body: { key: string; reason: WriteOffReason; cents: number }) =>
    call<PostResult[]>(medplum, 'POST', `${patientPath(patientId)}/write-offs`, body),
  /** Uses credit the patient holds against a balance they owe. */
  applyCredit: (medplum: MedplumClient, patientId: string, body: { key: string; cents: number }) =>
    call<PostResult[]>(medplum, 'POST', `${patientPath(patientId)}/apply-credit`, body),
  /** Approves a refund of credit held. The refund id is the idempotency key. */
  approveRefund: (medplum: MedplumClient, patientId: string, body: { refundId: string; cents: number }) =>
    call<PostResult[]>(medplum, 'POST', `${patientPath(patientId)}/refunds`, body),
  /** Records that an approved refund has been paid, by card or check. */
  markRefundPaid: (medplum: MedplumClient, refundId: string, body: { method: RefundMethod }) =>
    call<PostResult[]>(medplum, 'POST', `/refunds/${encodeURIComponent(refundId)}/paid`, body),
  /** What the payer and the patient still owe on one visit (biller). */
  visit: (medplum: MedplumClient, encounterId: string) => call<VisitBalance>(medplum, 'GET', `/visits/${encodeURIComponent(encounterId)}`),
  /** Moves what a payer still owes on one visit to the patient. */
  transfer: (medplum: MedplumClient, body: { key: string; patientId: string; payerRef: string; encounterId: string; claimId: string; cents: number; memo?: string }) =>
    call<PostResult[]>(medplum, 'POST', '/transfers', body),
  /**
   * Writes down what a payer still owes on one visit (never more than it owes). Timely-filing
   * write-downs need an administrator; the server refuses them otherwise.
   */
  payerAdjustment: (medplum: MedplumClient, body: { key: string; claimId: string; encounterId: string; payerRef: string; cents: number; reason: PayerAdjustmentReason }) =>
    call<PostResult[]>(medplum, 'POST', '/payer-adjustments', body),
  /** Reverses a posted journal. The reason is required; the server checks the journal is not already reversed. */
  reverse: (medplum: MedplumClient, body: { key: string; reason: string }) => call<PostResult>(medplum, 'POST', '/reversals', body),
  /** Posts one claim payment of a recorded 835 by hand (P33 exceptions). */
  postRemittanceClaim: (medplum: MedplumClient, traceNumber: string, body: Omit<EraClaimEvent, 'traceNumber' | 'payerRef'>) =>
    call<PostResult[]>(medplum, 'POST', `/remittances/${encodeURIComponent(traceNumber)}/claims`, body),
};
