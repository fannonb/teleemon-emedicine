import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication, DocumentReference, Patient, Task } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, DOCUMENT_TYPE_SYSTEM, EXT, confirmMatchExtension, inboxKind, isOverdue, matchProblem, nextOccurrence, nextDue, parseDates, parseNames, suggestFax, taskCloseProblem, taskTeam, searchAll,
} from '@teleemon/core';
import { handler as taskRules } from '../bots/src/task-rules';
import { handler as documentRules } from '../bots/src/document-rules';
import { handler as messageRules } from '../bots/src/communication-rules';
import { handler as resultReview } from '../bots/src/result-review';
import { handler as recurring } from '../bots/src/recurring-tasks';
import { textPdf, receiveFax } from '../services/worker/src/fax';
import { previous } from '../bots/src/previous';

test('locked record guards fail closed when reading prior state fails', async () => {
  const m = client({ readResource: async () => { throw new Error('backend unavailable'); } });
  await assert.rejects(previous(m, { resourceType: 'Task', id: 'locked', status: 'completed', intent: 'order' }), /backend unavailable/);
  assert.equal(await previous(m, { resourceType: 'Task', status: 'requested', intent: 'order' }), undefined);
});

const event = <T extends { meta?: object }>(input: T, author = 'Practitioner/staff'): BotEvent<T> => ({
  input: { ...input, meta: { ...(input.meta ?? {}), author: { reference: author } } }, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {},
});
const client = (methods: object): MedplumClient => methods as MedplumClient;
const task = (code: string, over: Partial<Task> = {}): Task => ({ resourceType: 'Task', id: 't', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code }] }, ...over });
const fax = (over: Partial<DocumentReference> = {}): DocumentReference => ({
  resourceType: 'DocumentReference', id: 'fax', status: 'current', type: { coding: [{ system: DOCUMENT_TYPE_SYSTEM, code: 'inbound-fax' }] }, content: [{ attachment: { url: 'Binary/x' } }], ...over,
});
const patients: Patient[] = [
  { resourceType: 'Patient', id: 'maya', birthDate: '1991-04-12', name: [{ given: ['Maya'], family: 'Thornton' }] },
  { resourceType: 'Patient', id: 'mark', birthDate: '1991-04-12', name: [{ given: ['Mark'], family: 'Ellison' }] },
];

test('inbox kinds and teams default sensibly so nothing is unowned', () => {
  assert.equal(inboxKind(task('fax-review')), 'fax');
  assert.equal(inboxKind(task('result-review')), 'result');
  assert.equal(inboxKind(task('general')), 'task');
  assert.equal(taskTeam(task('fax-review')), 'frontdesk');
  assert.equal(taskTeam(task('lab-monitoring', { owner: { reference: 'Practitioner/p' } })), 'provider');
  assert.equal(isOverdue(task('general', { restriction: { period: { end: '2020-01-01T00:00:00Z' } } })), true);
  assert.equal(isOverdue(task('general', { status: 'completed', restriction: { period: { end: '2020-01-01T00:00:00Z' } } })), false);
});

test('closing a task without completing it needs a reason; filed fax reviews stay closed', () => {
  assert.match(taskCloseProblem(task('general'), task('general', { status: 'cancelled' })) ?? '', /reason/);
  assert.equal(taskCloseProblem(task('general'), task('general', { status: 'cancelled', statusReason: { text: 'Duplicate of another task' } })), undefined);
  assert.equal(taskCloseProblem(task('general'), task('general', { status: 'completed' })), undefined);
  assert.match(taskCloseProblem(task('fax-review', { status: 'completed' }), task('fax-review', { status: 'requested' })) ?? '', /cannot be reopened/);
});

test('fax text parsing finds names and birth dates in common formats', () => {
  assert.deepEqual(parseDates('DOB: 04/12/1991 collected 2026-10-15'), ['1991-04-12', '2026-10-15']);
  assert.deepEqual(parseNames('Patient: Thornton, Maya\nRE: Priya Raman  DOB 01/22/1998'), ['Maya Thornton', 'Priya Raman']);
});

test('fax suggestions: confident only when DOB and name agree; ties and misses are never guessed', () => {
  const lab = suggestFax('LABORATORY REPORT\nPatient: Thornton, Maya\nDOB: 04/12/1991\nLithium level', patients);
  assert.equal(lab.patientId, 'maya');
  assert.equal(lab.confidence, 'high');
  assert.equal(lab.category, 'lab-report');
  const tie = suggestFax('Referral\nDOB: 04/12/1991', patients);
  assert.equal(tie.patientId, undefined);
  assert.equal(tie.confidence, 'low');
  const none = suggestFax('Patient: Thornton, Maya\nDOB: 05/05/1990', patients);
  assert.equal(none.patientId, undefined);
  assert.equal(none.confidence, 'none');
  assert.equal(suggestFax('Explanation of benefits enclosed', []).category, 'billing');
});

test('filing to a patient needs a fresh confirmation by the person filing; removal needs a reason', () => {
  const now = new Date();
  const filed = fax({ subject: { reference: 'Patient/maya' } });
  assert.match(matchProblem(fax(), filed, 'Practitioner/staff', now) ?? '', /Confirm the patient/);
  assert.match(matchProblem(fax(), { ...filed, extension: [confirmMatchExtension('Practitioner/other', now)] }, 'Practitioner/staff', now) ?? '', /Confirm the patient/);
  const stale = new Date(now.getTime() - 3600000);
  assert.match(matchProblem(fax(), { ...filed, extension: [confirmMatchExtension('Practitioner/staff', stale)] }, 'Practitioner/staff', now) ?? '', /Confirm the patient/);
  assert.equal(matchProblem(fax(), { ...filed, extension: [confirmMatchExtension('Practitioner/staff', now)] }, 'Practitioner/staff', now), undefined);
  assert.match(matchProblem(fax(), fax({ status: 'entered-in-error' }), 'Practitioner/staff', now) ?? '', /reason/);
  assert.equal(matchProblem(fax(), fax({ status: 'entered-in-error', extension: [{ url: EXT.removalReason, valueString: 'Wrong number, not our patient' }] }), 'Practitioner/staff', now), undefined);
});

test('task-rules Bot enforces close reasons on every task and still guards PDMP checks', async () => {
  const before = task('general');
  const m = client({ readResource: async () => before });
  await assert.rejects(taskRules(m, event(task('general', { status: 'cancelled' }))), /reason/);
  await assert.doesNotReject(taskRules(m, event(task('general', { status: 'cancelled', statusReason: { text: 'No longer needed' } }))));
  await assert.doesNotReject(taskRules(m, event(task('general', { status: 'completed' }))));
});

test('document-rules Bot: confirmed filing only, no silent re-type, final result reviews', async () => {
  const stored = fax();
  const m = client({ readResource: async () => stored });
  await assert.rejects(documentRules(m, event(fax({ subject: { reference: 'Patient/maya' } }))), /Confirm the patient/);
  await assert.doesNotReject(documentRules(m, event(fax({ subject: { reference: 'Patient/maya' }, extension: [confirmMatchExtension('Practitioner/staff')] }))));
  await assert.rejects(documentRules(m, event({ ...stored, type: undefined, subject: { reference: 'Patient/maya' } })), /fax identity/);

  const lab: DocumentReference = { resourceType: 'DocumentReference', id: 'lab', status: 'current', subject: { reference: 'Patient/maya' }, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'lab-report' }] }], content: [{ attachment: { url: 'Binary/result' } }] };
  const review = (by: string): DocumentReference['extension'] => [{ url: EXT.resultReview, extension: [{ url: 'by', valueReference: { reference: by } }, { url: 'at', valueDateTime: new Date().toISOString() }] }];
  const labClient = client({ readResource: async () => lab });
  await assert.rejects(documentRules(labClient, event({ ...lab, extension: review('Practitioner/other') }, 'Practitioner/prov')), /own name/);
  await assert.doesNotReject(documentRules(labClient, event({ ...lab, extension: review('Practitioner/prov') }, 'Practitioner/prov')));
  const reviewed = { ...lab, extension: review('Practitioner/prov') };
  await assert.rejects(documentRules(client({ readResource: async () => reviewed }), event({ ...lab, extension: review('Practitioner/prov2') }, 'Practitioner/prov2')), /cannot be changed/);
  // Ordinary uploads are not slowed or blocked.
  await assert.doesNotReject(documentRules(client({}), event<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', content: [{ attachment: {} }] })));
});

test('message-rules Bot: unmatched texts need a confirmed match, and closing records how it was handled', async () => {
  const msg: Communication = { resourceType: 'Communication', id: 'm', status: 'in-progress', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'sms-reply' }] }], payload: [{ contentString: 'Can I move my visit?' }] };
  const m = client({ readResource: async () => msg });
  await assert.rejects(messageRules(m, event({ ...msg, subject: { reference: 'Patient/maya' } })), /Confirm the patient/);
  await assert.doesNotReject(messageRules(m, event({ ...msg, subject: { reference: 'Patient/maya' }, extension: [confirmMatchExtension('Practitioner/staff')] })));
  await assert.rejects(messageRules(m, event({ ...msg, status: 'completed' })), /how the message was handled/);
  await assert.doesNotReject(messageRules(m, event({ ...msg, status: 'completed', note: [{ text: 'Called back and rescheduled' }] })));
});

test('result-review Bot creates one review task for the ordering provider, then closes it with the order', async () => {
  const created: Task[] = [];
  const updated: unknown[] = [];
  let lab: DocumentReference = { resourceType: 'DocumentReference', id: 'lab', status: 'current', subject: { reference: 'Patient/maya' }, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'lab-report' }] }], context: { related: [{ reference: 'ServiceRequest/o' }] }, content: [{ attachment: { url: 'Binary/result' } }] };
  let existing: Task | undefined;
  const m = client({
    searchOne: async () => existing,
    readResource: async () => lab,
    readReference: async (r: { reference: string }) => (r.reference.startsWith('Patient') ? { resourceType: 'Patient', id: 'maya', generalPractitioner: [{ reference: 'Practitioner/pcp' }] } : { resourceType: 'ServiceRequest', id: 'o', status: 'active', subject: { reference: 'Patient/maya' }, requester: { reference: 'Practitioner/orderer' } }),
    createResourceIfNoneExist: async (t: Task) => { created.push(t); return t; },
    updateResource: async (r: unknown) => { updated.push(r); return r; },
  });
  assert.equal(await resultReview(m, event(lab)), 'review task created');
  assert.equal(created[0].owner?.reference, 'Practitioner/orderer');
  assert.ok(created[0].restriction?.period?.end);
  existing = { ...created[0], id: 'rt' };
  lab = { ...lab, extension: [{ url: EXT.resultReview, extension: [] }] };
  assert.equal(await resultReview(m, event(lab)), 'review recorded');
  assert.deepEqual(updated.map((u) => (u as { resourceType: string; status: string }).status), ['completed', 'completed']);
});

test('recurring tasks: completing one schedules the next occurrence, never in the past', async () => {
  const done = task('general', { id: 'r1', status: 'completed', description: 'Check fax machine paper', extension: [{ url: EXT.recurrence, valueCode: 'weekly' }], restriction: { period: { end: '2026-01-05T23:59:00Z' } } });
  const next = nextOccurrence(done, new Date('2026-10-16T12:00:00Z'));
  assert.equal(next?.status, 'requested');
  assert.ok(Date.parse(next?.restriction?.period?.end ?? '') > Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(next?.partOf?.[0].reference, 'Task/r1');
  let made: Task | undefined;
  await recurring(client({ createResourceIfNoneExist: async (t: Task) => { made = t; return t; } }), event(done));
  assert.equal(made?.identifier?.[0].value, 'recur-r1');
  assert.equal(nextOccurrence(task('general', { status: 'completed' })), undefined);
});

test('synthetic fax PDFs are well-formed', () => {
  const pdf = new TextDecoder().decode(textPdf(['Hello (world)']));
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  assert.ok(pdf.includes('\\(world\\)'));
});

test('unsupported recurrence and invalid due dates cannot hang scheduling; months clamp to their last day', async () => {
  const done = task('general', { status: 'completed', extension: [{ url: EXT.recurrence, valueCode: 'bad-rule' }], restriction: { period: { end: '2020-01-01T00:00:00Z' } } });
  assert.equal(nextOccurrence(done), undefined);
  await assert.rejects(taskRules(client({ readResource: async () => undefined }), event(done)), /supported.*recurrence/);
  assert.equal(nextDue(new Date('2026-01-31T12:00:00Z'), 'monthly').toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(nextOccurrence({ ...done, extension: [{ url: EXT.recurrence, valueCode: 'weekly' }], restriction: { period: { end: 'bad-date' } } }), undefined);
});

test('lab links cannot cross patient charts and reviewed result bytes cannot be replaced', async () => {
  const lab: DocumentReference = { ...fax(), type: undefined, subject: { reference: 'Patient/maya' }, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'lab-report' }] }], context: { related: [{ reference: 'ServiceRequest/order' }] } };
  const m = client({ readResource: async (type: string) => type === 'ServiceRequest' ? { resourceType: 'ServiceRequest', subject: { reference: 'Patient/other' } } : lab });
  await assert.rejects(documentRules(m, event(lab)), /same patient/);
  const reviewed = { ...lab, context: undefined, extension: [{ url: EXT.resultReview, extension: [{ url: 'by', valueReference: { reference: 'Practitioner/staff' } }] }] };
  await assert.rejects(documentRules(client({ readResource: async () => reviewed }), event({ ...reviewed, content: [{ attachment: { url: 'Binary/replacement' } }] })), /cannot be changed/);
  await assert.rejects(documentRules(client({ readResource: async () => reviewed }), event({ ...reviewed, category: [] })), /keeps its category/);
});

test('clinical review tasks cannot be completed to bypass reviewing their source result', async () => {
  const t = task('result-review', { focus: { reference: 'DocumentReference/lab' } });
  const m = client({ readResource: async (type: string) => type === 'Task' ? t : fax() });
  await assert.rejects(taskRules(m, event({ ...t, status: 'completed' })), /Review the result/);
});

test('message category changes cannot evade matching and closure rules', async () => {
  const m: Communication = { resourceType: 'Communication', id: 'message', status: 'in-progress', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'sms-reply' }] }] };
  await assert.rejects(messageRules(client({ readResource: async () => m }), event({ ...m, status: 'completed', category: [] })), /keeps its message category/);
  assert.match(matchProblem({ ...m, subject: { reference: 'Patient/maya' } }, m, 'Practitioner/staff') ?? '', /cannot be unlinked/);
});

test('fax redelivery repairs an interrupted attachment upload and ensures the review task', async () => {
  let saved: DocumentReference | undefined;
  let uploads = 0;
  let documents = 0;
  let tasks = 0;
  const m = client({
    searchOne: async () => saved,
    searchResources: async () => [],
    createResourceIfNoneExist: async (r: DocumentReference | Task) => {
      if (r.resourceType === 'DocumentReference') { documents++; saved = { ...r, id: 'recover', meta: { versionId: '1' } }; return saved; }
      tasks++; return r;
    },
    createAttachment: async () => { if (++uploads === 1) throw new Error('interrupted upload'); return { url: 'Binary/pdf', contentType: 'application/pdf' }; },
    updateResource: async (r: DocumentReference) => { saved = r; return r; },
  });
  const input = { id: 'vendor-fax', from: '5550100', pages: 1, pdf: textPdf(['Synthetic report']) };
  await assert.rejects(receiveFax(m, input), /interrupted/);
  const result = await receiveFax(m, input);
  assert.equal(documents, 1);
  assert.equal(result.content[0].attachment.url, 'Binary/pdf');
  assert.equal(tasks, 1);
});

test('fax intake refuses non-PDF input before creating any resource', async () => {
  await assert.rejects(receiveFax(client({}), { id: 'bad', from: '555', pages: 1, pdf: new Uint8Array([1, 2, 3]) }), /requires.*PDF/);
});

test('work queue pagination includes later pages', async () => {
  const m = client({ searchResourcePages: async function* () { yield [task('general', { id: 'first' })]; yield [task('general', { id: 'later' })]; } });
  assert.deepEqual((await searchAll(m, 'Task', {})).map((t) => t.id), ['first', 'later']);
});
