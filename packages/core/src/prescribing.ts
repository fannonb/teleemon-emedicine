// Prescribing rules (P25, P26; SYSTEM-DESIGN.md §6). One set of rules shared by the prescribe
// form, the prescription-rules pre-commit Bot and the worker, so the screen and the server can
// never disagree. Vendor-neutral: the e-prescribing vendor (and its EPCS two-factor signing)
// sits behind the worker's adapter; these rules run before anything is handed to it.

import type { Encounter, MedicationRequest, Patient, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { checkLicensure, readCredentials, credentialStatus } from './licensure';
import type { MedicationEntry, Schedule } from './medications';
import { SCHEDULE_LABEL, findMedication } from './medications';
import { CODE_SYSTEMS, EXT } from './fhir';

export type ErxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancel-requested' | 'cancelled';
export type PdmpResult = 'no-concerns' | 'concerns-discussed' | 'not-prescribing';

export const PDMP_RESULTS: { value: PdmpResult; label: string }[] = [
  { value: 'no-concerns', label: 'Reviewed – no concerns' },
  { value: 'concerns-discussed', label: 'Reviewed – concerns discussed with patient' },
  { value: 'not-prescribing', label: 'Reviewed – not prescribing' },
];

/** A controlled prescription needs a PDMP check no older than this (scope P25). */
export const PDMP_WINDOW_HOURS = 24;
/** Renewal and change requests are answered or escalated within this many business days (P26). */
export const RENEWAL_SLA_BUSINESS_DAYS = 2;

export interface RxDraft {
  readonly medication: string;
  /** Directions for the patient, e.g. "Take 1 tablet by mouth every morning". */
  readonly sig: string;
  readonly quantity: number;
  readonly unit: string;
  readonly daysSupply: number;
  readonly refills: number;
  readonly pharmacy: string;
  /** Where the patient is physically located now (licensure and DEA follow the patient). */
  readonly state: string;
  readonly substitutionAllowed: boolean;
  readonly noteToPharmacy?: string;
}

/** DEA registration schedule code that covers a medication: 2, 2N, 3, 3N, 4 or 5. */
export function deaScheduleCode(entry: Pick<MedicationEntry, 'schedule' | 'narcotic'>): string | undefined {
  if (!entry.schedule) return undefined;
  return (entry.schedule === '2' || entry.schedule === '3') && !entry.narcotic ? `${entry.schedule}N` : entry.schedule;
}

export function rxSchedule(mr: MedicationRequest): Schedule | undefined {
  return findMedication(rxMedication(mr))?.schedule;
}

export function rxMedication(mr: MedicationRequest): string {
  return mr.medicationCodeableConcept?.text ?? mr.medicationCodeableConcept?.coding?.[0]?.display ?? '';
}

export function erxStatus(mr: MedicationRequest): ErxStatus | undefined {
  return mr.extension?.find((e) => e.url === EXT.erxStatus)?.valueCode as ErxStatus | undefined;
}

function ext(mr: MedicationRequest, url: string): string | undefined {
  const e = mr.extension?.find((x) => x.url === url);
  return e?.valueString ?? e?.valueCode ?? e?.valueReference?.reference;
}

export function readRx(mr: MedicationRequest): RxDraft {
  const d = mr.dispenseRequest;
  return {
    medication: rxMedication(mr),
    sig: mr.dosageInstruction?.[0]?.text ?? '',
    quantity: d?.quantity?.value ?? 0,
    unit: d?.quantity?.unit ?? 'tablet',
    daysSupply: d?.expectedSupplyDuration?.value ?? 0,
    refills: d?.numberOfRepeatsAllowed ?? 0,
    pharmacy: ext(mr, EXT.pharmacy) ?? '',
    state: ext(mr, EXT.patientLocationState) ?? '',
    substitutionAllowed: mr.substitution?.allowedBoolean ?? true,
    noteToPharmacy: mr.note?.[0]?.text,
  };
}

/** Builds the MedicationRequest for a draft. The worker adds the vendor identifier when sent. */
export function buildMedicationRequest(
  rx: RxDraft,
  opts: { patient: Reference<Patient>; requester: Reference<Practitioner>; encounter?: Reference<Encounter>; send: boolean; pdmpTaskId?: string; base?: MedicationRequest; basedOn?: Reference<MedicationRequest> }
): MedicationRequest {
  const entry = findMedication(rx.medication);
  const keep = (opts.base?.extension ?? []).filter((e) => ![EXT.pharmacy, EXT.patientLocationState, EXT.pdmpCheck, EXT.controlledSchedule, EXT.erxStatus, EXT.erxError].includes(e.url as never));
  return {
    ...(opts.base ?? {}),
    resourceType: 'MedicationRequest',
    status: opts.send ? 'active' : 'draft',
    intent: 'order',
    subject: opts.patient,
    requester: opts.requester,
    encounter: opts.encounter ?? opts.base?.encounter,
    basedOn: opts.basedOn ? [opts.basedOn] : opts.base?.basedOn,
    authoredOn: new Date().toISOString(),
    medicationCodeableConcept: { text: entry?.name ?? rx.medication.trim() },
    dosageInstruction: [{ text: rx.sig.trim() }],
    dispenseRequest: {
      quantity: { value: rx.quantity, unit: rx.unit },
      expectedSupplyDuration: { value: rx.daysSupply, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' },
      numberOfRepeatsAllowed: rx.refills,
    },
    substitution: { allowedBoolean: rx.substitutionAllowed },
    note: rx.noteToPharmacy?.trim() ? [{ text: rx.noteToPharmacy.trim() }] : undefined,
    extension: [
      ...keep,
      { url: EXT.pharmacy, valueString: rx.pharmacy.trim() },
      ...(rx.state ? [{ url: EXT.patientLocationState, valueCode: rx.state }] : []),
      ...(entry?.schedule ? [{ url: EXT.controlledSchedule, valueCode: entry.schedule }] : []),
      ...(opts.pdmpTaskId ? [{ url: EXT.pdmpCheck, valueReference: { reference: `Task/${opts.pdmpTaskId}` } }] : []),
      ...(opts.send ? [{ url: EXT.erxStatus, valueCode: 'queued' }] : []),
    ],
  };
}

export function isPdmpTask(t: Task): boolean {
  return !!t.code?.coding?.some((c) => c.system === CODE_SYSTEMS.taskCode && c.code === 'pdmp-check');
}

export function pdmpState(t: Task): string | undefined {
  return t.input?.find((i) => i.type.text === 'state')?.valueString;
}

export function pdmpCheckedAt(t: Task): string | undefined {
  return t.executionPeriod?.end;
}

/** The most recent completed PDMP check for this state that is still inside the 24-hour window. */
export function currentPdmpCheck(tasks: Task[], state: string, now = new Date()): Task | undefined {
  const earliest = now.getTime() - PDMP_WINDOW_HOURS * 3600000;
  return tasks
    .filter((t) => isPdmpTask(t) && t.status === 'completed' && pdmpState(t) === state)
    .filter((t) => {
      const at = Date.parse(pdmpCheckedAt(t) ?? '');
      // Small allowance for clock skew; a check dated in the future is not accepted.
      return Number.isFinite(at) && at >= earliest && at <= now.getTime() + 5 * 60000;
    })
    .sort((a, b) => (pdmpCheckedAt(b) ?? '').localeCompare(pdmpCheckedAt(a) ?? ''))[0];
}

/** A completed PDMP check, recorded by the prescriber after reviewing the state database. */
export function buildPdmpTask(input: { patient: Reference<Patient>; practitioner: Reference<Practitioner>; state: string; result: PdmpResult; note?: string; checkedAt?: string }): Task {
  const at = input.checkedAt ?? new Date().toISOString();
  return {
    resourceType: 'Task',
    status: 'completed',
    intent: 'order',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'pdmp-check' }], text: 'PDMP check' },
    description: `PDMP reviewed for ${input.state}`,
    for: input.patient,
    owner: input.practitioner,
    requester: input.practitioner,
    authoredOn: at,
    executionPeriod: { start: at, end: at },
    input: [{ type: { text: 'state' }, valueString: input.state }],
    extension: [{ url: EXT.pdmpResult, valueCode: input.result }],
    note: input.note?.trim() ? [{ text: input.note.trim() }] : undefined,
  };
}

export interface RxContext {
  readonly practitioner: Practitioner | undefined;
  /** PDMP check Tasks for this patient. */
  readonly pdmpChecks: Task[];
  readonly now?: Date;
}

/**
 * Everything that stops this prescription being sent, in plain English. Empty means it may be
 * sent. The pre-commit Bot calls this with server data; the form calls it to explain the block.
 */
export function prescriptionProblems(rx: RxDraft, ctx: RxContext): string[] {
  const problems: string[] = [];
  const now = ctx.now ?? new Date();
  const entry = findMedication(rx.medication);
  if (!entry) problems.push('Choose a medication from the catalogue. Free-text drugs need the e-prescribing vendor’s drug database (RxNorm).');
  if (!rx.sig.trim()) problems.push('Enter the directions (sig).');
  if (!Number.isFinite(rx.quantity) || !(rx.quantity > 0)) problems.push('Enter a finite quantity greater than zero.');
  if (!Number.isInteger(rx.daysSupply) || rx.daysSupply < 1 || rx.daysSupply > 90) problems.push('Days supply must be a whole number from 1 to 90.');
  if (!Number.isInteger(rx.refills) || rx.refills < 0) problems.push('Refills must be zero or more.');
  if (!rx.pharmacy.trim()) problems.push('Choose the pharmacy.');
  if (!rx.unit.trim()) problems.push('Enter the dispensing unit.');
  if (!ctx.practitioner) problems.push('Only a provider can send prescriptions.');

  const today = now.toISOString().slice(0, 10);
  const licence = checkLicensure(ctx.practitioner, rx.state || undefined, today, { controlled: !!entry?.schedule });
  if (!licence.ok) problems.push(licence.reason as string);
  else if (licence.credential?.prescriptiveAuthority === false) problems.push(`The ${rx.state} licence on file does not include prescriptive authority.`);

  if (entry?.schedule) {
    const label = SCHEDULE_LABEL[entry.schedule];
    const code = deaScheduleCode(entry) as string;
    const dea = readCredentials(ctx.practitioner).find((c) => c.kind === 'dea-registration' && c.state === rx.state && ['active', 'expiring'].includes(credentialStatus(c, today)));
    if (licence.ok && dea && dea.schedules?.length && !dea.schedules.includes(code)) problems.push(`The ${rx.state} DEA registration does not cover schedule ${code} (${label}).`);
    if (entry.schedule === '2' && rx.refills > 0) problems.push(`${label} prescriptions cannot have refills; issue a new prescription instead.`);
    if (entry.schedule !== '2' && rx.refills > 5) problems.push(`${label} prescriptions allow at most 5 refills.`);
    if (rx.state && !currentPdmpCheck(ctx.pdmpChecks, rx.state, now)) problems.push(`Controlled substance: record a ${rx.state} PDMP check from the last ${PDMP_WINDOW_HOURS} hours before sending.`);
    if (currentPdmpCheck(ctx.pdmpChecks, rx.state, now)?.extension?.some((e) => e.url === EXT.pdmpResult && e.valueCode === 'not-prescribing')) problems.push('The latest PDMP review records a decision not to prescribe. Record a new review before proceeding.');
  } else if (rx.refills > 11) {
    problems.push('At most 11 refills.');
  }
  return problems;
}

/** Clinical content that may not change once a prescription has been sent. */
function clinicalContent(mr: MedicationRequest): string {
  const pick = (url: string): unknown => mr.extension?.find((e) => e.url === url);
  return JSON.stringify([
    mr.subject?.reference, mr.requester?.reference, mr.intent, mr.medicationCodeableConcept, mr.medicationReference, mr.dosageInstruction, mr.dispenseRequest, mr.substitution,
    mr.note, mr.encounter, mr.basedOn, mr.authoredOn,
    pick(EXT.pharmacy), pick(EXT.patientLocationState), pick(EXT.controlledSchedule), pick(EXT.pdmpCheck),
  ]);
}

const TERMINAL: MedicationRequest['status'][] = ['cancelled', 'stopped', 'completed', 'entered-in-error'];

/**
 * Why an update to an existing prescription is not allowed, or undefined if it is. Drafts can be
 * edited freely; once sent, only the status may change (to stop or cancel it), never the drug,
 * dose, quantity or pharmacy. Changes require a new prescription.
 */
export function rxUpdateProblem(before: MedicationRequest | undefined, after: MedicationRequest): string | undefined {
  if ((!before || before.status === 'draft') && !['draft', 'active', 'entered-in-error'].includes(after.status)) return 'A new prescription must be a draft or queued for sending.';
  if (after.intent !== 'order') return 'Prescriptions must have order intent.';
  if (after.status === 'active' && !erxStatus(after)) return 'An active prescription must have a transmission status.';
  if (!before || before.status === 'draft') return undefined;
  if (after.status === 'draft') return 'A sent prescription cannot return to draft.';
  if (clinicalContent(before) !== clinicalContent(after)) return 'A sent prescription cannot be edited. Cancel it and send a new prescription.';
  if (TERMINAL.includes(before.status) && after.status !== before.status) return `This prescription is ${before.status} and cannot be reactivated.`;
  const from = erxStatus(before);
  const to = erxStatus(after);
  const transitions: Record<ErxStatus, ErxStatus[]> = {
    queued: ['queued', 'sending', 'cancel-requested'],
    sending: ['sending', 'sent', 'failed', 'cancel-requested'],
    sent: ['sent', 'cancel-requested'],
    failed: ['failed', 'queued', 'cancel-requested'],
    'cancel-requested': ['cancel-requested', 'cancelled'],
    cancelled: ['cancelled'],
  };
  if (!from || !to || !transitions[from]?.includes(to)) return 'Invalid prescription transmission status change.';
  if (after.status !== before.status && !['cancelled', 'stopped'].includes(after.status)) return 'Use cancellation to stop a prescription.';
  if (['cancelled', 'stopped'].includes(after.status) && !['cancel-requested', 'cancelled'].includes(to)) return 'Request cancellation through the prescribing service.';
  return undefined;
}

/** Adds business days (Mon–Fri) to a date. Holidays are not yet excluded. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export function isRenewalTask(t: Task): boolean {
  return !!t.code?.coding?.some((c) => c.system === CODE_SYSTEMS.taskCode && c.code === 'rx-renewal');
}

/** A pharmacy or patient renewal request (P26), answered or escalated within the SLA. */
export function buildRenewalTask(input: { patient: Reference<Patient>; prescriber: Reference<Practitioner>; prior?: Reference<MedicationRequest>; medication: string; from: string; note?: string; received?: Date }): Task {
  const received = input.received ?? new Date();
  return {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'rx-renewal' }], text: 'Renewal request' },
    description: `Renewal: ${input.medication}`,
    for: input.patient,
    owner: input.prescriber,
    focus: input.prior,
    requester: { display: input.from },
    authoredOn: received.toISOString(),
    restriction: { period: { end: addBusinessDays(received, RENEWAL_SLA_BUSINESS_DAYS).toISOString() } },
    input: [{ type: { text: 'medication' }, valueString: input.medication }],
    note: input.note?.trim() ? [{ text: input.note.trim() }] : undefined,
  };
}
