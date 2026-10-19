// The ledger store (ADR-005): persists journal drafts from @teleemon/core unchanged and reads
// balances back. Every connection drops to the `ledger_service` role, which may only insert and
// read; the database enforces balance, append-only history and exact reversals on top of the
// checks made here.

import pg from 'pg';
import type { PoolClient } from 'pg';
import type { AccountKey, AccountKind, ChargeEvent, JournalDraft, JournalKind, JournalLine, PatientPaymentEvent } from '@teleemon/core';
import { accountId, chargeJournal, journalProblem, patientPaymentJournal, reversalJournal } from '@teleemon/core';

export class LedgerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface PostResult {
  readonly journalId: string;
  readonly idempotencyKey: string;
  /** False when the same event had already been posted (a replay); nothing changed. */
  readonly created: boolean;
}

export interface EntryRow {
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly kind: JournalKind;
  readonly occurredAt: string;
  readonly postedAt: string;
  readonly source: string;
  readonly memo?: string;
  readonly postedBy: string;
  readonly reversed: boolean;
  readonly reverses?: string;
  readonly account: AccountKey;
  readonly cents: number;
  readonly encounterRef?: string;
  readonly claimRef?: string;
  readonly chargeItemRef?: string;
}

export interface RemittanceRecord {
  readonly traceNumber: string;
  readonly payerRef: string;
  /** BPR02: what the payer says it paid in total. */
  readonly paidCents: number;
  readonly paymentDate: string;
  readonly claimCount: number;
}

export interface LedgerReconciliationSnapshot {
  readonly totals: { entrySumCents: number; journals: number; entries: number; unbalancedJournals: number };
  readonly balances: { account: AccountKey; cents: number }[];
  readonly entryPage: { entries: EntryRow[]; total: number };
  readonly remittancePage: Awaited<ReturnType<LedgerStore['remittancePage']>>;
}

export interface ClaimProjectionJob {
  readonly id: string;
  readonly sourceKey: string;
  readonly journalId: string;
  readonly claimRef: string;
  readonly targetStatus: 'paid' | 'partially-paid';
  readonly occurredAt: string;
  /** True when a later ledger reversal makes this status update stale. */
  readonly reversed: boolean;
}

export interface ClaimProjectionPage {
  readonly jobs: ClaimProjectionJob[];
  readonly nextCursor?: string;
}

export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl?: { readonly rejectUnauthorized: boolean };
}

/** A single connection string is what Render (and most managed PostgreSQL providers) supply. */
function configFromUrl(raw: string | undefined, fallbackDatabase: string): PgConfig | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return undefined;
  const sslmode = url.searchParams.get('sslmode');
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || 'medplum'),
    password: decodeURIComponent(url.password || 'medplum'),
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || fallbackDatabase),
    ...(sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full' ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export function pgConfigFromEnv(database = process.env.LEDGER_PG_DATABASE ?? 'teleemon_ledger'): PgConfig {
  const fromUrl = configFromUrl(process.env.LEDGER_DATABASE_URL, database);
  if (fromUrl) return fromUrl;
  return {
    host: process.env.LEDGER_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.LEDGER_PG_PORT ?? '5439'),
    user: process.env.LEDGER_PG_USER ?? 'medplum',
    password: process.env.LEDGER_PG_PASSWORD ?? 'medplum',
    database,
  };
}

const ACCOUNT_NAMES: Record<AccountKind, string> = {
  patient_receivable: 'Patient receivable',
  insurance_receivable: 'Insurance receivable',
  patient_credit: 'Patient credit',
  cash: 'Cash',
  card_clearing: 'Card clearing',
  revenue: 'Revenue',
  contractual_adjustment: 'Contractual adjustment',
  write_off: 'Write-off',
  refund_payable: 'Refund payable',
};

/** Account names carry the kind and the owner's FHIR id only, never a person's name. */
const accountName = (a: AccountKey): string => [ACCOUNT_NAMES[a.kind], a.patientRef ?? a.payerRef].filter(Boolean).join(' ').slice(0, 120);

/** Stable comparison of what a draft would write, so a replay with different content is caught. */
const fingerprint = (lines: readonly Pick<JournalLine, 'account' | 'cents' | 'encounterRef' | 'claimRef' | 'chargeItemRef'>[]): string =>
  lines.map((l) => [accountId(l.account), l.cents, l.encounterRef ?? '', l.claimRef ?? '', l.chargeItemRef ?? ''].join('~')).sort().join('\n');

const ENTRY_SELECT = `
  select j.id as journal_id, j.idempotency_key, j.kind, j.occurred_at, j.posted_at, j.source, j.memo, j.posted_by,
         exists (select 1 from ledger.journal r where r.reverses = j.id) as reversed,
         (select o.idempotency_key from ledger.journal o where o.id = j.reverses) as reverses_key,
         a.kind as account_kind, a.patient_ref, a.payer_ref,
         e.amount_cents, e.encounter_ref, e.claim_ref, e.charge_item_ref
  from ledger.entry e join ledger.journal j on j.id = e.journal_id join ledger.account a on a.id = e.account_id`;

function toEntry(r: Record<string, unknown>): EntryRow {
  const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
  return {
    journalId: String(r.journal_id),
    idempotencyKey: String(r.idempotency_key),
    kind: r.kind as JournalKind,
    occurredAt: new Date(r.occurred_at as string).toISOString(),
    postedAt: new Date(r.posted_at as string).toISOString(),
    source: String(r.source),
    memo: opt(r.memo),
    postedBy: String(r.posted_by),
    reversed: Boolean(r.reversed),
    reverses: opt(r.reverses_key),
    account: { kind: r.account_kind as AccountKind, patientRef: opt(r.patient_ref), payerRef: opt(r.payer_ref) },
    cents: Number(r.amount_cents),
    encounterRef: opt(r.encounter_ref),
    claimRef: opt(r.claim_ref),
    chargeItemRef: opt(r.charge_item_ref),
  };
}

export class LedgerStore {
  private readonly pool: pg.Pool;

  constructor(config: PgConfig = pgConfigFromEnv()) {
    this.pool = new pg.Pool({ ...config, max: 5 });
    // bigint sums come back as strings; amounts are well inside Number's safe range.
    this.pool.on('connect', (client) => {
      void client.query('set role ledger_service');
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('set role ledger_service');
      await c.query('begin isolation level serializable');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Serializable transactions can fail under contention; retry those a few times. */
  private async txRetry<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tx(fn);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if ((code === '40001' || code === '40P01' || code === '23505') && attempt < 4) continue;
        throw err;
      }
    }
  }

  private async accountIdFor(c: PoolClient, a: AccountKey): Promise<string> {
    const params = [a.kind, a.patientRef ?? null, a.payerRef ?? null];
    const found = await c.query(`select id from ledger.account where kind = $1 and patient_ref is not distinct from $2 and payer_ref is not distinct from $3`, params);
    if (found.rows[0]) return String(found.rows[0].id);
    const made = await c.query(`insert into ledger.account (kind, patient_ref, payer_ref, name) values ($1, $2, $3, $4) returning id`, [...params, accountName(a)]);
    return String(made.rows[0].id);
  }

  private async journalLines(c: PoolClient, key: string): Promise<JournalDraft | undefined> {
    const rows = (await c.query(`${ENTRY_SELECT} where j.idempotency_key = $1 order by e.id`, [key])).rows.map(toEntry);
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      kind: r.kind, idempotencyKey: r.idempotencyKey, occurredAt: r.occurredAt, source: r.source, memo: r.memo, reverses: r.reverses,
      lines: rows.map((e) => ({ account: e.account, cents: e.cents, encounterRef: e.encounterRef, claimRef: e.claimRef, chargeItemRef: e.chargeItemRef })),
    };
  }

  /** Posts inside an open transaction. A replay of the same key is a no-op; a replay with different amounts is refused. */
  private async postIn(c: PoolClient, d: JournalDraft, postedBy: string, beforeCreate?: (c: PoolClient) => Promise<void>): Promise<PostResult> {
    const problem = journalProblem(d);
    if (problem) throw new LedgerError(400, `${d.idempotencyKey}: ${problem}`);
    const existing = await c.query('select id from ledger.journal where idempotency_key = $1', [d.idempotencyKey]);
    if (existing.rows[0]) {
      const posted = await this.journalLines(c, d.idempotencyKey);
      if (posted && fingerprint(posted.lines) !== fingerprint(d.lines)) {
        throw new LedgerError(409, `${d.idempotencyKey} was already posted with different amounts; post a reversal and a new event instead`);
      }
      return { journalId: String(existing.rows[0].id), idempotencyKey: d.idempotencyKey, created: false };
    }
    let reversesId: string | null = null;
    if (d.reverses) {
      const original = await c.query('select id from ledger.journal where idempotency_key = $1', [d.reverses]);
      if (!original.rows[0]) throw new LedgerError(404, `journal ${d.reverses} was not found`);
      reversesId = String(original.rows[0].id);
    }
    // The callback runs after replay detection but before any mutation. Callers can enforce
    // balance-dependent rules inside this same serializable transaction without breaking replay.
    await beforeCreate?.(c);
    const j = await c.query(
      `insert into ledger.journal (kind, occurred_at, idempotency_key, source, memo, reverses, posted_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [d.kind, d.occurredAt, d.idempotencyKey, d.source, d.memo ?? null, reversesId, postedBy.slice(0, 120)]
    );
    const journalId = String(j.rows[0].id);
    for (const l of d.lines) {
      await c.query(
        `insert into ledger.entry (journal_id, account_id, amount_cents, encounter_ref, claim_ref, charge_item_ref) values ($1, $2, $3, $4, $5, $6)`,
        [journalId, await this.accountIdFor(c, l.account), l.cents, l.encounterRef ?? null, l.claimRef ?? null, l.chargeItemRef ?? null]
      );
    }
    return { journalId, idempotencyKey: d.idempotencyKey, created: true };
  }

  /** Posts several journals atomically: all or none. */
  async post(drafts: readonly JournalDraft[], postedBy: string): Promise<PostResult[]> {
    try {
      return await this.txRetry(async (c) => {
        const out: PostResult[] = [];
        for (const d of drafts) out.push(await this.postIn(c, d, postedBy));
        return out;
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /**
   * Split a patient receipt against the balance observed inside the same serializable transaction.
   * Exact source replays return the original result before recalculating the split; mismatched
   * patient, tender, source, or amount is rejected even if the idempotency key already exists.
   */
  async postPatientPayment(
    input: Omit<PatientPaymentEvent, 'owedCents'>,
    postedBy: string
  ): Promise<PostResult[]> {
    const key = `payment:${input.paymentId}`;
    try {
      return await this.txRetry(async (c) => {
        const prior = await c.query('select id from ledger.journal where idempotency_key = $1', [key]);
        if (prior.rows[0]) {
          const saved = await this.journalLines(c, key);
          const tenderKind = input.method === 'card' ? 'card_clearing' : 'cash';
          const tender = saved?.lines.find((line) => line.account.kind === 'cash' || line.account.kind === 'card_clearing');
          const patientLines = saved?.lines.filter((line) => line.account.kind === 'patient_receivable' || line.account.kind === 'patient_credit') ?? [];
          const patientRefs = [...new Set(patientLines.map((line) => line.account.patientRef))];
          const recordedMethod = saved?.memo?.match(/^payment-method:(card|cash|check)$/)?.[1];
          const legacyMethodMatches = input.method === 'card'
            ? tender?.account.kind === 'card_clearing'
            : tender?.account.kind === 'cash' && key.startsWith(`payment:${input.method}-`);
          const methodMatches = recordedMethod ? recordedMethod === input.method : legacyMethodMatches;
          if (!saved || saved.kind !== 'payment' || saved.source !== input.source || tender?.account.kind !== tenderKind || tender.cents !== input.cents || !methodMatches || patientRefs.length !== 1 || patientRefs[0] !== input.patientRef) {
            throw new LedgerError(409, `${key} was already used for a different patient payment.`);
          }
          return [{ journalId: String(prior.rows[0].id), idempotencyKey: key, created: false }];
        }

        const row = (await c.query(`
          select coalesce(sum(balance_cents) filter (where kind = 'patient_receivable'), 0) as receivable,
                 coalesce(sum(balance_cents) filter (where kind = 'patient_credit'), 0) as credit
          from ledger.account_balance where patient_ref = $1
        `, [input.patientRef])).rows[0];
        const owedCents = Math.max(0, Number(row?.receivable ?? 0) + Math.max(0, Number(row?.credit ?? 0)));
        const draft = { ...patientPaymentJournal({ ...input, owedCents }), memo: `payment-method:${input.method}` };
        return [await this.postIn(c, draft, postedBy)];
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /**
   * Posts a patient adjustment only while the selected balance is still available. The check and
   * append share one serializable transaction; txRetry reruns the check after an SSI conflict.
   * Existing idempotency keys are handled by postIn before the guard, so exact replays remain safe.
   */
  async postWithinPatientLimits(
    draft: JournalDraft,
    postedBy: string,
    input: { patientRef: string; cents: number; limit: 'owed' | 'credit' | 'credit-and-owed' }
  ): Promise<PostResult[]> {
    try {
      return await this.txRetry(async (c) => [await this.postIn(c, draft, postedBy, async (tx) => {
        const row = (await tx.query(`
          select
            greatest(0, coalesce(sum(balance_cents) filter (where kind = 'patient_receivable'), 0)) as owed,
            greatest(0, -coalesce(sum(balance_cents) filter (where kind = 'patient_credit'), 0)) as credit
          from ledger.account_balance where patient_ref = $1
        `, [input.patientRef])).rows[0];
        const owed = Number(row?.owed ?? 0);
        const credit = Number(row?.credit ?? 0);
        const available = input.limit === 'owed' ? owed : input.limit === 'credit' ? credit : Math.min(owed, credit);
        if (input.cents > available) {
          const message = input.limit === 'owed'
            ? `A write-off cannot be more than the patient owes (${available} cents).`
            : input.limit === 'credit'
              ? `A refund cannot be more than the credit held for the patient (${available} cents).`
              : `Applied credit cannot exceed the credit held or the amount owed (${available} cents).`;
          throw new LedgerError(400, message);
        }
      })]);
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /**
   * Posts a payer adjustment/transfer only while this claim still has the requested payer balance.
   * Charge rows can predate a Claim, so include the Claim's ChargeItem references as well as later
   * claim-scoped entries. All matching rows are evaluated under serializable isolation.
   */
  async postWithinPayerClaimLimit(
    draft: JournalDraft,
    postedBy: string,
    input: { payerRef: string; claimRef: string; encounterRef: string; chargeItemRefs: readonly string[]; cents: number }
  ): Promise<PostResult[]> {
    try {
      return await this.txRetry(async (c) => [await this.postIn(c, draft, postedBy, async (tx) => {
        const result = await tx.query(`
          select coalesce(sum(e.amount_cents) filter (
                   where e.claim_ref = $3 or (cardinality($4::text[]) > 0 and e.charge_item_ref = any($4::text[]))
                 ), 0)
               + coalesce(sum(e.amount_cents) filter (
                   where e.claim_ref is null and e.charge_item_ref is null and e.amount_cents < 0
                 ), 0) as available
          from ledger.entry e
          join ledger.account a on a.id = e.account_id
          where a.kind = 'insurance_receivable' and a.payer_ref = $1
            and e.encounter_ref = $2
        `, [input.payerRef, input.encounterRef, input.claimRef, [...input.chargeItemRefs]]);
        const available = Math.max(0, Number(result.rows[0]?.available ?? 0));
        if (input.cents > available) throw new LedgerError(400, `Only ${available} cents is still owed by the payer for this claim and visit.`);
      })]);
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /**
   * Posts a charge for one ChargeItem version. When an earlier version of the same ChargeItem is
   * still on the books, it is reversed in the same transaction, so a re-priced charge never counts twice.
   */
  async postCharge(e: ChargeEvent, postedBy: string): Promise<PostResult[]> {
    const draft = chargeJournal(e);
    try {
      return await this.txRetry(async (c) => {
        const out: PostResult[] = [];
        const earlier = await c.query(
          `select j.idempotency_key from ledger.journal j
           where j.kind = 'charge' and j.idempotency_key like $1 and j.idempotency_key <> $2
             and not exists (select 1 from ledger.journal r where r.reverses = j.id)`,
          [`charge:${e.chargeItemId}:%`, draft.idempotencyKey]
        );
        const alreadyCurrent = await c.query('select 1 from ledger.journal where idempotency_key = $1', [draft.idempotencyKey]);
        if (!alreadyCurrent.rows[0]) {
          for (const row of earlier.rows) {
            const original = await this.journalLines(c, String(row.idempotency_key));
            if (original) out.push(await this.postIn(c, reversalJournal(original, { reason: `ChargeItem/${e.chargeItemId} superseded by version ${e.version}`, occurredAt: e.occurredAt, by: 'charge-capture' }), postedBy));
          }
        }
        out.push(await this.postIn(c, draft, postedBy));
        return out;
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /** Reverses a posted journal exactly. A journal can be reversed once; a reversal cannot be reversed. */
  async reverse(key: string, reason: string, by: string, occurredAt = new Date().toISOString()): Promise<PostResult> {
    if (reason.trim().length < 3) throw new LedgerError(400, 'Give a reason for the reversal');
    try {
      return await this.txRetry(async (c) => {
        const original = await this.journalLines(c, key);
        if (!original) throw new LedgerError(404, `journal ${key} was not found`);
        if (original.kind === 'reversal') throw new LedgerError(400, 'A reversal cannot itself be reversed; post the original event again instead');
        const done = await c.query(`select 1 from ledger.journal r join ledger.journal o on o.id = r.reverses where o.idempotency_key = $1`, [key]);
        if (done.rows[0]) throw new LedgerError(409, `${key} has already been reversed`);
        return this.postIn(c, reversalJournal(original, { reason, occurredAt, by }), by);
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /**
   * Records an 835 and posts its claim journals in one transaction. The remittance row is the
   * payer's stated total; reconciliation compares it with the cash actually posted under its trace.
   */
  async postRemittance(r: RemittanceRecord, drafts: readonly JournalDraft[], postedBy: string): Promise<{ results: PostResult[]; replay: boolean }> {
    for (const d of drafts) {
      if (d.source !== `era:${r.traceNumber}`.slice(0, 200)) throw new LedgerError(400, `${d.idempotencyKey} does not belong to remittance ${r.traceNumber}`);
    }
    try {
      return await this.txRetry(async (c) => {
        const seen = await c.query('select paid_cents from ledger.remittance where trace_number = $1', [r.traceNumber]);
        if (seen.rows[0] && Number(seen.rows[0].paid_cents) !== r.paidCents) throw new LedgerError(409, `Remittance ${r.traceNumber} was already recorded with a different total`);
        if (!seen.rows[0]) {
          await c.query(`insert into ledger.remittance (trace_number, payer_ref, paid_cents, payment_date, claim_count, recorded_by) values ($1, $2, $3, $4, $5, $6)`, [
            r.traceNumber, r.payerRef, r.paidCents, r.paymentDate, r.claimCount, postedBy.slice(0, 120),
          ]);
        }
        const results: PostResult[] = [];
        for (const d of drafts) results.push(await this.postIn(c, d, postedBy));
        return { results, replay: Boolean(seen.rows[0]) };
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /** Post a staff-entered ERA line and persist its FHIR Claim projection in the same transaction. */
  async postEraWithProjection(
    draft: JournalDraft,
    postedBy: string,
    projection: { claimRef: string; targetStatus: 'paid' | 'partially-paid' }
  ): Promise<PostResult> {
    try {
      return await this.txRetry(async (c) => {
        const result = await this.postIn(c, draft, postedBy);
        await c.query(`
          insert into ledger.claim_projection (source_key, journal_id, claim_ref, target_status, occurred_at)
          values ($1, $2, $3, $4, $5)
          on conflict (source_key) do nothing
        `, [draft.idempotencyKey, result.journalId, projection.claimRef, projection.targetStatus, draft.occurredAt]);
        const saved = (await c.query('select journal_id, claim_ref, target_status from ledger.claim_projection where source_key = $1', [draft.idempotencyKey])).rows[0];
        if (!saved || String(saved.journal_id) !== result.journalId || saved.claim_ref !== projection.claimRef || saved.target_status !== projection.targetStatus) {
          throw new LedgerError(409, 'That ERA event already has a different Claim status projection.');
        }
        return result;
      });
    } catch (err) {
      throw asLedgerError(err);
    }
  }

  /** Pending jobs are stable, oldest-first; the worker confirms the FHIR update before completing. */
  async claimProjectionJobs(limit = 100, after?: string): Promise<ClaimProjectionPage> {
    let cursor: { createdAt: string; id: string } | undefined;
    if (after) {
      try {
        const decoded = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
        if (typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id)) throw new Error('invalid cursor');
        cursor = { createdAt: decoded.createdAt, id: decoded.id };
      } catch {
        throw new LedgerError(400, 'The claim projection cursor is not valid.');
      }
    }
    const pageSize = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (await this.pool.query(`
      select p.id, p.source_key, p.journal_id, p.claim_ref, p.target_status, p.occurred_at, p.created_at::text as created_at_cursor,
             exists (select 1 from ledger.journal r where r.reverses = p.journal_id) as reversed
      from ledger.claim_projection p
      where p.completed_at is null
        and ($1::timestamptz is null or (p.created_at, p.id) > ($1::timestamptz, $2::uuid))
      order by p.created_at, p.id
      limit $3
    `, [cursor?.createdAt ?? null, cursor?.id ?? null, pageSize + 1])).rows;
    const pageRows = rows.slice(0, pageSize);
    const jobs = pageRows.map((r) => ({
      id: String(r.id), sourceKey: String(r.source_key), journalId: String(r.journal_id), claimRef: String(r.claim_ref),
      targetStatus: r.target_status as ClaimProjectionJob['targetStatus'], occurredAt: new Date(r.occurred_at as string).toISOString(), reversed: Boolean(r.reversed),
    }));
    const last = pageRows[pageRows.length - 1];
    const nextCursor = rows.length > pageSize && last
      ? Buffer.from(JSON.stringify({ createdAt: String(last.created_at_cursor), id: String(last.id) })).toString('base64url')
      : undefined;
    return { jobs, nextCursor };
  }

  /** Idempotent acknowledgement after the worker has successfully applied the FHIR projection. */
  async completeClaimProjection(id: string): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const result = await this.pool.query(`
      update ledger.claim_projection set completed_at = coalesce(completed_at, now()) where id = $1 returning id
    `, [id]);
    return result.rowCount === 1;
  }

  // --- Reads -------------------------------------------------------------------------------------

  /** One posted journal as a draft (lines in posting order), or undefined. */
  async journal(key: string): Promise<JournalDraft | undefined> {
    const c = await this.pool.connect();
    try {
      return await this.journalLines(c, key);
    } finally {
      c.release();
    }
  }

  async remittance(traceNumber: string): Promise<RemittanceRecord | undefined> {
    return (await this.remittances()).find((r) => r.traceNumber === traceNumber);
  }

  async entries(filter: { patientRef?: string; payerRef?: string; encounterRef?: string; limit?: number } = {}): Promise<EntryRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.patientRef) {
      params.push(filter.patientRef);
      where.push(`j.id in (select e2.journal_id from ledger.entry e2 join ledger.account a2 on a2.id = e2.account_id where a2.patient_ref = $${params.length})`);
    }
    if (filter.payerRef) {
      params.push(filter.payerRef);
      where.push(`a.payer_ref = $${params.length}`);
    }
    if (filter.encounterRef) {
      params.push(filter.encounterRef);
      where.push(`e.encounter_ref = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 2000, 10000));
    const sql = `${ENTRY_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by j.occurred_at, j.posted_at, e.id limit $${params.length}`;
    return (await this.pool.query(sql, params)).rows.map(toEntry);
  }

  /** One consistent, date-bounded read for reports. The matching count makes truncation explicit. */
  async entriesPage(filter: { from?: string; to?: string; limit?: number } = {}): Promise<{ entries: EntryRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from) {
      params.push(filter.from);
      where.push(`j.occurred_at >= $${params.length}::timestamptz`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`j.occurred_at < $${params.length}::timestamptz`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 10000, 10000));
    const c = await this.pool.connect();
    try {
      await c.query('set role ledger_service');
      await c.query('begin isolation level repeatable read read only');
      const count = await c.query(`select count(*) as total from ledger.entry e join ledger.journal j on j.id = e.journal_id ${whereSql}`, params);
      const selectParams = [...params, limit];
      const rows = await c.query(`${ENTRY_SELECT} ${whereSql} order by j.occurred_at, j.posted_at, e.id limit $${selectParams.length}`, selectParams);
      await c.query('commit');
      return { entries: rows.rows.map(toEntry), total: Number(count.rows[0]?.total ?? 0) };
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Balance per account, straight from the `account_balance` view. */
  async accountBalances(): Promise<{ account: AccountKey; cents: number }[]> {
    const rows = (await this.pool.query('select kind, patient_ref, payer_ref, balance_cents from ledger.account_balance order by kind, patient_ref, payer_ref')).rows;
    return rows.map((r) => ({ account: { kind: r.kind as AccountKind, patientRef: r.patient_ref ?? undefined, payerRef: r.payer_ref ?? undefined }, cents: Number(r.balance_cents) }));
  }

  /**
   * Receivable and credit for one patient. Owed is positive; credit is a positive amount held.
   * A debit balance on the credit account (credit refunded, then the payment reversed) is owed,
   * never shown as negative credit.
   */
  async patientBalance(patientRef: string): Promise<{ owedCents: number; creditCents: number; netCents: number }> {
    const rows = (await this.pool.query(`select kind, balance_cents from ledger.account_balance where patient_ref = $1`, [patientRef])).rows;
    const receivable = rows.filter((r) => r.kind === 'patient_receivable').reduce((t, r) => t + Number(r.balance_cents), 0);
    const credit = rows.filter((r) => r.kind === 'patient_credit').reduce((t, r) => t + Number(r.balance_cents), 0);
    return { owedCents: receivable + Math.max(0, credit), creditCents: Math.max(0, -credit), netCents: receivable + credit };
  }

  /** Every patient with money owed or credit held, with the dates statements and refund review need. */
  async patientBalances(): Promise<{ patientRef: string; owedCents: number; creditCents: number; lastActivityAt: string; lastCreditAt?: string }[]> {
    const rows = (
      await this.pool.query(`
        select a.patient_ref,
               sum(case when a.kind = 'patient_receivable' then e.amount_cents else 0 end) as owed,
               -sum(case when a.kind = 'patient_credit' then e.amount_cents else 0 end) as credit,
               max(j.occurred_at) as last_activity,
               max(case when a.kind = 'patient_credit' and e.amount_cents < 0 then j.occurred_at end) as last_credit
        from ledger.entry e join ledger.account a on a.id = e.account_id join ledger.journal j on j.id = e.journal_id
        where a.patient_ref is not null
        group by a.patient_ref
        having sum(case when a.kind = 'patient_receivable' then e.amount_cents else 0 end) <> 0 or sum(case when a.kind = 'patient_credit' then e.amount_cents else 0 end) <> 0
        order by a.patient_ref`)
    ).rows;
    // Same rule as patientBalance: a debit on the credit account is owed, credit is never negative.
    return rows.map((r) => ({ patientRef: String(r.patient_ref), owedCents: Number(r.owed) + Math.max(0, -Number(r.credit)), creditCents: Math.max(0, Number(r.credit)), lastActivityAt: new Date(r.last_activity as string).toISOString(), lastCreditAt: r.last_credit ? new Date(r.last_credit as string).toISOString() : undefined }));
  }

  /** Every remittance with the cash posted under its trace number. */
  async remittances(): Promise<(RemittanceRecord & { postedCashCents: number; journalCount: number; recordedAt: string })[]> {
    return (await this.remittancePage()).remittances;
  }

  /** A consistent, date-bounded remittance read for reports, with a count for completeness. */
  async remittancePage(filter: { from?: string; to?: string; limit?: number } = {}): Promise<{
    remittances: (RemittanceRecord & { postedCashCents: number; journalCount: number; recordedAt: string })[];
    total: number;
  }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from) {
      params.push(filter.from);
      where.push(`r.payment_date >= $${params.length}::date`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`r.payment_date < $${params.length}::date`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const limit = filter.limit === undefined ? undefined : Math.max(1, Math.min(filter.limit, 10000));
    const c = await this.pool.connect();
    let rows: Record<string, unknown>[];
    let total: number;
    try {
      await c.query('set role ledger_service');
      await c.query('begin isolation level repeatable read read only');
      const count = await c.query(`select count(*) as total from ledger.remittance r ${whereSql}`, params);
      total = Number(count.rows[0]?.total ?? 0);
      const selectParams = [...params];
      const limitSql = limit === undefined ? '' : `limit $${selectParams.push(limit)}`;
      rows = (await c.query(`
        select r.trace_number, r.payer_ref, r.paid_cents, r.payment_date, r.claim_count, r.recorded_at,
               coalesce((select sum(e.amount_cents) from ledger.entry e join ledger.journal j on j.id = e.journal_id join ledger.account a on a.id = e.account_id
                         where a.kind = 'cash' and (j.source = 'era:' || r.trace_number
                           or j.reverses in (select id from ledger.journal where source = 'era:' || r.trace_number))), 0) as posted_cash,
               (select count(*) from ledger.journal j where j.source = 'era:' || r.trace_number) as journal_count
        from ledger.remittance r ${whereSql} order by r.payment_date desc, r.trace_number ${limitSql}
      `, selectParams)).rows;
      await c.query('commit');
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    const remittances = rows.map((r) => ({
      traceNumber: String(r.trace_number), payerRef: String(r.payer_ref), paidCents: Number(r.paid_cents), paymentDate: new Date(r.payment_date as string).toISOString().slice(0, 10),
      claimCount: Number(r.claim_count), recordedAt: new Date(r.recorded_at as string).toISOString(), postedCashCents: Number(r.posted_cash), journalCount: Number(r.journal_count),
    }));
    return { remittances, total };
  }

  /**
   * Read all reconciliation inputs from one repeatable-read snapshot. Without this, a journal
   * posted between separate balance, entry and remittance queries can look like a false mismatch.
   */
  async reconciliationSnapshot(limit = 10000): Promise<LedgerReconciliationSnapshot> {
    const cappedLimit = Math.max(1, Math.min(limit, 10000));
    const c = await this.pool.connect();
    try {
      await c.query('set role ledger_service');
      await c.query('begin isolation level repeatable read read only');

      const [entryCount, entryRows, totalsResult, balanceRows, remittanceCount, remittanceRows] = await Promise.all([
        c.query('select count(*) as total from ledger.entry'),
        c.query(`${ENTRY_SELECT} order by j.occurred_at, j.posted_at, e.id limit $1`, [cappedLimit]),
        c.query(`select coalesce(sum(amount_cents), 0) as total, count(*) as entries, count(distinct journal_id) as journals,
          (select count(*) from (select journal_id from ledger.entry group by journal_id having sum(amount_cents) <> 0) u) as unbalanced from ledger.entry`),
        c.query('select kind, patient_ref, payer_ref, balance_cents from ledger.account_balance order by kind, patient_ref, payer_ref'),
        c.query('select count(*) as total from ledger.remittance'),
        c.query(`
          select r.trace_number, r.payer_ref, r.paid_cents, r.payment_date, r.claim_count, r.recorded_at,
                 coalesce((select sum(e.amount_cents) from ledger.entry e join ledger.journal j on j.id = e.journal_id join ledger.account a on a.id = e.account_id
                           where a.kind = 'cash' and (j.source = 'era:' || r.trace_number
                             or j.reverses in (select id from ledger.journal where source = 'era:' || r.trace_number))), 0) as posted_cash,
                 (select count(*) from ledger.journal j where j.source = 'era:' || r.trace_number) as journal_count
          from ledger.remittance r order by r.payment_date desc, r.trace_number limit $1
        `, [cappedLimit]),
      ]);
      await c.query('commit');

      const totalsRow = totalsResult.rows[0];
      return {
        totals: {
          entrySumCents: Number(totalsRow.total), journals: Number(totalsRow.journals),
          entries: Number(totalsRow.entries), unbalancedJournals: Number(totalsRow.unbalanced),
        },
        balances: balanceRows.rows.map((r) => ({ account: { kind: r.kind as AccountKind, patientRef: r.patient_ref ?? undefined, payerRef: r.payer_ref ?? undefined }, cents: Number(r.balance_cents) })),
        entryPage: { entries: entryRows.rows.map(toEntry), total: Number(entryCount.rows[0]?.total ?? 0) },
        remittancePage: {
          remittances: remittanceRows.rows.map((r) => ({
            traceNumber: String(r.trace_number), payerRef: String(r.payer_ref), paidCents: Number(r.paid_cents),
            paymentDate: new Date(r.payment_date as string).toISOString().slice(0, 10), claimCount: Number(r.claim_count),
            recordedAt: new Date(r.recorded_at as string).toISOString(), postedCashCents: Number(r.posted_cash), journalCount: Number(r.journal_count),
          })),
          total: Number(remittanceCount.rows[0]?.total ?? 0),
        },
      };
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** Database-level totals used by reconciliation: every entry ever posted must sum to zero. */
  async totals(): Promise<{ entrySumCents: number; journals: number; entries: number; unbalancedJournals: number }> {
    const r = (
      await this.pool.query(`select coalesce(sum(amount_cents), 0) as total, count(*) as entries, count(distinct journal_id) as journals,
        (select count(*) from (select journal_id from ledger.entry group by journal_id having sum(amount_cents) <> 0) u) as unbalanced from ledger.entry`)
    ).rows[0];
    return { entrySumCents: Number(r.total), journals: Number(r.journals), entries: Number(r.entries), unbalancedJournals: Number(r.unbalanced) };
  }
}

/** Maps database refusals (balance, append-only, uniqueness) to readable 4xx errors. */
export function asLedgerError(err: unknown): LedgerError {
  if (err instanceof LedgerError) return err;
  const e = err as { code?: string; message?: string };
  const message = (e.message ?? 'Ledger error').replace(/^ledger: /, '');
  if (e.code === '23514') return new LedgerError(400, message);
  if (e.code === '23505') return new LedgerError(409, 'That event was posted at the same moment by another request; try again');
  if (e.code === '42501') return new LedgerError(403, message);
  if (err instanceof Error && /^ledger: /.test(err.message)) return new LedgerError(400, message);
  return new LedgerError(500, 'The ledger could not complete that posting');
}
