// Pre-commit Bot on Task create/update (P03, P25, P29). Medplum runs only the first matching
// pre-commit Bot per resource type, so every Task rule lives here.
//
// Every Task: closing it any way other than "completed" needs a reason, and a filed fax review
// cannot be reopened (taskCloseProblem in @teleemon/core).
//
// PDMP checks: the prescriber's attestation that they reviewed the state prescription-monitoring
// database, so it must be trustworthy:
//   - it names a state and a result, and is recorded as done now (not backdated or future-dated);
//   - it is recorded (and can only be changed) by the provider who owns it;
//   - once completed it cannot be changed (a mistaken entry is marked entered-in-error).
//
// Portal refill requests (X07): sent by the patient or proxy for that patient's own medication,
// one open request per medication; the server sets the time, SLA and priority.
// Portal invitations: a request names the Patient or RelatedPerson to invite; patients under 18
// are not invited to their own sign-in (a guardian is invited instead).
// Onboarding reviews: a new patient is marked verified only when nothing required is missing
// (onboardingProblems in @teleemon/core).

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { ClientApplication, MedicationRequest, Patient, RelatedPerson, Task } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, ONBOARDING_REVIEW, OPEN_TASK_STATUS_PARAM, PDMP_RESULTS, RENEWAL_SLA_BUSINESS_DAYS, addBusinessDays, isControlledStatement, isPdmpTask, isPortalAuthor,
  onboardingProblems, patientInviteProblem, pdmpCheckedAt, pdmpState, taskCloseProblem, taskCode, taskRecurrence,
} from '@teleemon/core';
import { previous } from './previous';

const MAX_AGE_MINUTES = 60;

export async function handler(medplum: MedplumClient, event: BotEvent<Task>): Promise<Task | boolean> {
  const task = event.input;
  const before = await previous(medplum, task);
  const isDeleted = Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource');
  const reservedCode = (value: Task | undefined) => value?.code?.coding?.find((coding) => coding.system === CODE_SYSTEMS.operations && ['compliance-checkpoint', 'integration-health'].includes(coding.code ?? ''))?.code;
  const priorReserved = reservedCode(before);
  const nextReserved = reservedCode(task);
  if (priorReserved && priorReserved !== nextReserved) reject('The type of a protected operations record cannot be changed.');
  if ((priorReserved || nextReserved) && isDeleted) reject('Protected operations records cannot be deleted.');
  if (priorReserved === 'compliance-checkpoint' || nextReserved === 'compliance-checkpoint') {
    if (before) reject('Compliance attestations are append-only. Record a new dated attestation instead.');
    requireAdminAttestationAuthor(task);
    return validateComplianceRecord(medplum, task);
  }
  if (priorReserved === 'integration-health' || nextReserved === 'integration-health') {
    await requireWorkerClient(medplum, task);
    validateIntegrationSignal(task);
    if (before) validateIntegrationUpdate(before, task);
    return true;
  }
  // Deletes are administrator-only (roles have no delete permission).
  if (isDeleted) return true;
  if (isPortalAuthor(task.meta?.author?.reference)) return portalRequest(medplum, task, before);
  if (taskCode(task) === 'portal-invite' && !before) {
    const focus = task.focus?.reference ?? '';
    if (!/^(Patient|RelatedPerson)\//.test(focus)) reject('A portal invitation names the patient or proxy to invite.');
    if (focus.startsWith('Patient/')) {
      const problem = patientInviteProblem(await medplum.readResource('Patient', focus.split('/')[1]) as Patient);
      if (problem) reject(problem);
    }
  }
  if (taskCode(before ?? task) === ONBOARDING_REVIEW && task.status === 'completed' && before?.status !== 'completed') await onboardingReady(medplum, task);
  const closing = taskCloseProblem(before, task);
  if (closing) reject(closing);
  if (task.extension?.some((e) => e.url === EXT.recurrence) && !taskRecurrence(task)) reject('Choose a supported task recurrence.');
  if (task.restriction?.period?.end && !Number.isFinite(Date.parse(task.restriction.period.end))) reject('Enter a valid task due date.');
  const kind = taskCode(before ?? task);
  if (before && ['fax-review', 'result-review', 'rx-renewal'].includes(kind ?? '') &&
      (taskCode(task) !== kind || task.focus?.reference !== before.focus?.reference || task.for?.reference !== before.for?.reference && kind !== 'fax-review')) reject('Generated work must keep its type, patient and source record.');
  if (task.status === 'completed' && before?.status !== 'completed' && ['fax-review', 'result-review'].includes(kind ?? '')) {
    const ref = task.focus?.reference;
    if (!ref?.startsWith('DocumentReference/')) reject('The source document is required to complete this task.');
    const doc = await medplum.readResource('DocumentReference', ref.split('/')[1]);
    if (kind === 'result-review' && !doc.extension?.some((e) => e.url === EXT.resultReview)) reject('Review the result in the patient chart before completing its task.');
    if (kind === 'fax-review' && (doc.status !== 'current' || !doc.subject?.reference)) reject('File the fax to a patient before completing its task.');
  }
  if (!isPdmpTask(task) && !(before && isPdmpTask(before))) return true;
  // Medplum stamps the signed-in user (or client) into meta.author before pre-commit Bots run.
  const author = task.meta?.author?.reference;
  const owner = (before ?? task).owner?.reference;

  if (author !== owner) reject('Record PDMP checks under your own name; only the reviewing provider can change one.');
  const strip = (t: Task): string => JSON.stringify({ ...t, status: undefined, meta: undefined, statusReason: undefined });
  if (before && before.status === 'completed') {
    if (task.status === 'entered-in-error' && strip(task) === strip(before)) return true;
    reject('A recorded PDMP check cannot be changed. Mark it entered in error and record a new check.');
  }
  if (before && before.status === 'entered-in-error') reject('This PDMP check was marked entered in error and cannot be changed.');

  if (!/^[A-Z]{2}$/.test(pdmpState(task) ?? '')) reject('A PDMP check must name the state database that was reviewed.');
  const result = task.extension?.find((e) => e.url === EXT.pdmpResult)?.valueCode;
  if (!PDMP_RESULTS.some((r) => r.value === result)) reject('Record the PDMP review result.');
  if (!task.owner?.reference?.startsWith('Practitioner/') || task.owner.reference !== owner) reject('A PDMP check must be owned by the reviewing provider.');
  if (task.status === 'completed') {
    const at = Date.parse(pdmpCheckedAt(task) ?? '');
    const now = Date.now();
    if (!Number.isFinite(at) || at > now + 5 * 60000 || at < now - MAX_AGE_MINUTES * 60000) {
      reject(`Record the PDMP check when you do it; the check time must be within the last ${MAX_AGE_MINUTES} minutes.`);
    }
  }
  return true;
}

/**
 * Compliance attestations are limited to administrators by the server AccessPolicy criteria in
 * scripts/config/platform.ts. This pre-commit Bot cannot read a trustworthy membership claim from
 * BotEvent, so it validates only the human Practitioner author. Portal users are separately
 * restricted by their Task policy, and the worker client is rejected here.
 */
function requireAdminAttestationAuthor(task: Task): void {
  const author = task.meta?.author?.reference;
  if (!author?.startsWith('Practitioner/')) reject('Only an administrator can attest to a compliance checkpoint.');
}

async function requireWorkerClient(medplum: MedplumClient, task: Task): Promise<void> {
  const author = task.meta?.author?.reference;
  if (!author?.startsWith('ClientApplication/')) reject('Only the Teleemon worker can record integration health.');
  let client: ClientApplication;
  try {
    client = await medplum.readResource('ClientApplication', author.split('/')[1]);
  } catch {
    reject('The worker identity could not be verified.');
  }
  if (client!.name !== 'Teleemon worker') reject('Only the Teleemon worker can record integration health.');
}

async function validateComplianceRecord(medplum: MedplumClient, task: Task): Promise<Task> {
  const input = task.input ?? [];
  const value = (code: string) => input.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));
  const checkpoint = value('compliance-checkpoint')?.valueCode;
  const evidenceKind = value('evidence-kind')?.valueCode;
  const evidence = value('evidence-reference')?.valueReference?.reference;
  const author = task.meta?.author?.reference;
  if (task.status !== 'completed' || task.code?.coding?.filter((coding) => coding.system === CODE_SYSTEMS.operations).length !== 1 || !checkpoint || evidenceKind !== 'attestation' || !evidence) {
    reject('A compliance attestation must name its checkpoint and evidence.');
  }
  if (!author?.startsWith('Practitioner/')) reject('A compliance attestation must name the administrator who submitted it.');
  if (!evidence!.startsWith('DocumentReference/')) reject('Compliance evidence must be an existing document record.');
  const evidenceDocument = await medplum.readResource('DocumentReference', evidence!.split('/')[1]);
  if (evidenceDocument.status !== 'current') reject('The compliance evidence document must be current.');
  if (checkpoint === 'baa-agreement') {
    const vendor = value('vendor')?.valueString?.trim();
    const executedOn = value('executed-on')?.valueDate;
    const expiresOn = value('expires-on')?.valueDate;
    if (!vendor || !validDateOnly(executedOn) || expiresOn && (!validDateOnly(expiresOn) || expiresOn < executedOn!)) reject('A BAA attestation needs a vendor and valid execution and expiry dates.');
  }
  const now = new Date().toISOString();
  const recordedByInput = { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'attested-by' }] }, valueReference: { reference: author } };
  const recordedAtInput = { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'attested-at' }] }, valueDateTime: now };
  const nextInput = (task.input ?? []).filter((item) => !item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && ['attested-by', 'attested-at'].includes(coding.code ?? '')));
  return { ...task, requester: { reference: author }, authoredOn: now, input: [...nextInput, recordedByInput, recordedAtInput] };
}

function validDateOnly(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateIntegrationSignal(task: Task): void {
  const input = task.input ?? [];
  const value = (code: string) => input.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));
  const key = value('signal-key')?.valueCode;
  const label = value('signal-label')?.valueString;
  const outcome = value('signal-outcome')?.valueCode;
  const observedAt = value('observed-at')?.valueDateTime;
  const expected = new Map([
    ['worker', 'Background worker'], ['sms', 'SMS delivery'], ['email', 'Email delivery'], ['erx', 'E-prescribing'],
    ['fax', 'Fax delivery'], ['billing', 'Billing workflow'], ['clearinghouse', 'Claims clearinghouse'], ['lab-interface', 'Lab interface'],
    ['google-meet', 'Google Meet'], ['openai-scribe', 'OpenAI scribe'],
  ]);
  const inputCodes = input.flatMap((item) => item.type.coding?.filter((coding) => coding.system === CODE_SYSTEMS.operations).map((coding) => coding.code) ?? []);
  const allowedCodes = new Set(['signal-key', 'signal-label', 'signal-outcome', 'observed-at', 'configured', 'mode', 'failure-class']);
  const hasOutcome = outcome === 'success' || outcome === 'failure';
  const configured = value('configured')?.valueBoolean;
  const identifier = task.identifier?.filter((item) => item.system === DERIVED_IDENTIFIER_SYSTEM && item.value === `integration-health:${key}`).length === 1;
  const seenCodes = inputCodes.filter((code): code is string => !!code);
  const observationValid = hasOutcome
    ? !!observedAt && Number.isFinite(Date.parse(observedAt)) && task.status === (outcome === 'success' ? 'completed' : 'failed')
    : outcome === undefined && observedAt === undefined && task.status === 'ready';
  if (!key || expected.get(key) !== label || configured === undefined || !observationValid || !identifier || inputCodes.some((code) => !allowedCodes.has(code ?? '')) || new Set(seenCodes).size !== seenCodes.length || task.code?.coding?.filter((coding) => coding.system === CODE_SYSTEMS.operations).length !== 1 || task.for || task.focus || task.owner || task.requester || task.description !== 'Worker operational signal. Contains no patient data.') {
    reject('The integration health record is incomplete or contains unsupported data.');
  }
  const mode = value('mode')?.valueCode;
  if (mode && !/^[a-z0-9-]{1,40}$/.test(mode)) reject('Integration mode must be a safe identifier.');
  const failureClass = value('failure-class')?.valueCode;
  if (failureClass && (!hasOutcome || outcome !== 'failure' || !/^[A-Za-z0-9_-]{1,40}$/.test(failureClass))) reject('Failure class must be a safe identifier attached to a failed attempt.');
}

function validateIntegrationUpdate(before: Task, next: Task): void {
  const value = (task: Task, code: string) => task.input?.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));
  const oldKey = value(before, 'signal-key')?.valueCode;
  const nextKey = value(next, 'signal-key')?.valueCode;
  if (oldKey !== nextKey) reject('An integration health record cannot be reassigned to a different component.');
  const oldOutcome = value(before, 'signal-outcome')?.valueCode;
  const oldAt = value(before, 'observed-at')?.valueDateTime;
  if (oldOutcome) {
    const nextOutcome = value(next, 'signal-outcome')?.valueCode;
    const nextAt = value(next, 'observed-at')?.valueDateTime;
    if (!nextOutcome || !nextAt || !oldAt || Date.parse(nextAt) < Date.parse(oldAt)) {
      reject('Integration health updates must preserve the latest observed attempt.');
    }
  }
}

/** Marking a new patient verified needs a complete record: registration details, insurance, card and consents. */
async function onboardingReady(medplum: MedplumClient, task: Task): Promise<void> {
  const ref = task.for?.reference;
  if (!ref?.startsWith('Patient/')) reject('An onboarding review names its patient.');
  const [patient, coverages, consents, meds] = await Promise.all([
    medplum.readResource('Patient', ref.split('/')[1]) as Promise<Patient>,
    medplum.searchResources('Coverage', { beneficiary: ref, _count: '50' }),
    medplum.searchResources('Consent', { patient: ref, _count: '200' }),
    medplum.searchResources('MedicationStatement', { subject: ref, status: 'active', _count: '100' }),
  ]);
  const missing = onboardingProblems({ patient, coverages, consents, onControlled: meds.some(isControlledStatement) });
  if (missing.length) reject(`Not ready to verify. Still missing: ${missing.map((m) => m.label).join('; ')}.`);
}

/** A refill request from the portal. Patients cannot edit or close Tasks: their policy is create-only. */
async function portalRequest(medplum: MedplumClient, task: Task, before: Task | undefined): Promise<Task> {
  const author = task.meta?.author?.reference as string;
  if (before) reject('A sent request cannot be changed. Send us a message instead.');
  if (taskCode(task) !== 'rx-renewal') reject('Only refill requests can be sent from the portal.');
  if (task.status !== 'requested') reject('A refill request is sent to the care team for review.');
  const patientRef = author.startsWith('RelatedPerson/') ? (await medplum.readResource('RelatedPerson', author.split('/')[1]) as RelatedPerson).patient?.reference : author;
  if (!patientRef || task.for?.reference !== patientRef) reject('A refill request must be for your own medication.');
  if (task.requester?.reference !== author) reject('Send the request under your own name.');
  if (!task.owner?.reference?.startsWith('Practitioner/')) reject('A refill request goes to a prescriber.');
  const medication = task.input?.find((i) => i.type.text === 'medication')?.valueString?.trim() ?? '';
  if (!medication || medication.length > 200) reject('Name the medication to refill.');
  if (task.focus) {
    if (!task.focus.reference?.startsWith('MedicationRequest/')) reject('A refill request refers to a prescription.');
    const prior = await medplum.readResource('MedicationRequest', task.focus.reference.split('/')[1]) as MedicationRequest;
    if (prior.subject?.reference !== patientRef) reject('A refill request must be for your own medication.');
  }
  const open = await medplum.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|rx-renewal`, patient: patientRef, status: OPEN_TASK_STATUS_PARAM, _count: '50' });
  if (open.some((t) => t.input?.find((i) => i.type.text === 'medication')?.valueString?.trim().toLowerCase() === medication.toLowerCase())) {
    reject(`A refill request for ${medication} is already with the care team.`);
  }
  const now = new Date();
  return {
    ...task,
    intent: 'order',
    priority: 'routine',
    authoredOn: now.toISOString(),
    description: `Renewal: ${medication}`,
    restriction: { period: { end: addBusinessDays(now, RENEWAL_SLA_BUSINESS_DAYS).toISOString() } },
    performerType: undefined,
    businessStatus: undefined,
  };
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
