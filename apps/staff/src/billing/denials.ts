import type { MedplumClient } from '@medplum/core';
import type { Claim, DocumentReference, Patient, Task } from '@medplum/fhirtypes';
import type { BillingSettings, DenialCategory, PayerAdjustmentReason, PayerConfig } from '@teleemon/core';
import { BILLING_TASKS, CODE_SYSTEMS, DENIAL_ACTIONS, GENERATED_IDENTIFIER_SYSTEM, OPEN_TASK_STATUS_PARAM, REVENUE_EXT, categorizeDenial, daysBetweenDates, readSettings } from '@teleemon/core';
import { ledgerApi } from './ledgerApi';
import type { PostResult } from './ledgerApi';
import { cancelledTask, collectEntries, completedTask, idOf, patientsFrom, practiceToday, setTaskState, taskCodeParam } from './billingShared';
import { closeClaim, moveClaim, payerOfClaim, visitOf } from './claimWork';

// P34 denials: open denial Tasks by appeal deadline, each with its reason codes and the recommended
// next step. Every action here is one write the server checks; a refusal is shown as the server wrote it.

export interface DenialRow {
  readonly task: Task;
  readonly claim?: Claim;
  readonly patient?: Patient;
  /** CARC codes the payer gave, from the Task's note. */
  readonly carc: readonly string[];
  readonly category: DenialCategory;
  readonly action: string;
  /** YYYY-MM-DD appeal deadline. */
  readonly deadline?: string;
  /** Whole days until the deadline; negative once passed. */
  readonly days?: number;
}

export interface DenialData {
  readonly rows: readonly DenialRow[];
  readonly payers: readonly PayerConfig[];
  readonly policy: BillingSettings['policy'];
  readonly today: string;
}

export const CATEGORY_LABEL: Record<DenialCategory, string> = {
  eligibility: 'Eligibility',
  authorization: 'Authorization',
  coding: 'Coding',
  'timely-filing': 'Timely filing',
  duplicate: 'Duplicate',
  'medical-necessity': 'Medical necessity',
  other: 'Other',
};

/** The reason codes the worker wrote into the note: "(reason codes 197, 15)". */
export function carcFromNote(task: Task): string[] {
  const text = (task.note ?? []).map((n) => n.text ?? '').join('\n');
  const m = /\(reason codes ([^)]*)\)/.exec(text);
  if (!m?.[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'none');
}

const deadlineOf = (task: Task): string | undefined => task.extension?.find((e) => e.url === REVENUE_EXT.appealDeadline)?.valueDate ?? task.restriction?.period?.end?.slice(0, 10);

export async function loadDenials(medplum: MedplumClient): Promise<DenialData> {
  const today = practiceToday();
  const [settings, entries] = await Promise.all([
    readSettings(medplum, 'billing'),
    collectEntries(medplum, 'Task', [['code', taskCodeParam(BILLING_TASKS.denial)], ['status', OPEN_TASK_STATUS_PARAM], ['_include', 'Task:patient'], ['_count', '200']]),
  ]);
  const patients = patientsFrom(entries);
  const tasks: Task[] = [];
  for (const e of entries) if (e.resource?.resourceType === 'Task' && e.search?.mode !== 'include') tasks.push(e.resource);

  const claimIds = [...new Set(tasks.map((t) => idOf(t.focus?.reference)).filter((x): x is string => x !== undefined))];
  const claims = new Map<string, Claim>();
  for (let i = 0; i < claimIds.length; i += 40) {
    for (const c of await medplum.searchResources('Claim', { _id: claimIds.slice(i, i + 40).join(','), _count: '40' }, { cache: 'no-cache' })) {
      claims.set(`Claim/${c.id}`, c);
    }
  }

  const rows: DenialRow[] = tasks.map((task): DenialRow => {
    const carc = carcFromNote(task);
    const category = categorizeDenial(carc);
    const deadline = deadlineOf(task);
    const claim = task.focus?.reference ? claims.get(task.focus.reference) : undefined;
    const patientRef = task.for?.reference;
    return {
      task,
      claim,
      patient: patientRef ? patients.get(patientRef) : undefined,
      carc,
      category,
      action: DENIAL_ACTIONS[category],
      deadline,
      days: deadline ? daysBetweenDates(today, deadline) : undefined,
    };
  });
  // Overdue first, then the nearest deadline; no deadline last.
  rows.sort((a, b) => (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER));
  return { rows, payers: settings.payers, policy: settings.policy, today };
}

/** The appeal letter as a draft: the facts are filled in; the explanation and signature are for the biller. */
export function appealLetterDraft(row: DenialRow, patientName: string, payerName: string): string {
  const c = row.claim;
  const amount = c?.total?.value === undefined ? 'not recorded' : `$${c.total.value.toFixed(2)}`;
  const dos = c?.billablePeriod?.start ?? 'not recorded';
  return [
    'Re: Request to review and reverse a claim denial',
    '',
    `Patient: ${patientName}`,
    `Payer: ${payerName}`,
    `Claim: ${c?.id ?? 'not recorded'}`,
    `Date of service: ${dos}`,
    `Amount billed: ${amount}`,
    `Denial reason codes: ${row.carc.join(', ') || 'none given'}`,
    `Denial category: ${CATEGORY_LABEL[row.category]}`,
    `Appeal deadline: ${row.deadline ?? 'not recorded'}`,
    '',
    'We ask the payer to review this denial and reverse it.',
    '',
    '[Explain why the service was medically necessary and was billed as documented. Attach the clinical note and any authorization on file.]',
    '',
    'Sincerely,',
    '[Name, title]',
    '[Practice name and address]',
  ].join('\n');
}

const APPEAL_IDENTIFIER = (claimId: string): string => `appeal:${claimId}`;

/** The appeal letter saved for a claim, when one has been started. */
export async function storedAppealLetter(medplum: MedplumClient, claimId: string): Promise<string | undefined> {
  const doc = await medplum.searchOne('DocumentReference', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${APPEAL_IDENTIFIER(claimId)}` }, { cache: 'no-cache' });
  const url = doc?.content?.[0]?.attachment?.url;
  if (!url) return undefined;
  return (await medplum.download(url)).text();
}

/**
 * Starts the appeal: saves the letter for the patient (billing documents), then moves the claim to
 * appealed and the Task to in progress. The letter is saved first, so a retry finds it and does not repeat it.
 */
export async function startAppeal(medplum: MedplumClient, row: DenialRow, letter: string, now = new Date()): Promise<void> {
  const claim = row.claim;
  const claimId = claim?.id;
  const patientRef = claim?.patient?.reference;
  if (!claim || !claimId || !patientRef) throw new Error('This denial has no claim to appeal.');
  const identifier = `${GENERATED_IDENTIFIER_SYSTEM}|${APPEAL_IDENTIFIER(claimId)}`;
  const existing = await medplum.searchOne('DocumentReference', { identifier }, { cache: 'no-cache' });
  if (!existing) {
    const binary = await medplum.createBinary(letter, `appeal-${claimId.slice(0, 8)}.txt`, 'text/plain');
    const doc: DocumentReference = {
      resourceType: 'DocumentReference',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: APPEAL_IDENTIFIER(claimId) }],
      status: 'current',
      type: { text: 'Appeal letter' },
      category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'billing', display: 'Billing' }] }],
      subject: { reference: patientRef },
      date: now.toISOString(),
      description: `Appeal letter for claim ${claimId.slice(0, 8)}`,
      content: [{ attachment: { contentType: 'text/plain', url: `Binary/${binary.id}`, title: `Appeal letter ${now.toISOString().slice(0, 10)}.txt` } }],
    };
    await medplum.createResourceIfNoneExist(doc, new URLSearchParams({ identifier }).toString());
  }
  await moveClaim(medplum, claimId, 'appealed');
  await setTaskState(medplum, row.task.id ?? '', (t) => ({ ...t, status: 'in-progress', lastModified: now.toISOString() }));
}

/**
 * Moves what the payer still owes on this visit to the patient. The ledger refuses an amount above
 * the payer's remaining balance for the visit; that refusal is returned as the server wrote it.
 */
export function transferToPatient(medplum: MedplumClient, row: DenialRow, cents: number, memo: string, key: string): Promise<PostResult[]> {
  const claim = row.claim;
  const encounterId = idOf(claim ? visitOf(claim) : undefined);
  const payerRef = claim ? payerOfClaim(claim) : undefined;
  const patientId = idOf(claim?.patient?.reference);
  if (!claim?.id || !patientId || !encounterId || !payerRef) throw new Error('The claim does not name its patient, visit and payer, so the balance cannot be moved.');
  return ledgerApi.transfer(medplum, { key, patientId, payerRef, encounterId, claimId: claim.id, cents, memo });
}

/**
 * Writes down what the payer still owes on the claim's visit, for a reason the payer will not pay.
 * The patient balance is not touched. The ledger refuses more than the payer owes on that visit.
 */
export function writeDownPayer(medplum: MedplumClient, row: DenialRow, cents: number, reason: PayerAdjustmentReason, key: string): Promise<PostResult[]> {
  const claim = row.claim;
  const encounterId = idOf(claim ? visitOf(claim) : undefined);
  const payerRef = claim ? payerOfClaim(claim) : undefined;
  if (!claim?.id || !encounterId || !payerRef) throw new Error('The claim does not name its visit and payer, so the payer balance cannot be written down.');
  return ledgerApi.payerAdjustment(medplum, { key, claimId: claim.id, encounterId, payerRef, cents, reason });
}

/** Closes the denial with a reason. The claim closes too when the server allows it (denied or appealed). */
export async function closeDenial(medplum: MedplumClient, row: DenialRow, reason: string, closeClaimToo: boolean): Promise<void> {
  if (closeClaimToo && row.claim?.id) await closeClaim(medplum, row.claim.id, reason);
  await setTaskState(medplum, row.task.id ?? '', (t) => cancelledTask(t, reason));
}

/** Marks the denial done once the claim has been paid or closed. */
export function markDenialDone(medplum: MedplumClient, row: DenialRow, note?: string): Promise<Task> {
  return setTaskState(medplum, row.task.id ?? '', (t) => completedTask(t, note));
}

/** The patient's account, used to decide whether a write-off of their balance is possible. */
export const patientOwed = async (medplum: MedplumClient, patientId: string): Promise<number> => (await ledgerApi.account(medplum, patientId)).owedCents;
