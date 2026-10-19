// Receivables and reconciliation from ledger entries (P19, P33, P36). Open items are built per
// account and visit: payments that name a visit settle that visit first, and anything else is
// applied oldest first. Open items always sum exactly to the account balance, so the A/R
// dashboard ties to the ledger by construction, and reconcile() proves it on every read.

import type { AccountKey } from '@teleemon/core';
import { accountId, agingBucket, getReportDefinition } from '@teleemon/core';
import type { ReportId } from '@teleemon/core';
import { LedgerError } from './store';
import type { EntryRow, LedgerStore } from './store';

export type AgingBucket = ReturnType<typeof agingBucket>;
export const BUCKETS: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '91-120', '120+'];

export interface OpenItem {
  readonly account: AccountKey;
  /** The visit the amount belongs to, when known. */
  readonly encounterRef?: string;
  /** Date of the original charge (aging starts here). */
  readonly serviceDate: string;
  /** Still owed (positive), or unapplied money (negative, e.g. a payer overpayment). */
  readonly cents: number;
}

const RECEIVABLE = new Set(['insurance_receivable', 'patient_receivable']);

/** Open items for every receivable account in the entries given. */
export function openItems(entries: readonly EntryRow[]): OpenItem[] {
  const byAccount = new Map<string, EntryRow[]>();
  for (const e of entries) {
    if (!RECEIVABLE.has(e.account.kind)) continue;
    const k = accountId(e.account);
    byAccount.set(k, [...(byAccount.get(k) ?? []), e]);
  }
  const out: OpenItem[] = [];
  for (const rows of byAccount.values()) {
    const account = rows[0].account;
    const sorted = [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.postedAt.localeCompare(b.postedAt));
    // Debits open items (one per visit); credits naming a visit settle that visit first.
    const items: { encounterRef?: string; serviceDate: string; cents: number }[] = [];
    const byVisit = new Map<string, { encounterRef?: string; serviceDate: string; cents: number }>();
    let unapplied = 0;
    for (const e of sorted) {
      if (e.cents > 0) {
        const key = e.encounterRef ?? `journal:${e.journalId}`;
        let item = byVisit.get(key);
        if (!item) {
          item = { encounterRef: e.encounterRef, serviceDate: e.occurredAt.slice(0, 10), cents: 0 };
          byVisit.set(key, item);
          items.push(item);
        }
        item.cents += e.cents;
      } else {
        const item = e.encounterRef ? byVisit.get(e.encounterRef) : undefined;
        if (item) item.cents += e.cents;
        else unapplied += e.cents;
      }
    }
    // A visit paid beyond its charge passes the excess to the general pool.
    for (const item of items) {
      if (item.cents < 0) {
        unapplied += item.cents;
        item.cents = 0;
      }
    }
    for (const item of items) {
      if (unapplied >= 0) break;
      const take = Math.min(item.cents, -unapplied);
      item.cents -= take;
      unapplied += take;
    }
    for (const item of items) if (item.cents !== 0) out.push({ account, ...item });
    if (unapplied !== 0) out.push({ account, serviceDate: sorted[sorted.length - 1].occurredAt.slice(0, 10), cents: unapplied });
  }
  return out;
}

export interface ArRow {
  readonly key: string;
  readonly kind: 'insurance' | 'patient';
  readonly ref: string;
  readonly buckets: Record<AgingBucket, number>;
  readonly totalCents: number;
}

export interface ArReport {
  readonly asOf: string;
  readonly rows: ArRow[];
  readonly totals: { insurance: Record<AgingBucket, number>; patient: Record<AgingBucket, number>; insuranceCents: number; patientCents: number; creditCents: number; totalCents: number };
}

const emptyBuckets = (): Record<AgingBucket, number> => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;

export function arReport(entries: readonly EntryRow[], asOf: Date): ArReport {
  const rows = new Map<string, ArRow>();
  const totals = { insurance: emptyBuckets(), patient: emptyBuckets(), insuranceCents: 0, patientCents: 0, creditCents: 0, totalCents: 0 };
  for (const item of openItems(entries)) {
    const insurance = item.account.kind === 'insurance_receivable';
    const ref = (insurance ? item.account.payerRef : item.account.patientRef) as string;
    const key = `${insurance ? 'insurance' : 'patient'}|${ref}`;
    const row = rows.get(key) ?? { key, kind: insurance ? 'insurance' : 'patient', ref, buckets: emptyBuckets(), totalCents: 0 };
    const bucket = agingBucket(item.serviceDate, asOf.toISOString().slice(0, 10));
    row.buckets[bucket] += item.cents;
    (row as { totalCents: number }).totalCents += item.cents;
    rows.set(key, row);
    totals[insurance ? 'insurance' : 'patient'][bucket] += item.cents;
    totals[insurance ? 'insuranceCents' : 'patientCents'] += item.cents;
  }
  for (const e of entries) if (e.account.kind === 'patient_credit') totals.creditCents -= e.cents;
  totals.totalCents = totals.insuranceCents + totals.patientCents;
  return { asOf: asOf.toISOString(), rows: [...rows.values()].sort((a, b) => b.totalCents - a.totalCents), totals };
}

export interface ReconcileCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly expectedCents?: number;
  readonly actualCents?: number;
  /** What expected/actual measure: cents unless the check counts rows. */
  readonly unit?: 'cents' | 'count';
}

/**
 * The reconciliation the gate asks for: the ledger balances, the A/R report ties to the account
 * balances, and the cash posted for each 835 equals the payer's stated total.
 */
export async function reconcile(store: LedgerStore, asOf = new Date()): Promise<{ ok: boolean; checks: ReconcileCheck[]; ar: ArReport; remittances: Awaited<ReturnType<LedgerStore['remittances']>> }> {
  const { totals, balances, entryPage, remittancePage } = await store.reconciliationSnapshot(10000);
  const entries = entryPage.entries;
  const remittances = remittancePage.remittances;
  const ar = arReport(entries, asOf);
  const sum = (kind: string) => balances.filter((b) => b.account.kind === kind).reduce((t, b) => t + b.cents, 0);
  const checks: ReconcileCheck[] = [
    { label: 'Every entry in the ledger sums to zero', ok: totals.entrySumCents === 0, expectedCents: 0, actualCents: totals.entrySumCents },
    { label: 'Every journal balances', ok: totals.unbalancedJournals === 0, expectedCents: 0, actualCents: totals.unbalancedJournals, unit: 'count' },
    { label: 'Insurance A/R on the dashboard equals the insurance receivable accounts', ok: ar.totals.insuranceCents === sum('insurance_receivable'), expectedCents: sum('insurance_receivable'), actualCents: ar.totals.insuranceCents },
    { label: 'Patient A/R on the dashboard equals the patient receivable accounts', ok: ar.totals.patientCents === sum('patient_receivable'), expectedCents: sum('patient_receivable'), actualCents: ar.totals.patientCents },
    { label: 'Patient credit on the dashboard equals the patient credit accounts', ok: ar.totals.creditCents === -sum('patient_credit'), expectedCents: -sum('patient_credit'), actualCents: ar.totals.creditCents },
    { label: 'Aging buckets add up to the A/R total', ok: BUCKETS.reduce((t, b) => t + ar.totals.insurance[b] + ar.totals.patient[b], 0) === ar.totals.totalCents, expectedCents: ar.totals.totalCents },
    { label: 'The entry list read for the dashboard is complete', ok: entries.length === entryPage.total && entryPage.total === totals.entries, expectedCents: totals.entries, actualCents: entries.length, unit: 'count' },
    { label: 'The remittance list read for reconciliation is complete', ok: remittances.length === remittancePage.total, expectedCents: remittancePage.total, actualCents: remittances.length, unit: 'count' },
  ];
  for (const r of remittances) {
    checks.push({ label: `Cash posted for remittance ${r.traceNumber} equals the payer's total`, ok: r.postedCashCents === r.paidCents, expectedCents: r.paidCents, actualCents: r.postedCashCents });
  }
  return { ok: checks.every((c) => c.ok), checks, ar, remittances };
}

export interface LedgerReportFilters {
  /** Inclusive business date. */
  readonly from?: string;
  /** Inclusive business date. */
  readonly to?: string;
  /** Aging and reconciliation cutoff date. */
  readonly asOf?: string;
}

export type LedgerReportValue = string | number | boolean | null;

export interface LedgerReportResult {
  readonly reportId: ReportId;
  readonly asOf: string;
  readonly filters: LedgerReportFilters;
  readonly rows: Record<string, LedgerReportValue>[];
  readonly totals: Record<string, number>;
  /** False if either bounded ledger read omitted records. */
  readonly complete: boolean;
  readonly source: 'ledger';
  readonly reconciliation?: { readonly ok: boolean; readonly checks: ReconcileCheck[] };
}

export interface LedgerReportDateBounds {
  readonly from?: string;
  /** Exclusive database bound for the inclusive `to` day. */
  readonly toExclusive?: string;
  readonly asOfDate: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, name: string): void {
  if (!DATE_ONLY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a real date in YYYY-MM-DD format.`);
  }
}

function plusDay(value: string): string {
  const d = new Date(`${value}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Validate calendar date filters once, then convert the inclusive `to` date to an exclusive bound. */
export function ledgerReportDateBounds(filters: LedgerReportFilters, today = new Date().toISOString().slice(0, 10)): LedgerReportDateBounds {
  assertDate(today, 'Current date');
  if (filters.from) assertDate(filters.from, 'Start date');
  if (filters.to) assertDate(filters.to, 'End date');
  if (filters.asOf) assertDate(filters.asOf, 'As-of date');
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('The start date must be on or before the end date.');
  return { from: filters.from, toExclusive: filters.to ? plusDay(filters.to) : undefined, asOfDate: filters.asOf ?? filters.to ?? today };
}

type JournalGroup = { id: string; key: string; kind: string; date: string; source: string; memo?: string; reversed: boolean; reverses?: string; lines: EntryRow[] };

function journalGroups(entries: readonly EntryRow[]): JournalGroup[] {
  const groups = new Map<string, JournalGroup>();
  for (const entry of entries) {
    const group = groups.get(entry.journalId) ?? {
      id: entry.journalId, key: entry.idempotencyKey, kind: entry.kind, date: entry.occurredAt,
      source: entry.source, memo: entry.memo, reversed: entry.reversed, reverses: entry.reverses, lines: [],
    };
    group.lines.push(entry);
    groups.set(entry.journalId, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function lineTotal(group: JournalGroup, kinds: readonly string[]): number {
  return group.lines.filter((line) => kinds.includes(line.account.kind)).reduce((sum, line) => sum + line.cents, 0);
}

function baseRow(group: JournalGroup): Record<string, LedgerReportValue> {
  const payer = group.lines.find((line) => line.account.kind === 'insurance_receivable')?.account.payerRef;
  const patient = group.lines.find((line) => line.account.patientRef)?.account.patientRef;
  const encounterRef = group.lines.find((line) => line.encounterRef)?.encounterRef;
  const claimRef = group.lines.find((line) => line.claimRef)?.claimRef;
  return {
    date: group.date.slice(0, 10), journalId: group.id, idempotencyKey: group.key, kind: group.kind,
    source: group.source, memo: group.memo ?? null, reversed: group.reversed,
    reverses: group.reverses ?? null, patientRef: patient ?? null, payerRef: payer ?? null,
    encounterRef: encounterRef ?? null, claimRef: claimRef ?? null,
  };
}

function remittanceRows(rows: Awaited<ReturnType<LedgerStore['remittancePage']>>['remittances']): Record<string, LedgerReportValue>[] {
  return rows.map((remittance) => ({
    date: remittance.paymentDate, traceNumber: remittance.traceNumber, payerRef: remittance.payerRef,
    claimCount: remittance.claimCount, payerReportedCents: remittance.paidCents,
    postedCashCents: remittance.postedCashCents, differenceCents: remittance.postedCashCents - remittance.paidCents,
    reconciled: remittance.postedCashCents === remittance.paidCents,
  }));
}

/** Pure ledger-backed report shaping; it never manufactures rows or derives money from FHIR. */
export function buildLedgerReport(
  reportId: ReportId,
  filters: LedgerReportFilters,
  entries: readonly EntryRow[],
  entryTotal: number,
  remittances: Awaited<ReturnType<LedgerStore['remittancePage']>>['remittances'] = [],
  remittanceTotal = 0,
  reconciliation?: Awaited<ReturnType<typeof reconcile>>,
): LedgerReportResult {
  const asOf = filters.asOf ?? filters.to ?? new Date().toISOString().slice(0, 10);
  const groups = journalGroups(entries);
  let rows: Record<string, LedgerReportValue>[] = [];
  let totals: Record<string, number> = {};
  let complete = entries.length === entryTotal && remittances.length === remittanceTotal;
  let checks: ReconcileCheck[] | undefined;

  switch (reportId) {
    case 'ar-aging-ledger': {
      const ar = arReport(entries, new Date(`${asOf}T23:59:59.999Z`));
      rows = ar.rows.map((row) => ({ kind: row.kind, ref: row.ref, ...row.buckets, totalCents: row.totalCents }));
      totals = { insuranceCents: ar.totals.insuranceCents, patientCents: ar.totals.patientCents, creditCents: ar.totals.creditCents, totalCents: ar.totals.totalCents };
      break;
    }
    case 'charges-by-period': {
      rows = groups.map((group) => ({ ...baseRow(group), amountCents: -lineTotal(group, ['revenue']) })).filter((row) => Number(row.amountCents) !== 0);
      totals = { chargesCents: rows.reduce((sum, row) => sum + Number(row.amountCents), 0) };
      break;
    }
    case 'collections-by-period': {
      rows = groups.filter((group) => group.kind === 'payment' || group.kind === 'reversal')
        .map((group) => ({ ...baseRow(group), amountCents: lineTotal(group, ['cash', 'card_clearing']) }))
        .filter((row) => Number(row.amountCents) !== 0);
      totals = { netCollectionCents: rows.reduce((sum, row) => sum + Number(row.amountCents), 0), postingCount: rows.length };
      break;
    }
    case 'payer-reimbursement':
      rows = remittanceRows(remittances);
      totals = { payerReportedCents: remittances.reduce((sum, row) => sum + row.paidCents, 0), postedCashCents: remittances.reduce((sum, row) => sum + row.postedCashCents, 0), remittanceCount: remittanceTotal };
      break;
    case 'adjustments-writeoffs': {
      rows = groups.map((group) => ({ ...baseRow(group), account: 'adjustments/write-offs', amountCents: lineTotal(group, ['contractual_adjustment', 'write_off']) })).filter((row) => Number(row.amountCents) !== 0);
      totals = { adjustmentsCents: rows.reduce((sum, row) => sum + Number(row.amountCents), 0), postingCount: rows.length };
      break;
    }
    case 'patient-credits-refunds': {
      rows = groups.map((group) => ({ ...baseRow(group), patientCreditMovementCents: lineTotal(group, ['patient_credit']), refundPayableMovementCents: lineTotal(group, ['refund_payable']) }))
        .filter((row) => Number(row.patientCreditMovementCents) !== 0 || Number(row.refundPayableMovementCents) !== 0);
      totals = {
        patientCreditMovementCents: rows.reduce((sum, row) => sum + Number(row.patientCreditMovementCents), 0),
        refundPayableMovementCents: rows.reduce((sum, row) => sum + Number(row.refundPayableMovementCents), 0),
        postingCount: rows.length,
      };
      break;
    }
    case 'remittance-reconciliation': {
      rows = remittanceRows(remittances);
      const mismatches = rows.filter((row) => row.reconciled === false).length;
      totals = {
        payerReportedCents: remittances.reduce((sum, row) => sum + row.paidCents, 0),
        postedCashCents: remittances.reduce((sum, row) => sum + row.postedCashCents, 0),
        differenceCents: remittances.reduce((sum, row) => sum + row.postedCashCents - row.paidCents, 0),
        mismatches, remittanceCount: remittanceTotal,
      };
      break;
    }
    case 'ledger-reconciliation': {
      checks = reconciliation?.checks ?? [];
      rows = checks.map((check) => ({ label: check.label, ok: check.ok, expectedCents: check.expectedCents ?? null, actualCents: check.actualCents ?? null, unit: check.unit ?? 'cents' }));
      totals = { checkCount: checks.length, failedChecks: checks.filter((check) => !check.ok).length };
      const dataChecks = reconciliation?.checks.filter((check) => check.label === 'The entry list read for the dashboard is complete' || check.label === 'The remittance list read for reconciliation is complete') ?? [];
      const reconciliationComplete = Boolean(reconciliation) && dataChecks.length === 2 && dataChecks.every((check) => check.ok);
      complete = complete && reconciliationComplete;
      break;
    }
  }
  return {
    reportId, asOf: new Date(`${asOf}T23:59:59.999Z`).toISOString(),
    filters: { ...filters, asOf }, rows, totals, complete, source: 'ledger',
    reconciliation: reportId === 'ledger-reconciliation' && reconciliation ? { ok: reconciliation.ok, checks: reconciliation.checks } : undefined,
  };
}

/** Read only actual ledger records. Reports are capped at 10,000 rows and expose completeness. */
export async function queryLedgerReport(store: LedgerStore, reportId: string, filters: LedgerReportFilters = {}, now = new Date()): Promise<LedgerReportResult> {
  const definition = getReportDefinition(reportId);
  if (!definition || definition.source !== 'ledger') throw new LedgerError(404, 'That financial report is not available.');
  let bounds: LedgerReportDateBounds;
  try {
    bounds = ledgerReportDateBounds(filters, now.toISOString().slice(0, 10));
  } catch (err) {
    throw new LedgerError(400, err instanceof Error ? err.message : 'The report date filters are not valid.');
  }
  // Reconciliation compares the current materialized account balances, all posted entries, and
  // every remittance in one database snapshot. It cannot truthfully represent an earlier date.
  if (reportId === 'ledger-reconciliation' && (filters.from || filters.to)) {
    throw new LedgerError(400, 'Ledger reconciliation is a current snapshot, not a period report. Clear the start and end dates, then run it again.');
  }
  if (reportId === 'ledger-reconciliation' && bounds.asOfDate !== now.toISOString().slice(0, 10)) {
    throw new LedgerError(400, 'Ledger reconciliation is a current snapshot. Remove the historical as-of date and run it again.');
  }
  if (reportId === 'ledger-reconciliation') {
    const reconciliation = await reconcile(store, now);
    return buildLedgerReport(reportId as ReportId, { ...filters, asOf: bounds.asOfDate }, [], 0, [], 0, reconciliation);
  }
  const entryBounds = reportId === 'ar-aging-ledger'
    ? { to: `${plusDay(bounds.asOfDate)}T00:00:00.000Z`, limit: 10000 }
    : { from: bounds.from ? `${bounds.from}T00:00:00.000Z` : undefined, to: bounds.toExclusive ? `${bounds.toExclusive}T00:00:00.000Z` : undefined, limit: 10000 };
  const wantsRemittances = reportId === 'payer-reimbursement' || reportId === 'remittance-reconciliation';
  const [entryPage, remittancePage] = await Promise.all([
    store.entriesPage(entryBounds),
    wantsRemittances ? store.remittancePage({ from: bounds.from, to: bounds.toExclusive, limit: 10000 }) : Promise.resolve({ remittances: [], total: 0 }),
  ]);
  const reconciliation = reportId === 'ledger-reconciliation' ? await reconcile(store, new Date(`${bounds.asOfDate}T23:59:59.999Z`)) : undefined;
  return buildLedgerReport(reportId as ReportId, { ...filters, asOf: bounds.asOfDate }, entryPage.entries, entryPage.total, remittancePage.remittances, remittancePage.total, reconciliation);
}
