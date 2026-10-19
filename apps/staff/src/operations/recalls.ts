import type { MedplumClient } from '@medplum/core';
import type { Appointment, Consent, Patient, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, buildRecallTask, hasFutureBookedVisit, recallConsentState, recallContactability, recallTaskPatientRef } from '@teleemon/core';
import type { RecallChannel, RecallConsentState, RecallContactability } from '@teleemon/core';
import { collectResources, patientsByRef } from './shared';

export interface RecallRow {
  readonly task: Task;
  readonly patient?: Patient;
  readonly channel: RecallChannel;
  readonly consent: RecallConsentState;
  readonly reasonCode?: string;
  readonly futureVisitBooked: boolean;
  readonly contactability: RecallContactability;
}

export interface RecallSaveDraft {
  readonly patient: Reference<Patient>;
  readonly dueDate: string;
  readonly reasonCode: string;
  readonly reasonLabel: string;
  readonly channel: RecallChannel;
  readonly requester?: Reference<Practitioner>;
}

const taskInput = (task: Task, code: string) => task.input?.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));
const taskChannel = (task: Task): RecallChannel => (taskInput(task, 'recall-channel')?.valueCode as RecallChannel | undefined) ?? 'consent-review';

export async function loadRecalls(medplum: MedplumClient, includeClosed = false): Promise<RecallRow[]> {
  const params = new URLSearchParams([['code', `${CODE_SYSTEMS.operations}|recall`], ['_sort', '-authored-on']]);
  if (!includeClosed) params.set('status', 'requested,ready,in-progress');
  const tasks = await collectResources<Task>(medplum, 'Task', params);
  const booked = await bookedVisitsForRefs(medplum, tasks.map(recallTaskPatientRef));
  const patientRefs = tasks.map(recallTaskPatientRef);
  const [patients, consentsByPatient] = await Promise.all([
    patientsByRef(medplum, patientRefs),
    loadRecallConsents(medplum, patientRefs),
  ]);
  return tasks.map((task) => {
    const patientRef = recallTaskPatientRef(task);
    const patient = patientRef ? patients.get(patientRef) : undefined;
    const channel = taskChannel(task);
    const consent = channel === 'consent-review' ? 'unknown' : recallConsentState(consentsByPatient.get(patientRef ?? '') ?? [], channel);
    const futureVisitBooked = patientRef ? hasFutureBookedVisit(patientRef, booked) : false;
    const contactability = patient && channel !== 'consent-review' ? recallContactability(patient, channel, consent) : { allowed: false, reason: 'Consent review is required before any outreach.', consentReviewRequired: true };
    return { task, patient, channel, consent, reasonCode: taskInput(task, 'recall-reason')?.valueCode, futureVisitBooked, contactability };
  }).filter((row) => includeClosed || !row.futureVisitBooked);
}

async function loadRecallConsents(medplum: MedplumClient, patientRefs: readonly (string | undefined)[]): Promise<Map<string, Consent[]>> {
  const refs = [...new Set(patientRefs.filter((ref): ref is string => !!ref))];
  const out = new Map<string, Consent[]>();
  for (let i = 0; i < refs.length; i += 40) {
    const batch = refs.slice(i, i + 40);
    const consents = await collectResources<Consent>(medplum, 'Consent', new URLSearchParams([['patient', batch.join(',')], ['category', `${CODE_SYSTEMS.operations}|recall-contact`]]), 5000);
    for (const consent of consents) {
      const ref = consent.patient?.reference;
      if (ref) out.set(ref, [...(out.get(ref) ?? []), consent]);
    }
  }
  return out;
}

async function bookedVisitsForRefs(medplum: MedplumClient, refs: readonly (string | undefined)[]): Promise<Appointment[]> {
  const unique = [...new Set(refs.filter((ref): ref is string => !!ref))];
  const out: Appointment[] = [];
  for (let i = 0; i < unique.length; i += 40) {
    out.push(...await collectResources<Appointment>(medplum, 'Appointment', new URLSearchParams([
      ['patient', unique.slice(i, i + 40).join(',')], ['status', 'booked,arrived,checked-in'], ['date', `ge${new Date().toISOString()}`],
    ]), 5000));
  }
  return out;
}

export async function saveRecallTask(medplum: MedplumClient, draft: RecallSaveDraft, now = new Date()): Promise<Task> {
  if (!draft.patient.reference?.startsWith('Patient/')) throw new Error('Choose a patient for the recall.');
  const patient = await medplum.readReference(draft.patient);
  const future = await collectResources<Appointment>(medplum, 'Appointment', new URLSearchParams([
    ['patient', draft.patient.reference], ['status', 'booked,arrived,checked-in'], ['date', `ge${now.toISOString()}`],
  ]), 1000);
  if (hasFutureBookedVisit(draft.patient.reference, future, now)) throw new Error('This patient already has a future booked visit; a new recall is not needed.');
  let consent: RecallConsentState = 'unknown';
  if (draft.channel !== 'consent-review') {
    const consents = await collectResources<Consent>(medplum, 'Consent', new URLSearchParams([['patient', draft.patient.reference], ['category', `${CODE_SYSTEMS.operations}|recall-contact`]]), 1000);
    consent = recallConsentState(consents, draft.channel, now);
    const contactability = recallContactability(patient, draft.channel, consent);
    if (!contactability.allowed) throw new Error(contactability.reason ?? 'Current consent for this contact channel is required.');
  }
  const task = buildRecallTask({ ...draft, consent, requester: draft.requester }, now);
  const identifier = task.identifier?.find((item) => item.system)?.value;
  if (!identifier) throw new Error('Unable to generate a stable recall task identifier.');
  return medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier: `https://fhir.teleemon.com/identifier/derived|${identifier}` }).toString());
}

export async function completeRecallTask(medplum: MedplumClient, taskId: string, note?: string, now = new Date()): Promise<Task> {
  const current = await medplum.readResource('Task', taskId, { cache: 'no-cache' });
  if (!current.code?.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === 'recall')) throw new Error('This is not a recall task.');
  if (['completed', 'cancelled', 'entered-in-error'].includes(current.status)) return current;
  return medplum.updateResource({ ...current, status: 'completed', lastModified: now.toISOString(), ...(note?.trim() ? { note: [...(current.note ?? []), { text: note.trim().slice(0, 500), time: now.toISOString() }] } : {}) }, { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } });
}

export function recallConsentOf(consents: Consent[], channel: Exclude<RecallChannel, 'consent-review'>, now = new Date()): RecallConsentState {
  return recallConsentState(consents, channel, now);
}
