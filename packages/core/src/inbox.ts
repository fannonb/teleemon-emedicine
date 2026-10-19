// Inbox, tasks, documents and fax (P03, P16, P28, P29; SYSTEM-DESIGN.md §6). Every actionable
// item is a Task (or, for patient texts, a Communication), so one rule covers them all: it ends
// completed, or closed with a reason. Faxes are never deleted, and a document is never filed to a
// patient without a person confirming the match.

import type { Communication, DocumentReference, Patient, Task } from '@medplum/fhirtypes';
import { addBusinessDays } from './prescribing';
import type { DocumentCategoryCode } from './fhir';
import { CODE_SYSTEMS, EXT, TELEEMON_BASE } from './fhir';

export const TEAM_SYSTEM = `${TELEEMON_BASE}/CodeSystem/team`;
export const DOCUMENT_TYPE_SYSTEM = `${TELEEMON_BASE}/CodeSystem/document-type`;

export type Team = 'frontdesk' | 'provider' | 'biller';
export const TEAMS: { value: Team; label: string }[] = [
  { value: 'frontdesk', label: 'Front desk' },
  { value: 'provider', label: 'Providers' },
  { value: 'biller', label: 'Billing' },
];

export const OPEN_TASK_STATUSES: Task['status'][] = ['draft', 'requested', 'received', 'accepted', 'ready', 'in-progress', 'on-hold'];
export const OPEN_TASK_STATUS_PARAM = OPEN_TASK_STATUSES.join(',');
/** Closing a Task any way other than "completed" needs a reason (statusReason.text). */
export const CLOSED_WITH_REASON: Task['status'][] = ['cancelled', 'rejected', 'failed', 'entered-in-error'];
export const MIN_REASON = 5;

export type InboxKind = 'fax' | 'message' | 'result' | 'refill' | 'safety' | 'task';
export const INBOX_KINDS: { value: InboxKind; label: string }[] = [
  { value: 'message', label: 'Messages' },
  { value: 'fax', label: 'Faxes' },
  { value: 'result', label: 'Results' },
  { value: 'refill', label: 'Refills' },
  { value: 'safety', label: 'Safety' },
  { value: 'task', label: 'Tasks' },
];

export function taskCode(t: Task): string | undefined {
  return t.code?.coding?.find((c) => c.system === CODE_SYSTEMS.taskCode)?.code;
}

export function inboxKind(t: Task): InboxKind {
  switch (taskCode(t)) {
    case 'fax-review':
      return 'fax';
    case 'result-review':
      return 'result';
    case 'rx-renewal':
      return 'refill';
    case 'safety-review':
      return 'safety';
    default:
      return 'task';
  }
}

/** Team a Task belongs to: explicit performerType, otherwise the default for its kind. */
export function taskTeam(t: Task): Team {
  const explicit = t.performerType?.flatMap((p) => p.coding ?? []).find((c) => c.system === TEAM_SYSTEM)?.code as Team | undefined;
  if (explicit) return explicit;
  switch (taskCode(t)) {
    case 'fax-review':
      return 'frontdesk';
    default:
      return t.owner?.reference?.startsWith('Practitioner/') ? 'provider' : 'frontdesk';
  }
}

export function teamCoding(team: Team): NonNullable<Task['performerType']> {
  return [{ coding: [{ system: TEAM_SYSTEM, code: team, display: TEAMS.find((t) => t.value === team)?.label }] }];
}

export function isOverdue(t: Task, now = new Date()): boolean {
  const due = t.restriction?.period?.end;
  return !!due && OPEN_TASK_STATUSES.includes(t.status) && Date.parse(due) < now.getTime();
}

/** Why closing or changing this Task is refused, or undefined. Shared by the UI and the task-rules Bot. */
export function taskCloseProblem(before: Task | undefined, after: Task): string | undefined {
  const closing = CLOSED_WITH_REASON.includes(after.status) && before?.status !== after.status;
  if (closing && (after.statusReason?.text ?? '').trim().length < MIN_REASON) {
    return 'Give a reason (at least 5 characters) when cancelling, rejecting or closing a task without completing it.';
  }
  if (before && !OPEN_TASK_STATUSES.includes(before.status) && OPEN_TASK_STATUSES.includes(after.status) && taskCode(before) === 'fax-review') {
    return 'A filed fax review cannot be reopened. Re-file the document from the fax centre instead.';
  }
  return undefined;
}

// ---- Recurring tasks (P29) ----

export type Recurrence = 'daily' | 'weekly' | 'every-2-weeks' | 'monthly' | 'quarterly';
export const RECURRENCES: { value: Recurrence; label: string }[] = [
  { value: 'daily', label: 'Every business day' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'every-2-weeks', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Every 3 months' },
];

export function taskRecurrence(t: Task): Recurrence | undefined {
  const value = t.extension?.find((e) => e.url === EXT.recurrence)?.valueCode;
  return RECURRENCES.some((r) => r.value === value) ? value as Recurrence : undefined;
}

export function nextDue(due: Date, rule: Recurrence): Date {
  const d = new Date(due.getTime());
  if (rule === 'daily') return addBusinessDays(d, 1);
  if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  if (rule === 'every-2-weeks') d.setUTCDate(d.getUTCDate() + 14);
  if (rule === 'monthly' || rule === 'quarterly') {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + (rule === 'monthly' ? 1 : 3));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/** The next occurrence of a completed recurring task, linked to the one it follows. */
export function nextOccurrence(done: Task, now = new Date()): Task | undefined {
  const rule = taskRecurrence(done);
  if (!rule || done.status !== 'completed' || !done.id) return undefined;
  const base = done.restriction?.period?.end ? new Date(done.restriction.period.end) : now;
  if (!Number.isFinite(base.getTime())) return undefined;
  // Missed occurrences do not generate a backlog or an unbounded catch-up loop.
  const due = nextDue(base.getTime() < now.getTime() ? now : base, rule);
  return {
    resourceType: 'Task',
    status: 'requested',
    intent: done.intent,
    priority: done.priority,
    code: done.code,
    description: done.description,
    for: done.for,
    owner: done.owner,
    performerType: done.performerType,
    authoredOn: now.toISOString(),
    restriction: { period: { end: due.toISOString() } },
    partOf: [{ reference: `Task/${done.id}` }],
    extension: done.extension?.filter((e) => e.url === EXT.recurrence),
  };
}

// ---- Documents and fax (P28) ----

export function isInboundFax(doc: DocumentReference): boolean {
  return !!doc.type?.coding?.some((c) => c.system === DOCUMENT_TYPE_SYSTEM && c.code === 'inbound-fax');
}

/** A person confirmed which patient a document belongs to: who, and when. */
export function matchConfirmation(r: DocumentReference | Communication): { by?: string; at?: string } {
  const e = r.extension?.find((x) => x.url === EXT.matchConfirmed);
  return { by: e?.extension?.find((x) => x.url === 'by')?.valueReference?.reference, at: e?.extension?.find((x) => x.url === 'at')?.valueDateTime };
}

export function confirmMatchExtension(by: string, at = new Date()): NonNullable<DocumentReference['extension']>[number] {
  return { url: EXT.matchConfirmed, extension: [{ url: 'by', valueReference: { reference: by } }, { url: 'at', valueDateTime: at.toISOString() }] };
}

/**
 * Why a change to an inbound fax (or an unmatched message) is refused, or undefined. `author` is
 * the signed-in user Medplum stamps on the change.
 *   - Assigning or changing the patient needs a fresh confirmation by the same person.
 *   - Removing it from the queue (entered-in-error) needs a reason; faxes are never deleted.
 */
export function matchProblem(before: { subject?: { reference?: string } } & (DocumentReference | Communication) | undefined, after: DocumentReference | Communication, author: string | undefined, now = new Date()): string | undefined {
  const subject = after.subject?.reference;
  if (before?.subject?.reference && !subject) return 'A filed item cannot be unlinked from its patient.';
  if (subject && subject !== before?.subject?.reference) {
    if (!subject.startsWith('Patient/')) return 'Documents are filed to patients only.';
    const c = matchConfirmation(after);
    const at = Date.parse(c.at ?? '');
    if (!c.by || c.by !== author || !Number.isFinite(at) || Math.abs(now.getTime() - at) > 10 * 60000) {
      return 'Confirm the patient match (name and date of birth on the document) before filing.';
    }
  }
  if (after.status === 'entered-in-error' && before?.status !== 'entered-in-error') {
    const reason = after.extension?.find((e) => e.url === EXT.removalReason)?.valueString ?? '';
    if (reason.trim().length < MIN_REASON) return 'Give a reason (at least 5 characters) for removing this item; nothing is deleted.';
  }
  return undefined;
}

export interface FaxSuggestion {
  readonly patientId?: string;
  readonly confidence: 'high' | 'medium' | 'low' | 'none';
  readonly reasons: string[];
  readonly category?: DocumentCategoryCode;
  readonly categoryReason?: string;
  /** Data parsed from the fax text, shown to the person confirming. */
  readonly parsed: { names: string[]; birthDates: string[] };
}

const norm = (s: string | undefined): string => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Dates in the text that look like birth dates, as YYYY-MM-DD. */
export function parseDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) {
    const [mm, dd, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy > 1900) out.add(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  return [...out];
}

/** Name fields such as "Patient: Lee, Priya", "Name: Priya Lee" or "RE: Priya Lee". */
export function parseNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:\s*)(?:patient(?: name)?|name|re|pt)\s*[:\-]\s*(.+)$/gim)) {
    const raw = m[1].split(/\s{2,}|\b(?:dob|d\.o\.b\.|date of birth)\b/i)[0].trim();
    if (!raw) continue;
    out.push(raw.includes(',') ? raw.split(',').map((s) => s.trim()).reverse().join(' ') : raw);
  }
  return out;
}

const CATEGORY_KEYWORDS: { category: DocumentCategoryCode; words: RegExp; reason: string }[] = [
  { category: 'lab-report', words: /\b(lab(oratory)? (report|results?)|specimen|reference range|collected|lithium level|cbc|cmp|tsh|a1c|lipid panel|urine drug)\b/i, reason: 'mentions lab results' },
  { category: 'prior-authorization', words: /\b(prior auth(orization)?|pa request|authorization (approved|denied)|formulary)\b/i, reason: 'mentions prior authorization' },
  { category: 'outside-records', words: /\b(medical records|discharge summary|progress notes?|records request|consult(ation)? note|referral)\b/i, reason: 'looks like outside records or a referral' },
  { category: 'legal', words: /\b(subpoena|court|attorney|legal)\b/i, reason: 'mentions legal matters' },
  { category: 'billing', words: /\b(invoice|statement|eob|explanation of benefits|remittance)\b/i, reason: 'looks like billing' },
  { category: 'correspondence', words: /\b(refill|renewal request|pharmacy)\b/i, reason: 'pharmacy or refill correspondence' },
];

/**
 * Suggests the patient and category for an inbound fax from its text (vendor OCR). The patient is
 * only ever a suggestion: filing still needs a person to confirm the match.
 * `candidates` are patients sharing a birth date found in the text.
 */
export function suggestFax(text: string, candidates: Patient[]): FaxSuggestion {
  const names = parseNames(text);
  const birthDates = parseDates(text);
  const cat = CATEGORY_KEYWORDS.find((k) => k.words.test(text));
  const base = { category: cat?.category, categoryReason: cat?.reason, parsed: { names, birthDates } };
  const scored = candidates
    .filter((p) => p.birthDate && birthDates.includes(p.birthDate) && p.active !== false)
    .map((p) => {
      const family = norm(p.name?.[0]?.family);
      const given = norm(p.name?.[0]?.given?.[0]);
      const reasons = ['date of birth matches'];
      let score = 1;
      const tokens = names.flatMap((n) => n.split(/\s+/).map(norm)).filter(Boolean);
      if (family && tokens.includes(family)) { score += 2; reasons.push('last name matches'); }
      if (given && tokens.includes(given)) { score += 1; reasons.push('first name matches'); }
      return { p, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { ...base, confidence: 'none', reasons: birthDates.length ? ['no patient with that date of birth'] : ['no date of birth found'] };
  const tie = scored[1] && scored[1].score === best.score;
  const confidence = tie ? 'low' : best.score >= 4 ? 'high' : best.score >= 3 ? 'medium' : 'low';
  return { ...base, patientId: tie ? undefined : best.p.id, confidence, reasons: tie ? ['more than one patient matches; choose manually'] : best.reasons };
}

export const FAX_REVIEW_SLA_BUSINESS_DAYS = 1;
export const RESULT_REVIEW_SLA_BUSINESS_DAYS = 2;
