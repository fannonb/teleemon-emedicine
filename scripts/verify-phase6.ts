// Phase 6 gate: inbox, tasks, documents, fax and manual labs, proven against the local Medplum
// server with real role logins, the deployed Bots and the worker code paths (log fax adapter, no
// vendor). One synthetic patient is created here; everything created is removed afterwards.

import type { MedplumClient } from '@medplum/core';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Communication, DocumentReference, Patient, Practitioner, Resource, ResourceType, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, GENERATED_IDENTIFIER_SYSTEM, LAB_TESTS, SEED_IDENTIFIER_SYSTEM, buildLabOrder, confirmMatchExtension, teamCoding } from '@teleemon/core';
import { QUEUES } from '../apps/staff/src/inbox/inbox';
import { LogFaxAdapter, receiveFax, sendQueuedFaxes, textPdf } from '../services/worker/src/fax';
import { handleInbound } from '../services/worker/src/inbound';
import { connectWorker } from '../services/worker/src/index';
import { sendDailySummaries } from '../services/worker/src/summary';
import { LogTransport } from '../services/worker/src/transport';
import { connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
const MARK = `verify-phase6-${Date.now()}`;
const created: Resource[] = [];
let failures = 0;
let passes = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.slice(0, 140)})` : ''}`);
}
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}
/** Subscription Bots run asynchronously; wait briefly for their effect. */
async function eventually<T>(fn: () => Promise<T | undefined>, tries = 20): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}
const track = <T extends Resource>(r: T | undefined): T | undefined => { if (r) created.push(r); return r; };

async function main(): Promise<void> {
  const admin = await connect();
  const prac = (await admin.searchOne('Practitioner', { identifier: `${SEED_IDENTIFIER_SYSTEM}|prac-provider` })) as Practitioner;
  const patient = track(await admin.createResource<Patient>({
    resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: MARK }], name: [{ family: 'Inboxtest', given: ['Synthetic'] }], birthDate: '1979-03-14',
    telecom: [{ system: 'phone', value: '(206) 555-0177' }], generalPractitioner: [createReference(prac)],
  })) as Patient;
  try {
    await checks(admin, patient, prac);
  } finally {
    console.log(`\n(cleaned up ${await cleanup(admin, patient)} test resources)`);
  }
  console.log(`\n${passes} PASS, ${failures} FAIL (${passes + failures} checks)`);
  console.log(failures === 0 ? '✓ Phase 6 server-side checks passed' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function checks(admin: MedplumClient, patient: Patient, prac: Practitioner): Promise<void> {
  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const practiceAdmin = await connectAsPassword('admin@teleemon.test', PASSWORD);
  const worker = await connectWorker();
  const fdRef = getReferenceString(frontdesk.getProfile()!) as string;
  const provRef = `Practitioner/${prac.id}`;
  const p = createReference(patient);

  console.log('Inbound fax and patient suggestion');
  const text = `QUEST DIAGNOSTICS LABORATORY REPORT\nPatient: Inboxtest, Synthetic\nDOB: 03/14/1979\nLithium level 0.8 mmol/L`;
  const fax = track(await receiveFax(worker, { id: `${MARK}-1`, from: '(800) 555-0142', pages: 1, pdf: textPdf(text.split('\n')), text })) as DocumentReference;
  const suggestion = JSON.parse(fax.extension?.find((e) => e.url === EXT.faxSuggestion)?.valueString ?? '{}');
  report(!fax.subject && fax.status === 'current', 'Received fax is stored unfiled (no patient yet)');
  report(suggestion.patientId === patient.id && suggestion.confidence === 'high' && suggestion.category === 'lab-report', 'Suggestion: matching patient (high confidence) and lab-report category', JSON.stringify({ c: suggestion.confidence, cat: suggestion.category }));
  const review = await admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|fax-review-${fax.id}` }, { cache: 'no-cache' });
  track(review);
  report(!!review && review.performerType?.[0]?.coding?.[0]?.code === 'frontdesk' && !!review.restriction?.period?.end, 'A front-desk review task with a due date is created');
  const again = await receiveFax(worker, { id: `${MARK}-1`, from: '(800) 555-0142', pages: 1, pdf: textPdf(['x']), text });
  report(again.id === fax.id, 'Re-delivery of the same fax does not create a duplicate');

  console.log('Filing needs a confirmed match');
  const doc = await frontdesk.readResource('DocumentReference', fax.id as string);
  const lab = { ...doc, subject: p, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'lab-report' }] }] };
  const noConfirm = await attempt(() => frontdesk.updateResource(lab));
  report(!noConfirm.ok && /Confirm the patient/.test(noConfirm.error ?? ''), 'Filing without confirming the patient is refused', noConfirm.error);
  const forged = await attempt(() => frontdesk.updateResource({ ...lab, extension: [...(lab.extension ?? []), confirmMatchExtension(provRef)] }));
  report(!forged.ok, 'Filing with someone else’s confirmation is refused', forged.error);
  const order = track(await provider.createResource(buildLabOrder({ patient: p, requester: createReference(prac), test: LAB_TESTS[0], lab: 'Quest Diagnostics' })));
  const batchOrders = LAB_TESTS.slice(0, 2).map((test) => ({ ...buildLabOrder({ patient: p, requester: createReference(prac), test, lab: 'Quest Diagnostics' }), identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: `${MARK}-atomic-${test.key}` }] }));
  const batch = await attempt(() => provider.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: batchOrders.map((resource) => ({ resource, request: { method: 'POST', url: 'ServiceRequest' } })) }));
  const savedBatch = await admin.searchResources('ServiceRequest', { subject: p.reference!, identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${MARK}-atomic-${LAB_TESTS[0].key}` });
  report(batch.ok && savedBatch.length === 1, 'Multiple lab orders commit in one transaction', batch.error);
  for (const resource of batchOrders) for (const saved of await admin.searchResources('ServiceRequest', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${resource.identifier[0].value}` })) track(saved);
  const rollbackKey = `${MARK}-rollback`;
  const rollback = await attempt(() => provider.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: [
    { resource: { ...batchOrders[0], identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: rollbackKey }] }, request: { method: 'POST', url: 'ServiceRequest' } },
    { resource: order!, request: { method: 'PUT', url: `ServiceRequest/${order!.id}`, ifMatch: 'W/"0"' } },
  ] }));
  const rolledBack = await admin.searchResources('ServiceRequest', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${rollbackKey}` });
  report(!rollback.ok && rolledBack.length === 0, 'A conflict rolls back the entire lab order transaction', rollback.error);
  rolledBack.forEach(track);
  const filed = await attempt(() => frontdesk.updateResource({ ...lab, context: { related: [{ reference: `ServiceRequest/${order?.id}` }] }, extension: [...(lab.extension ?? []), confirmMatchExtension(fdRef)] }));
  report(filed.ok, 'Front desk files the fax after confirming name and date of birth', filed.error);
  const closeFax = review ? await attempt(() => frontdesk.updateResource({ ...review, status: 'completed', for: p })) : { ok: false, error: 'no review task' };
  report(closeFax.ok, 'The fax review task is completed', closeFax.error);

  console.log('Lab result review (P16)');
  const resultTask = track(await eventually(() => admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|result-review-${fax.id}` }, { cache: 'no-cache' })));
  report(resultTask?.owner?.reference === provRef && resultTask.status === 'requested', 'Filed result creates a review task for the ordering provider');
  const bypassReview = await attempt(() => provider.updateResource({ ...resultTask as Task, status: 'completed' }));
  report(!bypassReview.ok, 'A result task cannot be completed without reviewing its document', bypassReview.error);
  const latest = await provider.readResource('DocumentReference', fax.id as string);
  const other = track(await admin.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'AuditOther', given: ['Synthetic'] }] }))!;
  const otherOrder = track(await provider.createResource(buildLabOrder({ patient: createReference(other), requester: createReference(prac), test: LAB_TESTS[0], lab: 'Quest Diagnostics' })))!;
  const wrongOrder = await attempt(() => provider.updateResource({ ...latest, context: { related: [createReference(otherOrder)] } }));
  report(!wrongOrder.ok && /same patient/.test(wrongOrder.error ?? ''), 'A result cannot be linked to another patient’s lab order', wrongOrder.error);
  const reviewExt = (by: string): DocumentReference['extension'] => [...(latest.extension ?? []), { url: EXT.resultReview, extension: [{ url: 'by', valueReference: { reference: by } }, { url: 'at', valueDateTime: new Date().toISOString() }, { url: 'abnormal', valueBoolean: false }] }];
  const fdReview = await attempt(() => frontdesk.updateResource({ ...latest, extension: reviewExt(fdRef) }));
  report(!fdReview.ok, 'Front desk cannot record a result review', fdReview.error);
  const adminForge = await attempt(() => practiceAdmin.updateResource({ ...latest, extension: reviewExt(provRef) }));
  report(!adminForge.ok && /own name/.test(adminForge.error ?? ''), 'Nobody can record a review in the provider’s name', adminForge.error);
  const reviewed = await attempt(() => provider.updateResource({ ...latest, extension: reviewExt(provRef) }));
  report(reviewed.ok, 'Provider records the review', reviewed.error);
  const doneTask = await eventually(async () => { const t = await admin.readResource('Task', resultTask?.id as string, { cache: 'no-cache' }); return t.status === 'completed' ? t : undefined; });
  const doneOrder = await eventually(async () => { const o = await admin.readResource('ServiceRequest', order?.id as string, { cache: 'no-cache' }); return o.status === 'completed' ? o : undefined; });
  report(!!doneTask && !!doneOrder, 'Review completes the review task and the lab order');
  const changeReview = await attempt(async () => { const d = await provider.readResource('DocumentReference', fax.id as string); return provider.updateResource({ ...d, extension: (d.extension ?? []).map((e) => (e.url === EXT.resultReview ? { ...e, extension: [...(e.extension ?? []).filter((x) => x.url !== 'abnormal'), { url: 'abnormal', valueBoolean: true }] } : e)) }); });
  report(!changeReview.ok && /cannot be changed/.test(changeReview.error ?? ''), 'A recorded review cannot be changed', changeReview.error);
  const reviewedDoc = await provider.readResource('DocumentReference', fax.id!);
  const replaceFile = await attempt(() => provider.updateResource({ ...reviewedDoc, content: [{ attachment: { url: 'Binary/replaced', contentType: 'application/pdf' } }] }));
  report(!replaceFile.ok && /cannot be changed/.test(replaceFile.error ?? ''), 'The file behind a reviewed result cannot be replaced', replaceFile.error);

  console.log('Nothing is lost: removal and closing need reasons');
  const junk = track(await receiveFax(worker, { id: `${MARK}-2`, from: '(206) 555-0123', pages: 1, pdf: textPdf(['blank']), text: 'blank page' })) as DocumentReference;
  const junkTask = track(await admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|fax-review-${junk.id}` }, { cache: 'no-cache' })) as Task;
  const junkDoc = await frontdesk.readResource('DocumentReference', junk.id as string);
  const noReason = await attempt(() => frontdesk.updateResource({ ...junkDoc, status: 'entered-in-error' }));
  report(!noReason.ok && /reason/.test(noReason.error ?? ''), 'Removing a fax without a reason is refused', noReason.error);
  const del = await attempt(() => frontdesk.deleteResource('DocumentReference', junk.id as string));
  report(!del.ok, 'Staff cannot delete a fax', del.error);
  const removed = await attempt(() => frontdesk.updateResource({ ...junkDoc, status: 'entered-in-error', extension: [...(junkDoc.extension ?? []), { url: EXT.removalReason, valueString: 'Blank pages, wrong number' }] }));
  report(removed.ok, 'Removing a fax with a reason keeps it for audit', removed.error);
  const cancelNoReason = await attempt(() => frontdesk.updateResource({ ...junkTask, status: 'cancelled' }));
  report(!cancelNoReason.ok && /reason/.test(cancelNoReason.error ?? ''), 'Closing a task without a reason is refused', cancelNoReason.error);
  const cancelled = await attempt(() => frontdesk.updateResource({ ...junkTask, status: 'cancelled', statusReason: { text: 'Fax removed: blank pages' } }));
  report(cancelled.ok, 'Closing a task with a reason is accepted', cancelled.error);

  console.log('Tasks (P29)');
  const weekly = track(await frontdesk.createResource<Task>({
    resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'general' }] }, description: `${MARK} check fax paper`,
    for: p, performerType: teamCoding('frontdesk'), owner: { reference: fdRef }, restriction: { period: { end: new Date(Date.now() - 86400000).toISOString() } }, extension: [{ url: EXT.recurrence, valueCode: 'weekly' }],
  })) as Task;
  const mine = await frontdesk.search('Task', { ...QUEUES.myTasks.params(fdRef), _summary: 'count' }, { cache: 'no-cache' });
  const mineRows = await frontdesk.searchResources('Task', { ...QUEUES.myTasks.params(fdRef), _count: '1000' }, { cache: 'no-cache' });
  report(mine.total === mineRows.length && mineRows.some((t) => t.id === weekly.id), 'Today’s “My tasks” count equals the Tasks list rows', `${mine.total} vs ${mineRows.length}`);
  await frontdesk.updateResource({ ...weekly, status: 'completed' });
  const next = track(await eventually(() => admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|recur-${weekly.id}` }, { cache: 'no-cache' })));
  report(!!next && next.status === 'requested' && Date.parse(next.restriction?.period?.end ?? '') > Date.now(), 'Completing a weekly task schedules the next one in the future');

  console.log('Patient messages (P03)');
  await handleInbound(worker, '+1 (999) 555-0100', 'Hi, can I move my appointment?');
  const unmatched = track(await eventually(async () => (await admin.searchResources('Communication', { ...QUEUES.messages.params(), _sort: '-_lastUpdated', _count: '20' }, { cache: 'no-cache' })).find((c) => !c.subject && c.extension?.some((e) => e.url === EXT.inboundFrom && e.valueString === '+1 (999) 555-0100'))));
  report(!!unmatched, 'A text from an unknown number is kept for review, not dropped');
  if (unmatched) {
    const msg = await frontdesk.readResource('Communication', unmatched.id as string);
    const blind = await attempt(() => frontdesk.updateResource({ ...msg, subject: p }));
    report(!blind.ok && /Confirm the patient/.test(blind.error ?? ''), 'Matching a message without confirmation is refused', blind.error);
    const matched = await attempt(() => frontdesk.updateResource({ ...msg, subject: p, extension: [...(msg.extension ?? []), confirmMatchExtension(fdRef)] }));
    report(matched.ok, 'Matching with a personal confirmation is accepted', matched.error);
    const m2 = await frontdesk.readResource('Communication', unmatched.id as string);
    const bare = await attempt(() => frontdesk.updateResource({ ...m2, status: 'completed' }));
    report(!bare.ok, 'Closing a message without recording how it was handled is refused', bare.error);
    const handled = await attempt(() => frontdesk.updateResource({ ...m2, status: 'completed', note: [{ text: 'Called back; rescheduled to Friday' }] }));
    report(handled.ok, 'Closing with a note is accepted', handled.error);
  }
  const msgCount = await frontdesk.search('Communication', { ...QUEUES.messages.params(), _summary: 'count' }, { cache: 'no-cache' });
  const msgRows = await frontdesk.searchResources('Communication', { ...QUEUES.messages.params(), _count: '1000' }, { cache: 'no-cache' });
  report(msgCount.total === msgRows.length, 'Today’s “Patient messages” count equals the inbox rows', `${msgCount.total} vs ${msgRows.length}`);
  const faxCount = await frontdesk.search('Task', { ...QUEUES.faxes.params(), _summary: 'count' }, { cache: 'no-cache' });
  const faxRows = await frontdesk.searchResources('Task', { ...QUEUES.faxes.params(), _count: '1000' }, { cache: 'no-cache' });
  report(faxCount.total === faxRows.length, 'Today’s “Faxes to file” count equals the fax queue rows', `${faxCount.total} vs ${faxRows.length}`);

  console.log('Outbound fax');
  const queue = async (to: string): Promise<Communication> => track(await frontdesk.createResource<Communication>({
    resourceType: 'Communication', status: 'preparation', category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'fax-outbound' }] }],
    subject: p, sender: { reference: fdRef }, recipient: [{ display: 'Synthetic clinic' }], payload: [{ contentReference: { reference: `DocumentReference/${fax.id}` } }], extension: [{ url: EXT.faxTo, valueString: to }],
  })) as Communication;
  const good = await queue('(425) 555-0100');
  const bad = await queue('000-000-0000');
  const sent = await sendQueuedFaxes(worker, new LogFaxAdapter(), (c) => [good.id, bad.id].includes(c.id));
  report(sent.sent === 1 && sent.failed === 1, 'Worker sends the fax and records the failed one', JSON.stringify(sent));
  const failTask = track(await admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|fax-failure-${bad.id}` }, { cache: 'no-cache' }));
  report(failTask?.priority === 'urgent', 'A failed fax creates an urgent task');

  console.log('Daily summary email (counts only)');
  const day = new Date('2099-01-05T16:00:00Z');
  track(await provider.createResource<Task>({ resourceType: 'Task', status: 'requested', intent: 'order', description: `${MARK} summary`, for: p, owner: { reference: provRef }, code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'general' }] } }));
  const n1 = await sendDailySummaries(worker, new LogTransport('email'), day, true, prac.id);
  const n2 = await sendDailySummaries(worker, new LogTransport('email'), day, true, prac.id);
  const summary = track(await admin.searchOne('Communication', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|daily-summary-${prac.id}-2099-01-05` }, { cache: 'no-cache' }));
  report(n1 === 1 && n2 === 0, 'One summary per person per day', `${n1}, ${n2}`);
  report(!!summary && !(summary.payload?.[0]?.contentString ?? '').includes('Inboxtest'), 'Summary contains counts only, no patient names');
}

async function cleanup(admin: MedplumClient, patient: Patient): Promise<number> {
  let n = 0;
  const del = async (type: ResourceType, id: string | undefined): Promise<void> => { if (id && (await attempt(() => admin.deleteResource(type, id))).ok) n++; };
  for (const type of ['Task', 'Communication', 'ServiceRequest', 'DocumentReference'] as const) {
    for (const r of await admin.searchResources(type, { subject: `Patient/${patient.id}`, _count: '200' }, { cache: 'no-cache' })) await del(type, r.id);
  }
  for (const r of created.reverse()) await del(r.resourceType, r.id);
  for (const t of await admin.searchResources('Task', { description: MARK, _count: '50' }, { cache: 'no-cache' }).catch(() => [] as Task[])) await del('Task', t.id);
  return n;
}

main().catch((err: unknown) => {
  console.error(normalizeErrorString(err));
  process.exit(1);
});
