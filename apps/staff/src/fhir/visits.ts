import type { MedplumClient } from '@medplum/core';
import { createReference, getExtensionValue } from '@medplum/core';
import type { ProfileResource } from '@medplum/core';
import type { Appointment, Bundle, BundleEntry, Composition, Encounter, Patient, Practitioner, Reference, Resource } from '@medplum/fhirtypes';
import type { Modality, NoteData, NoteTemplate } from '@teleemon/core';
import {
  CODE_SYSTEMS,
  EXT,
  MEASURES,
  emptyNote,
  findTemplate,
  findVisitType,
  isLateEntry,
  readSettings,
  noteSections,
  templateForVisitType,
} from '@teleemon/core';
import { formatDate } from '../utils/format';

// Visits (Encounter) and their notes (Composition): P21, P23, P24.

export interface VisitContext {
  readonly encounter: Encounter;
  readonly patient: Patient;
  readonly practitioner?: Practitioner;
  readonly appointment?: Appointment;
  /** The visit note: a draft (preliminary) or the signed original (final). */
  readonly note?: Composition;
  /** Addenda and corrections to the signed note, oldest first. */
  readonly amendments: Composition[];
}

export function noteData(c: Composition | undefined): NoteData | undefined {
  const json = c && (getExtensionValue(c, EXT.noteData) as string | undefined);
  return json ? (JSON.parse(json) as NoteData) : undefined;
}

export function visitModality(e: Encounter): Modality | undefined {
  return getExtensionValue(e, EXT.modality) as Modality | undefined;
}

export function visitState(e: Encounter): string | undefined {
  return getExtensionValue(e, EXT.patientLocationState) as string | undefined;
}

export async function loadVisit(medplum: MedplumClient, encounterId: string): Promise<VisitContext> {
  const encounter = await medplum.readResource('Encounter', encounterId, { cache: 'no-cache' });
  const [patient, practitioner, appointment, notes] = await Promise.all([
    medplum.readReference(encounter.subject as Reference<Patient>),
    encounter.participant?.[0]?.individual ? medplum.readReference(encounter.participant[0].individual as Reference<Practitioner>).catch(() => undefined) : undefined,
    encounter.appointment?.[0] ? medplum.readReference(encounter.appointment[0]).catch(() => undefined) : undefined,
    medplum.searchResources('Composition', { encounter: `Encounter/${encounterId}`, _sort: '_lastUpdated', _count: '50' }, { cache: 'no-cache' }),
  ]);
  const note = notes.find((n) => !n.relatesTo?.length);
  const amendments = notes.filter((n) => n.relatesTo?.length);
  return { encounter, patient, practitioner, appointment, note, amendments };
}

/** Starts (or reopens) the visit for a checked-in appointment. The encounter-rules Bot checks licensure. */
export async function startVisit(medplum: MedplumClient, appointment: Appointment): Promise<Encounter> {
  const existing = await medplum.searchOne('Encounter', { appointment: `Appointment/${appointment.id}` }, { cache: 'no-cache' });
  if (existing) return existing;
  const patientRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor as Reference<Patient>;
  const practitionerRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor as Reference<Practitioner>;
  const modality = getExtensionValue(appointment, EXT.modality) as Modality | undefined;
  const visitCode = appointment.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code;
  const org = await medplum.searchOne('Organization', {}).catch(() => undefined);
  return medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'in-progress',
    class: modality === 'office' ? { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' } : { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR', display: 'virtual' },
    type: [{ coding: visitCode ? [{ system: CODE_SYSTEMS.visitType, code: visitCode }] : undefined, text: findVisitType(visitCode)?.label ?? appointment.appointmentType?.text ?? 'Visit' }],
    subject: patientRef,
    participant: practitionerRef ? [{ individual: practitionerRef }] : undefined,
    appointment: [createReference(appointment)],
    period: { start: new Date().toISOString() },
    serviceProvider: org ? createReference(org) : undefined,
    extension: (appointment.extension ?? []).filter((e) => e.url === EXT.modality || e.url === EXT.patientLocationState),
  });
}

/** An unscheduled note (telephone or crisis) from the chart. */
export async function startAdHocVisit(medplum: MedplumClient, patient: Patient, practitioner: ProfileResource, opts: { template: 'telephone' | 'crisis'; modality: Modality; state: string }): Promise<Encounter> {
  return medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR', display: 'virtual' },
    type: [{ coding: [{ system: CODE_SYSTEMS.noteTemplate, code: opts.template }], text: findTemplate(opts.template)?.label }],
    subject: createReference(patient),
    participant: [{ individual: createReference(practitioner as Practitioner) }],
    period: { start: new Date().toISOString() },
    extension: [
      { url: EXT.modality, valueCode: opts.modality },
      { url: EXT.patientLocationState, valueCode: opts.state },
    ],
  });
}

/** The template for a visit: its visit type, or the ad-hoc template it was started with. */
export function templateForVisit(e: Encounter): NoteTemplate {
  const code = e.type?.[0]?.coding?.[0];
  if (code?.system === CODE_SYSTEMS.noteTemplate) return findTemplate(code.code) ?? templateForVisitType(undefined);
  return templateForVisitType(code?.code);
}

/** A new note with the practice's template defaults (P41) applied. Copies text, so later template edits never change it. */
export async function newNote(medplum: MedplumClient, e: Encounter): Promise<NoteData> {
  const template = templateForVisit(e);
  const settings = await readSettings(medplum, 'templates').catch(() => undefined);
  const note = emptyNote(template, visitModality(e));
  note.sections = { ...note.sections, ...(settings?.defaults?.[template.code] ?? {}) };
  return note;
}

/** "PHQ-9 6 (Minimal), was 8 · GAD-7 7 …" from the patient's recent scores. */
export async function measuresSummary(medplum: MedplumClient, patient: Patient): Promise<string> {
  const obs = await medplum.searchResources('Observation', { subject: `Patient/${patient.id}`, category: 'survey', _sort: '-date', _count: '100' }).catch(() => []);
  const lines: string[] = [];
  for (const def of Object.values(MEASURES)) {
    const series = obs.filter((o) => o.code.coding?.some((c) => c.code === def.scoreCode.code));
    if (!series.length) continue;
    const [last, prev] = series;
    lines.push(
      `${def.shortTitle} ${last.valueInteger}${last.interpretation?.[0]?.text ? ` (${last.interpretation[0].text})` : ''} on ${formatDate(last.effectiveDateTime?.slice(0, 10))}${prev ? `, previously ${prev.valueInteger}` : ''}`
    );
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function narrative(text: string): { status: 'generated'; div: string } {
  return { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeHtml(text).replace(/\n/g, '<br/>')}</div>` };
}

/** Builds the Composition for a note. `sign` adds the legal attestation and the late-entry flag. */
export function buildComposition(
  ctx: VisitContext,
  data: NoteData,
  author: ProfileResource,
  opts: { sign?: boolean; measures?: string } = {}
): Composition {
  const template = findTemplate(data.template);
  const now = new Date().toISOString();
  const content = { ...data, measuresSnapshot: opts.measures ?? data.measuresSnapshot };
  const extension = [
    { url: EXT.noteData, valueString: JSON.stringify(content) },
    ...(data.aiAssisted ? [{ url: EXT.aiAssisted, valueBoolean: true }] : []),
    ...(opts.sign && isLateEntry(ctx.encounter.period?.start, now) ? [{ url: EXT.lateEntry, valueBoolean: true }] : []),
  ];
  return {
    ...ctx.note,
    resourceType: 'Composition',
    status: opts.sign ? 'final' : 'preliminary',
    type: { coding: [{ system: CODE_SYSTEMS.noteTemplate, code: data.template, display: template?.label }], text: template?.label },
    subject: createReference(ctx.patient),
    encounter: createReference(ctx.encounter),
    date: now,
    author: [createReference(author)],
    title: `${template?.label ?? 'Visit note'} · ${formatDate((ctx.encounter.period?.start ?? now).slice(0, 10))}`,
    attester: opts.sign ? [{ mode: 'legal', time: now, party: createReference(author as Practitioner) }] : undefined,
    extension,
    section: noteSections(content),
  };
}

function updateEntry(resource: Resource): BundleEntry {
  return {
    resource,
    request: {
      method: 'PUT', url: `${resource.resourceType}/${resource.id}`,
      ...(resource.meta?.versionId ? { ifMatch: `W/"${resource.meta.versionId}"` } : {}),
    },
  };
}

async function completionEntries(medplum: MedplumClient, ctx: VisitContext): Promise<BundleEntry[]> {
  const encounter = await medplum.readResource('Encounter', ctx.encounter.id as string, { cache: 'no-cache' });
  if (!['in-progress', 'finished'].includes(encounter.status)) throw new Error('Only an in-progress or finished visit can be completed.');
  const appointment = encounter.appointment?.[0]
    ? await medplum.readReference(encounter.appointment[0], { cache: 'no-cache' }) as Appointment
    : undefined;
  const entries: BundleEntry[] = [];
  if (encounter.status !== 'finished') entries.push(updateEntry({ ...encounter, status: 'finished', period: { ...encounter.period, end: encounter.period?.end ?? new Date().toISOString() } }));
  if (appointment && ['arrived', 'checked-in', 'booked'].includes(appointment.status)) entries.push(updateEntry({ ...appointment, status: 'fulfilled' }));
  return entries;
}

async function commitVisit(medplum: MedplumClient, entries: BundleEntry[]): Promise<void> {
  if (!entries.length) return;
  if (!medplum.getProject()?.features?.includes('transaction-bundles')) throw new Error('Atomic visit completion is not enabled. Ask an administrator to enable transaction bundles, then sign in again.');
  const result = await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries });
  if (result.entry?.length !== entries.length || result.entry.some((e) => !/^2\d\d\b/.test(e.response?.status ?? ''))) {
    throw new Error('The visit transaction did not complete. Reload the note and retry.');
  }
}

/** Sign and complete the visit atomically. A conflict/failure rolls back every write. */
export async function signVisit(medplum: MedplumClient, ctx: VisitContext, data: NoteData, author: ProfileResource, measures?: string): Promise<void> {
  if (!ctx.note?.id) throw new Error('Save the draft before signing.');
  const medications = await medplum.searchResources('MedicationStatement', { subject: `Patient/${ctx.patient.id}`, status: 'active', _count: '200' }, { cache: 'no-cache' });
  const signedData = { ...data, medicationsSnapshot: medications.map((m) => `${m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? m.medicationReference?.display ?? 'Medication'}${m.dosage?.[0]?.text ? ` · ${m.dosage[0].text}` : ''}`) };
  await commitVisit(medplum, [updateEntry(buildComposition(ctx, signedData, author, { sign: true, measures })), ...await completionEntries(medplum, ctx)]);
}

/** Idempotent recovery for notes signed before atomic visit completion was introduced. */
export async function finishVisit(medplum: MedplumClient, ctx: VisitContext): Promise<void> {
  if (!ctx.note?.id) throw new Error('This visit has no signed note.');
  const note = await medplum.readResource('Composition', ctx.note.id, { cache: 'no-cache' });
  if (note.status !== 'final' || note.encounter?.reference !== `Encounter/${ctx.encounter.id}`) throw new Error('Complete the visit only after its note is signed.');
  await commitVisit(medplum, await completionEntries(medplum, ctx));
}

export function buildAmendment(ctx: VisitContext, author: ProfileResource, kind: 'appends' | 'replaces', text: string, reason: string): Composition {
  const now = new Date().toISOString();
  return {
    resourceType: 'Composition',
    status: 'final',
    type: ctx.note?.type ?? { text: 'Visit note' },
    subject: createReference(ctx.patient),
    encounter: createReference(ctx.encounter),
    date: now,
    author: [createReference(author)],
    title: `${kind === 'appends' ? 'Addendum' : 'Correction'} · ${formatDate(now.slice(0, 10))}`,
    attester: [{ mode: 'legal', time: now, party: createReference(author as Practitioner) }],
    relatesTo: [{ code: kind, targetReference: createReference(ctx.note as Composition) }],
    extension: [{ url: EXT.amendmentReason, valueString: reason }],
    section: [{ title: kind === 'appends' ? 'Addendum' : 'Correction', text: narrative(text) }],
  };
}

/** Notes for a set of encounters (for lists): id → { status, late, amended }. */
export async function noteStatuses(medplum: MedplumClient, encounterIds: string[]): Promise<Map<string, { status: 'draft' | 'signed' | 'amended'; late: boolean; noteId?: string }>> {
  const result = new Map<string, { status: 'draft' | 'signed' | 'amended'; late: boolean; noteId?: string }>();
  if (!encounterIds.length) return result;
  const bundle = await medplum.search('Composition', { encounter: encounterIds.map((i) => `Encounter/${i}`).join(','), _count: '500' }, { cache: 'no-cache' }).catch(() => undefined as Bundle | undefined);
  const notes = (bundle?.entry ?? []).map((e) => e.resource as Composition);
  for (const id of encounterIds) {
    const forEnc = notes.filter((n) => n.encounter?.reference === `Encounter/${id}`);
    const main = forEnc.find((n) => !n.relatesTo?.length);
    if (!main) continue;
    const amended = forEnc.some((n) => n.relatesTo?.length);
    result.set(id, {
      status: main.status === 'final' ? (amended ? 'amended' : 'signed') : 'draft',
      late: getExtensionValue(main, EXT.lateEntry) === true,
      noteId: main.id,
    });
  }
  return result;
}
