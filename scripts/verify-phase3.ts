// Phase 3 gate: documentation, signing, amendments and exports, proven against the server.
// Signed notes can never be deleted (by design, for every user), so the notes this script signs
// stay on one synthetic patient, "Test Verification". Everything else it creates is removed.

import type { MedplumClient, ProfileResource } from '@medplum/core';
import { createReference, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Appointment, Composition, Encounter, Patient, Practitioner } from '@medplum/fhirtypes';
import type { NoteData } from '@teleemon/core';
import { EXT, GENERATED_IDENTIFIER_SYSTEM, SEED_IDENTIFIER_SYSTEM, addOnFor, emFromTime, findTemplate, locationConfirmedExtension, posAndModifiers, readSettings, renderNote, writeSettings } from '@teleemon/core';
import JSZip from 'jszip';
import { Packer } from 'docx';
import { buildDocx } from '../apps/staff/src/export/noteDocument';
import type { ExportInput } from '../apps/staff/src/export/noteDocument';
import { buildAmendment, buildComposition, loadVisit, newNote, signVisit } from '../apps/staff/src/fhir/visits';
import { connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
const TAG = { system: GENERATED_IDENTIFIER_SYSTEM, value: 'verify-phase3' };
let failures = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.slice(0, 120)})` : ''}`);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}

function completeNote(base: NoteData): NoteData {
  return {
    ...base,
    sections: { ...base.sections, chiefComplaint: 'Follow-up', intervalHistory: 'Mood improved; sleeping 7 hours.', assessment: 'Improving on current regimen.', plan: 'Continue sertraline 100 mg daily.', followUp: 'Return in 4 weeks.' },
    mse: { appearance: 'Well groomed', behavior: 'Calm', speech: 'Normal', mood: 'pretty good', affect: 'Euthymic', thoughtProcess: 'Linear', thoughtContent: 'No SI', cognition: 'Alert' },
    risk: { suicidalIdeation: 'denied', homicidalIdeation: 'denied', selfHarm: 'none', level: 'low' },
    psychotherapy: { minutes: 40, modality: 'Cognitive behavioral', focus: 'Behavioral activation' },
    diagnoses: [{ code: 'F41.1', display: 'Generalized anxiety disorder' }],
    billing: { ...base.billing, emMethod: 'mdm', mdm: 'moderate', primaryCode: '99214', addOnCode: '90836' },
    medsReviewed: true,
    privateNotes: 'PRIVATE-PSYCHOTHERAPY-NOTE-MARKER',
  };
}

async function main(): Promise<void> {
  const admin = await connect();
  await cleanup(admin);
  try {
    await checks(admin);
  } finally {
    console.log(`\n(cleaned up ${await cleanup(admin)} test resources; signed test notes stay on "Test Verification")`);
  }
  console.log(failures === 0 ? '\n✓ Phase 3 server-side checks passed' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(admin: MedplumClient): Promise<number> {
  let n = 0;
  const tag = `${TAG.system}|${TAG.value}`;
  // Drafts can be deleted; signed notes cannot (and are left in place).
  for (const c of await admin.searchResources('Composition', { identifier: tag, status: 'preliminary', _count: '200' }, { cache: 'no-cache' })) {
    if ((await attempt(() => admin.deleteResource('Composition', c.id as string))).ok) n++;
  }
  for (const e of await admin.searchResources('Encounter', { identifier: tag, _count: '200' }, { cache: 'no-cache' })) {
    const signed = await admin.searchOne('Composition', { encounter: `Encounter/${e.id}`, status: 'final' });
    if (!signed && (await attempt(() => admin.deleteResource('Encounter', e.id as string))).ok) n++;
  }
  return n;
}

async function checks(admin: MedplumClient): Promise<void> {
  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const practiceAdmin = await connectAsPassword('admin@teleemon.test', PASSWORD);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const providerProfile = provider.getProfile() as ProfileResource;
  const adminProfile = practiceAdmin.getProfile() as ProfileResource;
  const practitioner = (await admin.searchOne('Practitioner', { identifier: `${SEED_IDENTIFIER_SYSTEM}|prac-provider` })) as Practitioner;

  // The synthetic patient that holds verification notes.
  let patient = await admin.searchOne('Patient', { identifier: `${SEED_IDENTIFIER_SYSTEM}|verify-patient` });
  patient ??= await admin.createResource<Patient>({
    resourceType: 'Patient',
    identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: 'verify-patient' }],
    name: [{ given: ['Test'], family: 'Verification' }],
    birthDate: '1980-01-01',
    gender: 'unknown',
    address: [{ state: 'WA' }],
    telecom: [{ system: 'phone', value: '206-555-0199' }],
  });

  const encounter = (state: string, startedDaysAgo = 0): Encounter => ({
    resourceType: 'Encounter',
    identifier: [TAG],
    status: 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR' },
    type: [{ coding: [{ system: 'https://fhir.teleemon.com/CodeSystem/visit-type', code: 'med-mgmt-therapy' }], text: 'Med management + psychotherapy' }],
    subject: createReference(patient as Patient),
    participant: [{ individual: createReference(practitioner) }],
    period: { start: new Date(Date.now() - startedDaysAgo * 86400000).toISOString() },
    extension: [
      { url: EXT.modality, valueCode: 'video' },
      { url: EXT.patientLocationState, valueCode: state },
    ],
  });

  console.log('\nStarting visits (encounter-rules Bot)');
  const tx = await attempt(() => provider.createResource(encounter('TX')));
  report(!tx.ok && /can't start/i.test(tx.error ?? ''), 'A visit cannot start while the patient is in Texas', tx.error);
  const wa = await attempt(() => provider.createResource(encounter('WA')));
  report(wa.ok, 'A visit starts when the patient is in Washington', wa.error);
  if (!wa.value) return;

  console.log('\nDrafts and signing (note-rules Bot)');
  const ctx = await loadVisit(provider, wa.value.id as string);
  const blank = await newNote(provider, wa.value);
  report(blank.template === 'med-mgmt-therapy' && !!findTemplate(blank.template)?.psychotherapy, 'The note uses the template for the visit type', blank.template);
  const draft = await attempt(() => provider.createResource({ ...buildComposition(ctx, blank, providerProfile), identifier: TAG }));
  report(draft.ok && draft.value?.status === 'preliminary', 'An incomplete draft saves (autosave never blocks)', draft.error);
  if (!draft.value) return;
  const withNote = { ...ctx, note: draft.value };

  const noDx = await attempt(() => provider.updateResource(buildComposition(withNote, { ...completeNote(blank), diagnoses: [] }, providerProfile, { sign: true })));
  report(!noDx.ok && /diagnosis/i.test(noDx.error ?? ''), 'Signing without a diagnosis is refused', noDx.error);
  const shortTherapy = completeNote(blank);
  shortTherapy.psychotherapy = { ...shortTherapy.psychotherapy, minutes: 20 };
  const short = await attempt(() => provider.updateResource(buildComposition(withNote, shortTherapy, providerProfile, { sign: true })));
  report(!short.ok && /38–52/.test(short.error ?? ''), '90836 with only 20 minutes of psychotherapy is refused', short.error);
  const byTime = completeNote(blank);
  byTime.billing = { ...byTime.billing, emMethod: 'time', totalMinutes: 45 };
  const timeErr = await attempt(() => provider.updateResource(buildComposition(withNote, byTime, providerProfile, { sign: true })));
  report(!timeErr.ok && /decision making/i.test(timeErr.error ?? ''), 'An add-on with E/M chosen by time is refused (time cannot count twice)', timeErr.error);
  const highRisk = completeNote(blank);
  highRisk.risk = { ...highRisk.risk, suicidalIdeation: 'active-no-plan', level: 'high', safetyPlanReviewed: false };
  const risk = await attempt(() => provider.updateResource(buildComposition(withNote, highRisk, providerProfile, { sign: true })));
  report(!risk.ok && /safety plan/i.test(risk.error ?? ''), 'Active suicidal ideation without a reviewed safety plan is refused', risk.error);

  const byAdmin = await attempt(() => practiceAdmin.updateResource(buildComposition(withNote, completeNote(blank), adminProfile, { sign: true })));
  report(!byAdmin.ok && /Only the visit's provider/i.test(byAdmin.error ?? ''), "An administrator cannot sign the provider's note", byAdmin.error);

  const impersonation = await attempt(() => practiceAdmin.updateResource(buildComposition(withNote, completeNote(blank), providerProfile, { sign: true })));
  report(!impersonation.ok && /Only the visit's provider/i.test(impersonation.error ?? ''), 'An administrator cannot impersonate the provider in the attester field', impersonation.error);
  const mismatched = buildComposition(withNote, completeNote(blank), providerProfile, { sign: true });
  mismatched.section = [{ title: 'Plan', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Different narrative without diagnosis or assessment.</div>' } }];
  const narrative = await attempt(() => provider.updateResource(mismatched));
  report(!narrative.ok && /narrative must match/i.test(narrative.error ?? ''), 'Valid JSON cannot conceal a missing or contradictory signed narrative', narrative.error);
  const amended = await attempt(() => provider.updateResource({ ...draft.value!, status: 'amended', attester: undefined, extension: [] }));
  report(!amended.ok && /draft or a final note/i.test(amended.error ?? ''), 'The amended status cannot bypass signing validation', amended.error);

  const signed = await attempt(() => provider.updateResource({ ...buildComposition(withNote, completeNote(blank), providerProfile, { sign: true }), identifier: TAG }));
  report(signed.ok && signed.value?.status === 'final' && !!signed.value.attester?.[0]?.time, 'The provider signs a complete note (legal attestation recorded)', signed.error);
  if (!signed.value) return;
  report(getExtensionValue(signed.value, EXT.lateEntry) !== true, 'A same-day note is not a late entry');

  console.log('\nSigned notes are locked');
  const edit = await attempt(() => provider.updateResource({ ...signed.value, title: 'Changed' } as Composition));
  report(!edit.ok, 'The provider cannot edit a signed note', edit.error);
  const adminEdit = await attempt(() => admin.updateResource({ ...signed.value, title: 'Changed' } as Composition));
  report(!adminEdit.ok && /locked/i.test(adminEdit.error ?? ''), 'Neither can an administrator or service account', adminEdit.error);
  const del = await attempt(() => admin.deleteResource('Composition', signed.value?.id as string));
  report(!del.ok, 'A signed note cannot be deleted', del.error);
  const fdRead = await attempt(() => frontdesk.readResource('Composition', signed.value?.id as string));
  report(!fdRead.ok, 'Front desk cannot read the note');

  console.log('\nAddenda and corrections');
  const signedCtx = await loadVisit(provider, wa.value.id as string);
  const noReason = await attempt(() => provider.createResource({ ...buildAmendment(signedCtx, providerProfile, 'appends', 'Labs reviewed: lithium 0.8.', ''), identifier: TAG }));
  report(!noReason.ok && /reason/i.test(noReason.error ?? ''), 'An addendum without a reason is refused', noReason.error);
  const addendum = await attempt(() => provider.createResource({ ...buildAmendment(signedCtx, providerProfile, 'appends', 'Labs reviewed after the visit.', 'Lab or outside record review'), identifier: TAG }));
  report(addendum.ok && addendum.value?.relatesTo?.[0]?.code === 'appends', 'A signed addendum is added', addendum.error);
  const original = await admin.readResource('Composition', signed.value.id as string, { cache: 'no-cache' });
  report(original.meta?.versionId === signed.value.meta?.versionId, 'The original note is unchanged by the addendum');

  const bookedAtomicAppointment = await provider.createResource<Appointment>({
    resourceType: 'Appointment', identifier: [TAG], status: 'booked',
    start: new Date(Date.now() - 7 * 86400000).toISOString(), end: new Date(Date.now() - 7 * 86400000 + 3600000).toISOString(),
    participant: [{ actor: createReference(patient), status: 'accepted' }, { actor: createReference(practitioner), status: 'accepted' }],
    extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.overbookReason, valueString: 'Phase 3 boundary verification visit' }],
  });
  const atomicAppointment = await provider.updateResource<Appointment>({
    ...bookedAtomicAppointment,
    status: 'checked-in',
    extension: [...(bookedAtomicAppointment.extension ?? []), locationConfirmedExtension(createReference(providerProfile).reference, 'WA', new Date())],
  });
  const otherVisit = await provider.createResource({ ...encounter('WA'), appointment: [createReference(atomicAppointment)] });
  const crossVisit = await attempt(() => provider.createResource({ ...buildAmendment({ ...signedCtx, encounter: otherVisit }, providerProfile, 'appends', 'Wrong encounter target.', 'Synthetic boundary verification'), identifier: TAG }));
  report(!crossVisit.ok && /same patient and visit/i.test(crossVisit.error ?? ''), 'An amendment cannot target a note from a different visit', crossVisit.error);
  const crossPatient = await attempt(() => provider.createResource({ ...buildAmendment(signedCtx, providerProfile, 'appends', 'Wrong patient.', 'Synthetic boundary verification'), subject: { reference: 'Patient/different-patient' }, identifier: TAG }));
  report(!crossPatient.ok && /patient must match/i.test(crossPatient.error ?? ''), 'An amendment cannot claim a different patient', crossPatient.error);

  console.log('\nAtomic signing and visit completion');
  const atomicContext = await loadVisit(provider, otherVisit.id as string);
  const atomicData = completeNote(await newNote(provider, otherVisit));
  const atomicDraft = await provider.createResource({ ...buildComposition(atomicContext, atomicData, providerProfile), identifier: TAG });
  const atomic = { ...atomicContext, note: atomicDraft };
  const conflictClient = new Proxy(provider, {
    get(target, key) {
      if (key === 'executeBatch') return (bundle: Parameters<MedplumClient['executeBatch']>[0]) => {
        if (bundle.entry?.[2]?.request) bundle.entry[2].request.ifMatch = 'W/"deliberately-stale-version"';
        return target.executeBatch(bundle);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const rolledBack = await attempt(() => signVisit(conflictClient, atomic, atomicData, providerProfile));
  const afterConflict = await provider.readResource('Composition', atomicDraft.id as string, { cache: 'no-cache' });
  const encounterAfterConflict = await provider.readResource('Encounter', otherVisit.id as string, { cache: 'no-cache' });
  report(!rolledBack.ok && afterConflict.status === 'preliminary' && encounterAfterConflict.status === 'in-progress', 'An appointment conflict rolls back both signature and encounter completion', rolledBack.error);
  const completed = await attempt(() => signVisit(provider, atomic, atomicData, providerProfile));
  const finished = await provider.readResource('Encounter', otherVisit.id as string, { cache: 'no-cache' });
  const fulfilled = await provider.readResource('Appointment', atomicAppointment.id as string, { cache: 'no-cache' });
  report(completed.ok && finished.status === 'finished' && fulfilled.status === 'fulfilled' && (await provider.readResource('Composition', atomicDraft.id as string, { cache: 'no-cache' })).status === 'final', 'Signature, encounter completion and calendar status commit together', completed.error);

  console.log('\nLate entries');
  const old = await attempt(() => provider.createResource(encounter('WA', 4)));
  if (old.value) {
    const oldCtx = await loadVisit(provider, old.value.id as string);
    const oldNote = completeNote(await newNote(provider, old.value));
    const lateNote = await attempt(() => provider.createResource({ ...buildComposition(oldCtx, oldNote, providerProfile, { sign: true }), identifier: TAG }));
    report(lateNote.ok && getExtensionValue(lateNote.value as Composition, EXT.lateEntry) === true, 'A note signed 4 days after the visit is flagged as a late entry', lateNote.error);
  }

  console.log('\nCoding helpers');
  report(emFromTime(35) === '99214' && emFromTime(45) === '99215' && emFromTime(8) === undefined, 'E/M by time: 35 min → 99214, 45 → 99215, under 10 → none');
  report(addOnFor(15) === undefined && addOnFor(16) === '90833' && addOnFor(40) === '90836' && addOnFor(53) === '90838', 'Psychotherapy add-ons: 16 → 90833, 40 → 90836, 53 → 90838');
  const phone = posAndModifiers('phone');
  report(phone.pos === '10' && phone.modifiers.join() === '93' && posAndModifiers('office').pos === '11', 'POS and modifiers: audio-only from home → 10 + 93; office → 11');

  console.log('\nExports (Word)');
  const data = completeNote(blank);
  const input: ExportInput = {
    practice: { name: 'Teleemon Behavioral Health & Wellness, PLLC', address: 'Bellevue, WA' },
    patient: { name: 'Test Verification', firstName: 'Test', dob: '01/01/1980' },
    visit: { date: '10/16/2026', time: '10:00 AM', type: 'Med management + psychotherapy', modality: 'Video', state: 'WA' },
    provider: { name: 'Jordan Ellis', credentials: 'PMHNP-BC' },
    note: data,
    sections: renderNote(data),
    medications: ['Sertraline · 100 mg daily'],
    signed: { at: '10/16/2026 10:40 AM', by: 'Jordan Ellis' },
    amendments: [],
  };
  const docText = async (kind: 'full' | 'summary' | 'avs'): Promise<string> => {
    const zip = await JSZip.loadAsync(await Packer.toBuffer(buildDocx(input, kind)));
    return (await zip.file('word/document.xml')?.async('string')) ?? '';
  };
  const summary = await docText('summary');
  report(summary.includes('Test Verification') && summary.includes('Electronically signed by Jordan Ellis') && summary.includes('Mental status examination'), 'The session summary is a valid .docx with header, MSE and attestation');
  report(!summary.includes('PRIVATE-PSYCHOTHERAPY-NOTE-MARKER') && !(await docText('full')).includes('PRIVATE-PSYCHOTHERAPY-NOTE-MARKER'), 'Private psychotherapy notes are never exported');
  const avs = await docText('avs');
  report(avs.includes('988') && avs.includes('Continue sertraline') && !avs.includes('Mental status') && !avs.includes('Denies suicidal'), 'The after-visit summary has the plan and crisis line, without MSE or risk details');

  console.log('\nTemplates');
  const before = await readSettings(admin, 'templates');
  await writeSettings(admin, 'templates', { ...before, defaults: { ...before.defaults, 'med-mgmt-therapy': { plan: 'VERIFY-DEFAULT-PLAN' } } });
  const fresh = await newNote(provider, wa.value);
  await writeSettings(admin, 'templates', before);
  const draftStill = (JSON.parse(getExtensionValue(draft.value, EXT.noteData) as string) as NoteData).sections.plan;
  report(fresh.sections.plan === 'VERIFY-DEFAULT-PLAN' && draftStill !== 'VERIFY-DEFAULT-PLAN', 'Template changes apply to new notes only');
}

main().catch((err: unknown) => {
  console.error(`✗ ${normalizeErrorString(err)}`);
  process.exit(1);
});

