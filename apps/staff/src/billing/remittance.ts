import type { MedplumClient } from '@medplum/core';
import type { Claim, ClaimResponse, Patient, PaymentReconciliation, Task } from '@medplum/fhirtypes';
import type { PayerConfig, Remittance, RemitClaim } from '@teleemon/core';
import { BILLING_TASKS, GENERATED_IDENTIFIER_SYSTEM, OPEN_TASK_STATUS_PARAM, REMITTANCE_IDENTIFIER_SYSTEM, readSettings, searchAll } from '@teleemon/core';
import { ledgerApi, type LedgerRemittance, type ReconciliationReport } from './ledgerApi';
import { collectEntries, errorMessage, idOf, patientsFrom, taskCodeParam } from './billingShared';

// P33 remittances: each 835 (PaymentReconciliation) against what the ledger posted under its trace,
// the open exceptions, and the stored raw and normalized 835 used to prefill a manual post.

export type { LedgerRemittance };

export interface RemitRow {
  readonly pr: PaymentReconciliation;
  readonly trace: string;
  readonly paymentDate?: string;
  readonly eftCents: number;
  readonly ledger?: LedgerRemittance;
  readonly claimCount: number;
  readonly openExceptions: number;
}

export interface ExceptionRow {
  readonly task: Task;
  readonly trace?: string;
  readonly patientControlNumber?: string;
  readonly patient?: Patient;
}

export interface RemitData {
  readonly payers: readonly PayerConfig[];
  readonly rows: readonly RemitRow[];
  readonly exceptions: readonly ExceptionRow[];
  /** The ledger's checks, or why they could not be read. */
  readonly ledger: { readonly report?: ReconciliationReport; readonly error?: string };
}

const traceOf = (t: Task): string | undefined => t.input?.find((i) => i.type?.text === 'trace number')?.valueString;
const pcnOf = (t: Task): string | undefined => t.input?.find((i) => i.type?.text === 'patient control number')?.valueString;

export async function loadRemittances(medplum: MedplumClient): Promise<RemitData> {
  const [settings, reconciliations, exceptionEntries, ledger] = await Promise.all([
    readSettings(medplum, 'billing'),
    searchAll(medplum, 'PaymentReconciliation', [['_sort', '-created'], ['_count', '200']]),
    collectEntries(medplum, 'Task', [['code', taskCodeParam(BILLING_TASKS.eraException)], ['status', OPEN_TASK_STATUS_PARAM], ['_include', 'Task:patient'], ['_sort', '-_lastUpdated'], ['_count', '200']]),
    ledgerApi.reconciliation(medplum).then(
      (report) => ({ report, error: undefined }),
      (err: unknown) => ({ report: undefined, error: errorMessage(err) })
    ),
  ]);
  const patients = patientsFrom(exceptionEntries);
  const exceptions: ExceptionRow[] = [];
  for (const e of exceptionEntries) {
    if (e.resource?.resourceType !== 'Task' || e.search?.mode === 'include') continue;
    const task = e.resource;
    const patientRef = task.for?.reference;
    exceptions.push({ task, trace: traceOf(task), patientControlNumber: pcnOf(task), patient: patientRef ? patients.get(patientRef) : undefined });
  }
  const openByTrace = new Map<string, number>();
  for (const x of exceptions) if (x.trace) openByTrace.set(x.trace, (openByTrace.get(x.trace) ?? 0) + 1);

  // The ledger's own remittance list, keyed by trace.
  const ledgerRows = new Map<string, LedgerRemittance>();
  for (const r of ledger.report?.remittances ?? []) ledgerRows.set(r.traceNumber, r);

  const rows: RemitRow[] = reconciliations
    .filter((pr) => pr.identifier?.some((i) => i.system === REMITTANCE_IDENTIFIER_SYSTEM))
    .map((pr) => {
      const trace = pr.identifier?.find((i) => i.system === REMITTANCE_IDENTIFIER_SYSTEM)?.value ?? '';
      return {
        pr,
        trace,
        paymentDate: pr.paymentDate,
        eftCents: Math.round((pr.paymentAmount?.value ?? 0) * 100),
        ledger: ledgerRows.get(trace),
        claimCount: pr.detail?.length ?? 0,
        openExceptions: openByTrace.get(trace) ?? 0,
      };
    });
  return { payers: settings.payers, rows, exceptions, ledger: { report: ledger.report, error: ledger.error } };
}

/** The claims and their ClaimResponses (277CA and 835) for one remittance. */
export async function loadRemitDetail(medplum: MedplumClient, pr: PaymentReconciliation): Promise<{ claims: Claim[]; responses: ClaimResponse[] }> {
  const claimIds = [...new Set((pr.detail ?? []).map((d) => idOf(d.request?.reference)).filter((x): x is string => x !== undefined))];
  if (claimIds.length === 0) return { claims: [], responses: [] };
  const claimRefs = claimIds.map((id) => `Claim/${id}`).join(',');
  const [claims, responses] = await Promise.all([
    medplum.searchResources('Claim', { _id: claimIds.join(','), _count: '200' }, { cache: 'no-cache' }),
    medplum.searchResources('ClaimResponse', { request: claimRefs, _sort: '-created', _count: '200' }, { cache: 'no-cache' }),
  ]);
  return { claims, responses };
}

/** The normalized 835 kept with the raw one, or undefined when it cannot be read. */
export async function storedRemittance(medplum: MedplumClient, trace: string): Promise<Remittance | undefined> {
  const doc = await medplum.searchOne('DocumentReference', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|era-raw:${trace}` }, { cache: 'no-cache' });
  const url = doc?.content?.[1]?.attachment?.url;
  if (!url) return undefined;
  const text = await (await medplum.download(url)).text();
  return JSON.parse(text) as Remittance;
}

export interface ExceptionContext {
  readonly trace?: string;
  readonly patientControlNumber?: string;
  /** Our claim, when the patient control number names one. */
  readonly claim?: Claim;
  /** The 835's line for that claim, when the stored remittance has it. */
  readonly remit?: RemitClaim;
  readonly remitNote?: string;
}

export async function exceptionContext(medplum: MedplumClient, task: Task): Promise<ExceptionContext> {
  const trace = traceOf(task);
  const pcn = pcnOf(task);
  const [claim, stored] = await Promise.all([
    pcn ? medplum.readResource('Claim', pcn, { cache: 'no-cache' }).catch(() => undefined) : Promise.resolve(undefined),
    trace ? storedRemittance(medplum, trace).then(
      (r) => ({ remit: r, error: undefined as string | undefined }),
      (err: unknown) => ({ remit: undefined, error: errorMessage(err) })
    ) : Promise.resolve({ remit: undefined, error: undefined as string | undefined }),
  ]);
  const remit = stored.remit?.claims.find((c) => c.patientControlNumber === pcn);
  let remitNote: string | undefined;
  if (!trace) remitNote = 'This exception names no trace number.';
  else if (stored.error) remitNote = `The stored 835 could not be read (${stored.error}). Enter the amounts from the remittance by hand.`;
  else if (!stored.remit) remitNote = 'The stored 835 is not available. Enter the amounts from the remittance by hand.';
  else if (!remit) remitNote = 'The stored 835 has no line for this patient control number.';
  return { trace, patientControlNumber: pcn, claim, remit, remitNote };
}
