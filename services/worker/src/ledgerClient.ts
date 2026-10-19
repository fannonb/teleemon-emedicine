// Client for the ledger's internal routes (services/ledger/src/index.ts). The worker is the only
// caller of charges and 835 postings; amounts and FHIR ids only ever leave here, never names.
// Every request has a timeout. A failed request throws LedgerRequestError with the HTTP status
// (0 when the ledger was unreachable or timed out), so callers can tell "retry later" from "refused".

import type { AccountKey, ChargeEvent, JournalDraft, JournalKind } from '@teleemon/core';

export class LedgerRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'LedgerRequestError';
  }
}

export interface PostResult {
  readonly journalId: string;
  readonly idempotencyKey: string;
  /** False when the same event had already been posted (a replay); nothing changed. */
  readonly created: boolean;
}

/** The 835 as the ledger records it: the payer's stated total, posted under its trace number. */
export interface RemittanceRecord {
  readonly traceNumber: string;
  readonly payerRef: string;
  readonly paidCents: number;
  readonly paymentDate: string;
  readonly claimCount: number;
}

/** A durable ledger-to-FHIR Claim status projection. The worker acknowledges it only after FHIR is saved. */
export interface ClaimProjectionJob {
  readonly id: string;
  /** The ERA journal idempotency key, for reconciliation and idempotent recovery. */
  readonly sourceKey: string;
  readonly journalId: string;
  readonly claimRef: string;
  readonly targetStatus: 'paid' | 'partially-paid';
  readonly occurredAt: string;
  /** A reversal already exists for the source journal; never project its payment status. */
  readonly reversed: boolean;
}

export interface ClaimProjectionPage {
  readonly jobs: ClaimProjectionJob[];
  readonly nextCursor?: string;
}

export interface PatientBalanceRow {
  readonly patientRef: string;
  readonly owedCents: number;
  readonly creditCents: number;
  readonly lastActivityAt: string;
  readonly lastCreditAt?: string;
}

/** One ledger entry line on a patient account, as the balance route returns it. */
export interface LedgerEntry {
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly kind: JournalKind;
  readonly occurredAt: string;
  readonly source: string;
  readonly memo?: string;
  readonly reversed: boolean;
  readonly reverses?: string;
  readonly account: AccountKey;
  readonly cents: number;
}

export interface PatientBalance {
  readonly patientRef: string;
  readonly owedCents: number;
  readonly creditCents: number;
  readonly netCents: number;
  readonly entries: LedgerEntry[];
}

export class LedgerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  postCharge(e: ChargeEvent): Promise<PostResult[]> {
    return this.call<PostResult[]>('POST', '/api/ledger/internal/charges', e);
  }

  postRemittance(remittance: RemittanceRecord, journals: readonly JournalDraft[]): Promise<{ results: PostResult[]; replay: boolean }> {
    return this.call('POST', '/api/ledger/internal/remittances', { remittance, journals });
  }

  /** Pending ERA claim projections, oldest first. `after` is the opaque ledger keyset cursor. */
  pendingClaimProjections(after?: string): Promise<ClaimProjectionPage> {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    return this.call('GET', `/api/ledger/internal/claim-projections${query}`);
  }

  /** Acknowledges a projection only after the FHIR Claim write succeeded. */
  completeClaimProjection(id: string): Promise<{ ok: true }> {
    return this.call('POST', `/api/ledger/internal/claim-projections/${encodeURIComponent(id)}/complete`, {});
  }

  patientBalances(): Promise<PatientBalanceRow[]> {
    return this.call('GET', '/api/ledger/internal/patient-balances');
  }

  /** Reverses a posted journal. Already reversed counts as done (returns the reversal key). */
  async reverse(key: string, reason: string): Promise<{ idempotencyKey: string }> {
    return this.call('POST', '/api/ledger/internal/reversals', { key, reason });
  }

  /** `patientId` is the bare Patient id, without the `Patient/` prefix. */
  patientBalance(patientId: string): Promise<PatientBalance> {
    return this.call('GET', `/api/ledger/internal/patients/${encodeURIComponent(patientId)}/balance`);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'X-Teleemon-Service': 'worker', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      if (!res.ok) {
        const message = typeof (data as { message?: unknown } | undefined)?.message === 'string' ? (data as { message: string }).message : `ledger ${method} ${path} failed`;
        throw new LedgerRequestError(res.status, message);
      }
      return data as T;
    } catch (err) {
      if (err instanceof LedgerRequestError) throw err;
      throw new LedgerRequestError(0, `ledger unreachable or timed out (${(err as Error).name})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * LEDGER_URL is a full address; on Render the private network supplies LEDGER_HOST/LEDGER_PORT.
 * The internal token is the one `npm run setup` writes.
 */
export function ledgerFromEnv(env: NodeJS.ProcessEnv = process.env): LedgerClient {
  const token = env.LEDGER_INTERNAL_TOKEN ?? '';
  if (token.length < 32) throw new Error('LEDGER_INTERNAL_TOKEN is not set. Run `npm run setup`.');
  const base = env.LEDGER_URL ?? (env.LEDGER_HOST ? `http://${env.LEDGER_HOST}:${env.LEDGER_PORT ?? '10000'}` : 'http://127.0.0.1:3130');
  return new LedgerClient(base, token);
}
