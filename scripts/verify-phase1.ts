// Phase 1 gate: proves the hard rules are enforced by the server, by calling the API directly
// as each role with no UI involved (IMPLEMENTATION-PLAN.md "Every gate includes a design check").
// Run after `npm run setup` and `npm run seed`. Leaves no data behind.

import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { MedicationStatement, Patient, QuestionnaireResponse, Resource, ResourceType } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, ICD10CM_SYSTEM, MEASURES, MRN_SYSTEM, SEED_IDENTIFIER_SYSTEM, guardianContact, questionnaireUrl } from '@teleemon/core';
import { connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
let failures = 0;
let checks = 0;

function report(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function outcome(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}

async function canSearch(m: MedplumClient, type: ResourceType): Promise<boolean> {
  return (await outcome(() => m.search(type, { _count: '1' }, { cache: 'no-cache' }))).ok;
}

async function main(): Promise<void> {
  const admin = await connect();
  const seedPatient = async (key: string): Promise<Patient> =>
    (await admin.searchOne('Patient', { identifier: `${SEED_IDENTIFIER_SYSTEM}|${key}` })) as Patient;
  const maya = await seedPatient('pt-01');
  const priya = await seedPatient('pt-03');

  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const biller = await connectAsPassword('biller@teleemon.test', PASSWORD);

  console.log('\nRole permissions (AccessPolicy, enforced by Medplum)');
  report(await canSearch(provider, 'Condition'), 'Provider can read problems (Condition)');
  report(await canSearch(provider, 'Observation'), 'Provider can read measures (Observation)');
  report(await canSearch(frontdesk, 'Patient'), 'Front desk can read patients');
  report(await canSearch(frontdesk, 'Appointment'), 'Front desk can read appointments');
  report(!(await canSearch(frontdesk, 'Condition')), 'Front desk is refused problems (Condition)');
  report(!(await canSearch(frontdesk, 'Observation')), 'Front desk is refused measures (Observation)');
  report(!(await canSearch(frontdesk, 'QuestionnaireResponse')), 'Front desk is refused questionnaire answers');
  report(!(await canSearch(frontdesk, 'Composition')), 'Front desk is refused clinical notes (Composition)');
  report(await canSearch(biller, 'Coverage'), 'Biller can read coverage');
  report(!(await canSearch(biller, 'MedicationStatement')), 'Biller is refused medications');
  report(!(await canSearch(biller, 'Observation')), 'Biller is refused measures');
  const billerWrite = await outcome(() =>
    biller.createResource({ resourceType: 'Condition', subject: { reference: `Patient/${maya.id}` }, code: { text: 'x' } })
  );
  report(!billerWrite.ok, 'Biller cannot create a diagnosis', billerWrite.error);
  const frontPatientEdit = await outcome(() => frontdesk.readResource('Patient', maya.id as string));
  report(frontPatientEdit.ok, 'Front desk can open a patient record');

  console.log('\nDuplicate-patient rule (pre-commit Bot)');
  const duplicate: Patient = {
    resourceType: 'Patient',
    name: [{ given: ['Mia'], family: 'Thornton' }],
    birthDate: maya.birthDate,
    telecom: [{ system: 'phone', value: '206-555-9999' }],
  };
  const dupByFront = await outcome(() => frontdesk.createResource(duplicate));
  report(!dupByFront.ok && /duplicate/i.test(dupByFront.error ?? ''), 'Front desk cannot save a likely duplicate', dupByFront.error?.slice(0, 90));
  const overrideByFront = await outcome(() =>
    frontdesk.createResource({ ...duplicate, extension: [{ url: EXT.duplicateOverride, valueString: 'Confirmed different person by phone' }] })
  );
  report(!overrideByFront.ok, 'Front desk cannot override the duplicate check');
  let overrideId: string | undefined;
  const overrideByAdmin = await outcome(async () => {
    const p = await admin.createResource({ ...duplicate, extension: [{ url: EXT.duplicateOverride, valueString: 'Confirmed different person by phone' }] });
    overrideId = p.id;
  });
  report(overrideByAdmin.ok, 'Administrator can override with a reason', overrideByAdmin.error);
  let assignedMrn: string | undefined;
  const distinct = await outcome(async () => {
    const p = await frontdesk.createResource<Patient>({ resourceType: 'Patient', name: [{ given: ['Verify'], family: 'Uniqueperson' }], birthDate: '1960-01-01' });
    assignedMrn = p.identifier?.find((i) => i.system === MRN_SYSTEM)?.value;
    await admin.deleteResource('Patient', p.id as string);
  });
  report(distinct.ok, 'A genuinely new patient saves normally', distinct.error);
  report(!!assignedMrn && /^TM-[0-9A-F]{8}$/.test(assignedMrn), 'The server assigns a chart number to every new patient', assignedMrn);
  if (overrideId) await admin.deleteResource('Patient', overrideId);

  console.log('\nMeasure scoring and safety alerts (Bot)');
  const responses = await admin.search('QuestionnaireResponse', { status: 'completed', _summary: 'count' }, { cache: 'no-cache' });
  const scores = await admin.search('Observation', { category: 'survey', _summary: 'count' }, { cache: 'no-cache' });
  report((scores.total ?? 0) >= (responses.total ?? 1), 'Every completed measure has a score Observation', `${scores.total}/${responses.total}`);
  // The seeded flag may legitimately have been reviewed (inactive + review note) during checklist
  // testing; either state proves the Bot created it. The repair check below uses fresh data.
  const flags = await admin.searchResources('Flag', { subject: `Patient/${priya.id}` }, { cache: 'no-cache' });
  const flag = flags.find(
    (f) =>
      f.code.coding?.some((c) => c.system === CODE_SYSTEMS.flagCode && c.code === 'safety-screen-positive') &&
      (f.status === 'active' || (f.status === 'inactive' && f.extension?.some((e) => e.url === EXT.reviewNote)))
  );
  report(!!flag, 'Positive PHQ-9 item 9 created a safety Flag (active, or closed with a provider review note)', flag?.status);
  const task = await admin.searchOne('Task', { subject: `Patient/${priya.id}`, code: `${CODE_SYSTEMS.taskCode}|safety-review` }, { cache: 'no-cache' });
  report(task?.priority === 'stat', 'and an urgent safety-review Task', task ? `owner ${task.owner?.reference}` : 'missing');

  console.log('\nAudit trail');
  await frontdesk.readResource('Patient', maya.id as string, { cache: 'no-cache' });
  await new Promise((r) => setTimeout(r, 1500));
  const audit = await admin.search('AuditEvent', { entity: `Patient/${maya.id}`, _sort: '-_lastUpdated', _count: '5' }, { cache: 'no-cache' });
  report((audit.entry?.length ?? 0) > 0, 'Chart reads are recorded as AuditEvents', `${audit.entry?.length ?? 0} recent`);
  const tamper = await outcome(async () => {
    const ev = audit.entry?.[0]?.resource;
    if (ev) await frontdesk.updateResource({ ...ev, outcomeDesc: 'tampered' });
    else throw new Error('no event');
  });
  report(!tamper.ok, 'Front desk cannot edit an AuditEvent');
  const read = await outcome(() => frontdesk.search('AuditEvent', { _count: '1' }));
  report(!read.ok, 'Front desk cannot browse the audit log');
  const del = await outcome(() => frontdesk.deleteResource('Patient', maya.id as string));
  report(!del.ok, 'Front desk cannot hard-delete a patient record', del.error);

  await regressions(admin, provider, frontdesk, maya);

  console.log(`\n${checks - failures} PASS, ${failures} FAIL (${checks} checks)`);
  console.log(failures === 0 ? '✓ Phase 1 server-side checks passed' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function regressions(admin: MedplumClient, provider: MedplumClient, frontdesk: MedplumClient, maya: Patient): Promise<void> {
  console.log('\nPhase 1 regression checks (direct API, disposable synthetic records)');
  const cleanup: Resource[] = [];
  const track = <T extends Resource>(r: T): T => { cleanup.push(r); return r; };
  const suffix = crypto.randomUUID().slice(0, 8);
  const identifier = (key: string): string => `${DERIVED_IDENTIFIER_SYSTEM}|${key}`;
  async function waitFor<T>(fn: () => Promise<T | undefined>): Promise<T | undefined> {
    for (let i = 0; i < 30; i++) {
      const value = await fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return undefined;
  }
  try {
    const minor: Patient = { resourceType: 'Patient', name: [{ given: ['Verify'], family: `Minor${suffix}` }], birthDate: '2014-05-01' };
    const noGuardian = await outcome(async () => track(await frontdesk.createResource(minor)));
    report(!noGuardian.ok && /guardian/i.test(noGuardian.error ?? ''), 'Server refuses a minor without guardian details', noGuardian.error?.slice(0, 100));
    const details = { given: 'Verify', family: 'Guardian', relationship: 'Mother', phone: '425-555-0194', authority: true };
    const noAuthority = await outcome(async () => track(await frontdesk.createResource({ ...minor, contact: [guardianContact({ ...details, authority: false })] })));
    report(!noAuthority.ok && /guardian/i.test(noAuthority.error ?? ''), 'Server requires confirmation of guardian authority');
    const validMinor = await outcome(async () => track(await frontdesk.createResource({ ...minor, contact: [guardianContact(details)] })));
    report(validMinor.ok, 'Minor with complete confirmed guardian saves', validMinor.error);

    const invalidDiagnosis = await outcome(async () => track(await provider.createResource({ resourceType: 'Condition', subject: { reference: `Patient/${maya.id}` }, code: { coding: [{ system: ICD10CM_SYSTEM, code: 'INVALID' }] } })));
    report(!invalidDiagnosis.ok && /catalogue|billable/i.test(invalidDiagnosis.error ?? ''), 'Server refuses an invalid diagnosis code');
    const duplicateDiagnosis = await outcome(async () => track(await provider.createResource({ resourceType: 'Condition', subject: { reference: `Patient/${maya.id}` }, code: { coding: [{ system: ICD10CM_SYSTEM, code: 'F41.1' }] } })));
    report(!duplicateDiagnosis.ok && /already|duplicate/i.test(duplicateDiagnosis.error ?? ''), 'Server refuses a duplicate unresolved diagnosis');

    const adult = track(await frontdesk.createResource<Patient>({ resourceType: 'Patient', name: [{ given: ['Verify'], family: `Adult${suffix}` }], birthDate: '1960-01-02' }));
    const response: QuestionnaireResponse = {
      resourceType: 'QuestionnaireResponse', questionnaire: questionnaireUrl('phq9'), status: 'completed',
      subject: { reference: `Patient/${adult.id}` }, authored: new Date().toISOString(),
      item: MEASURES.phq9.items.map((i, n) => ({ linkId: i.linkId, answer: [{ valueInteger: n === 8 ? 1 : 0 }] })),
    };
    const incomplete = await outcome(async () => track(await provider.createResource({ ...response, item: response.item?.slice(0, 8) })));
    report(!incomplete.ok && /every item/i.test(incomplete.error ?? ''), 'Server refuses an incomplete completed measure');

    const fresh = track(await provider.createResource(response));
    const freshTask = await waitFor(() => admin.searchOne('Task', { identifier: identifier(`safety-task-${fresh.id}`) }, { cache: 'no-cache' }));
    const freshFlag = await admin.searchOne('Flag', { identifier: identifier(`safety-flag-${fresh.id}`) }, { cache: 'no-cache' });
    const freshScore = await admin.searchOne('Observation', { 'derived-from': `QuestionnaireResponse/${fresh.id}` }, { cache: 'no-cache' });
    if (freshTask) track(freshTask);
    if (freshFlag) track(freshFlag);
    if (freshScore) track(freshScore);
    report(!!freshScore && freshTask?.priority === 'stat' && freshFlag?.status === 'active', 'New positive measure atomically produces score, Flag and urgent Task');
    report(freshFlag?.extension?.some((e) => e.valueReference?.reference === `Observation/${freshScore?.id}`) ?? false, 'Transaction resolves the safety flag reference to the saved score');

    // Simulate a legacy partial delivery: the score exists before the completed response is delivered.
    const draft = track(await provider.createResource({ ...response, status: 'in-progress' }));
    const oldScore = track(await provider.createResource({
      resourceType: 'Observation', status: 'final', category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }],
      code: { coding: [MEASURES.phq9.scoreCode] }, subject: { reference: `Patient/${adult.id}` }, valueInteger: 1, derivedFrom: [{ reference: `QuestionnaireResponse/${draft.id}` }],
    }));
    await provider.updateResource({ ...draft, status: 'completed' });
    const safetyTask = await waitFor(() => admin.searchOne('Task', { identifier: identifier(`safety-task-${draft.id}`) }, { cache: 'no-cache' }));
    const safetyFlag = await admin.searchOne('Flag', { identifier: identifier(`safety-flag-${draft.id}`) }, { cache: 'no-cache' });
    if (safetyTask) track(safetyTask);
    if (safetyFlag) track(safetyFlag);
    report(safetyTask?.priority === 'stat' && safetyFlag?.status === 'active', 'Existing score does not prevent missing safety Flag/Task from being repaired');
    report(safetyFlag?.extension?.some((e) => e.valueReference?.reference === `Observation/${oldScore.id}`) ?? false, 'Repaired safety flag references the original score');
    const latest = await provider.readResource('QuestionnaireResponse', draft.id as string, { cache: 'no-cache' });
    await provider.updateResource({ ...latest, authored: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const tasks = await admin.searchResources('Task', { identifier: identifier(`safety-task-${draft.id}`) }, { cache: 'no-cache' });
    report(tasks.length === 1, 'Measure redelivery does not duplicate the urgent task');

    const med = track(await provider.createResource<MedicationStatement>({ resourceType: 'MedicationStatement', status: 'active', subject: { reference: `Patient/${adult.id}` }, medicationCodeableConcept: { text: 'Lithium carbonate' }, dateAsserted: new Date().toISOString() }));
    const monitoring = await waitFor(() => admin.searchOne('Task', { identifier: identifier(`monitoring-${med.id}`) }, { cache: 'no-cache' }));
    if (monitoring) track(monitoring);
    report(monitoring?.focus?.reference === `MedicationStatement/${med.id}`, 'Direct API medication entry creates its lab-monitoring task');
    await provider.updateResource({ ...med, dosage: [{ text: 'Updated synthetic directions' }] });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const monitoringTasks = await admin.searchResources('Task', { identifier: identifier(`monitoring-${med.id}`) }, { cache: 'no-cache' });
    report(monitoringTasks.length === 1, 'Medication redelivery does not duplicate the monitoring task');
  } finally {
    for (const r of cleanup.reverse()) {
      await admin.deleteResource(r.resourceType, r.id as string);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${normalizeErrorString(err)}`);
  process.exit(1);
});
