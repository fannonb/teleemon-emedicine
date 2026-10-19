// Client for the ledger's internal routes (services/ledger/src/index.ts), as the portal service
// calls them for bill pay (X08): read a patient's balance and post a card payment. Requests carry
// the shared internal token and X-Teleemon-Service: portal. A failure never reaches the patient as
// the ledger's own words: it becomes one plain 503 message, and the caller decides what to do next.

import type { AccountKind, JournalKind } from '@teleemon/core';
import { HttpError } from './http';

const UNAVAILABLE = 'Billing is not available right now. Please try again in a few minutes, or call us.';

/** One ledger line on a patient account. Only patient receivable and credit lines are returned. */
export interface LedgerEntry {
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly kind: JournalKind;
  readonly occurredAt: string;
  readonly reversed: boolean;
  readonly account: { readonly kind: AccountKind; readonly patientRef?: string; readonly payerRef?: string };
  readonly cents: number;
}

export interface PatientBalance {
  readonly patientRef: string;
  /** Owed is positive. */
  readonly owedCents: number;
  /** Credit held on the account, shown as a positive amount. */
  readonly creditCents: number;
  readonly netCents: number;
  readonly entries: LedgerEntry[];
}

export interface PaymentPosting {
  /** Processor charge id; the ledger's replay key, so posting twice is a no-op. */
  readonly paymentId: string;
  readonly patientRef: string;
  readonly cents: number;
}

export interface LedgerClient {
  balance(patientRef: string): Promise<PatientBalance>;
  postPayment(payment: PaymentPosting): Promise<void>;
}

export class LedgerHttpClient implements LedgerClient {
  constructor(private readonly timeoutMs = 8000) {}

  balance(patientRef: string): Promise<PatientBalance> {
    const id = patientRef.replace(/^Patient\//, '');
    return this.call<PatientBalance>('GET', `/api/ledger/internal/patients/${encodeURIComponent(id)}/balance`);
  }

  async postPayment(payment: PaymentPosting): Promise<void> {
    await this.call('POST', '/api/ledger/internal/payments', payment);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = process.env.LEDGER_INTERNAL_TOKEN ?? '';
    if (token.length < 32) throw new HttpError(503, UNAVAILABLE, 'ledger-unavailable');
    // LEDGER_URL for a full address; Render's private network supplies LEDGER_HOST/LEDGER_PORT.
    const base = (
      process.env.LEDGER_URL ??
      (process.env.LEDGER_HOST ? `http://${process.env.LEDGER_HOST}:${process.env.LEDGER_PORT ?? '10000'}` : 'http://127.0.0.1:3130')
    ).replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'X-Teleemon-Service': 'portal', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      console.error(`[portal] ledger ${method} unreachable or timed out`);
      throw new HttpError(503, UNAVAILABLE, 'ledger-unavailable');
    }
    if (!res.ok) {
      // Status and method only: the path carries the patient's id.
      console.error(`[portal] ledger ${method} refused with ${res.status}`);
      throw new HttpError(503, UNAVAILABLE, 'ledger-unavailable');
    }
    return (await res.json()) as T;
  }
}
