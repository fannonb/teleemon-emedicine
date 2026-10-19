import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Bundle, Composition, Encounter, Practitioner } from '@medplum/fhirtypes';
import type { NoteData } from '@teleemon/core';
import { EXT, noteSections } from '@teleemon/core';
import { handler } from '../bots/src/note-rules';
import { DraftSaver } from '../apps/staff/src/utils/DraftSaver';
import { buildComposition, finishVisit, noteData, signVisit } from '../apps/staff/src/fhir/visits';
import type { VisitContext } from '../apps/staff/src/fhir/visits';

const provider: Practitioner = { resourceType: 'Practitioner', id: 'provider' };
const encounter: Encounter = { resourceType: 'Encounter', id: 'visit', meta: { versionId: '2' }, status: 'in-progress', class: { code: 'VR' }, subject: { reference: 'Patient/patient' }, participant: [{ individual: { reference: 'Practitioner/provider' } }], appointment: [{ reference: 'Appointment/appointment' }], period: { start: new Date().toISOString() } };
const appointment: Appointment = { resourceType: 'Appointment', id: 'appointment', meta: { versionId: '4' }, status: 'checked-in', participant: [] };
const data: NoteData = { template: 'telephone', sections: { assessment: 'Stable.', plan: 'Continue care.' }, mse: {}, risk: { suicidalIdeation: 'denied', level: 'low' }, diagnoses: [{ code: 'F41.1', display: 'Generalized anxiety disorder' }], billing: { emMethod: 'mdm', modifiers: [] }, medsReviewed: true, measuresSnapshot: 'PHQ-9 6', privateNotes: 'DO-NOT-EXPORT' };
const makeNote = (): Composition => ({ resourceType: 'Composition', id: 'note', meta: { author: { reference: 'Practitioner/provider' }, versionId: '1' }, status: 'final', type: {}, title: 'Telephone note', date: new Date().toISOString(), subject: { reference: 'Patient/patient' }, encounter: { reference: 'Encounter/visit' }, author: [{ reference: 'Practitioner/provider' }], attester: [{ mode: 'legal', time: '2000-01-01T00:00:00Z', party: { reference: 'Practitioner/provider' } }], extension: [{ url: EXT.noteData, valueString: JSON.stringify(data) }], section: noteSections(data) });
const event = (input: Composition): BotEvent<Composition> => ({ input, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {} });
const client = (methods: object): MedplumClient => ({ getProject: () => ({ features: ['transaction-bundles'] }), searchResources: async () => [], ...methods }) as unknown as MedplumClient;
const validationClient = (target = makeNote(), previous?: Composition): MedplumClient => client({ readResource: async () => previous, readReference: async (r: { reference?: string }) => r.reference?.startsWith('Encounter/') ? encounter : target });

test('signing requires the trusted server author to be the named provider', async () => {
  const note = makeNote();
  note.meta!.author = { reference: 'Practitioner/admin' };
  await assert.rejects(handler(validationClient(), { ...event(note), requester: { reference: 'Practitioner/provider' } }), /Only the visit's provider/);
  delete note.meta!.author;
  await assert.rejects(handler(validationClient(), event(note)), /Only the visit's provider/);
});

test('exactly one legal attester is required and server timestamps replace caller timestamps', async () => {
  const note = makeNote();
  const signed = await handler(validationClient(), event(note)) as Composition;
  assert.notEqual(signed.attester?.[0].time, note.attester?.[0].time);
  assert.ok(Date.now() - Date.parse(signed.attester![0].time!) < 5000);
  note.attester!.push(note.attester![0]);
  await assert.rejects(handler(validationClient(), event(note)), /legal attestation/);
});

test('signed narrative must match canonical structured content, including measures', async () => {
  const note = makeNote();
  assert.equal((await handler(validationClient(), event(note)) as Composition).status, 'final');
  note.section = [{ title: 'Plan', text: { status: 'generated', div: '<div>Different content with no diagnosis</div>' } }];
  await assert.rejects(handler(validationClient(), event(note)), /narrative must match/);
  assert.ok(!JSON.stringify(noteSections(data)).includes('DO-NOT-EXPORT'));
});

test('amended status cannot bypass signing and a final note cannot be edited or deleted', async () => {
  await assert.rejects(handler(validationClient(), event({ ...makeNote(), status: 'amended', extension: [], attester: [] })), /draft or a final note/);
  await assert.rejects(handler(validationClient(makeNote(), makeNote()), event(makeNote())), /signed and locked/);
  await assert.rejects(handler(validationClient(makeNote(), makeNote()), { ...event(makeNote()), headers: { 'X-Medplum-Deleted-Resource': 'Composition/note' } }), /cannot be deleted/);
});

test('amendments cannot cross patient or visit boundaries or target other amendments', async () => {
  const amendment: Composition = { ...makeNote(), relatesTo: [{ code: 'appends', targetReference: { reference: 'Composition/original' } }], extension: [{ url: EXT.amendmentReason, valueString: 'Additional information' }], section: [{ title: 'Addendum', text: { status: 'generated', div: '<div>Additional information.</div>' } }] };
  for (const target of [{ ...makeNote(), subject: { reference: 'Patient/other' } }, { ...makeNote(), encounter: { reference: 'Encounter/other' } }, { ...makeNote(), relatesTo: amendment.relatesTo }]) {
    await assert.rejects(handler(validationClient(target), event(amendment)), /same patient and visit/);
  }
  assert.equal((await handler(validationClient(), event(amendment)) as Composition).status, 'final');
  await assert.rejects(handler(validationClient(), event({ ...makeNote(), subject: { reference: 'Patient/other' } })), /patient must match/);
});

test('failure to read the previous note fails closed', async () => {
  await assert.rejects(handler(client({ readResource: async () => { throw new Error('storage unavailable'); } }), event(makeNote())), /storage unavailable/);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('draft saves serialize, retain edits typed during a request and let review await the latest write', async () => {
  const first = deferred<{ id: string }>();
  const writes: { value: string; previous?: { id: string } }[] = [];
  const saver = new DraftSaver<string, { id: string }>(async (value, previous) => {
    writes.push({ value, previous });
    return writes.length === 1 ? first.promise : { id: 'note' };
  });
  saver.initialize('initial');
  saver.change('first edit');
  const saving = saver.flush();
  saver.change('new edit while saving');
  const review = saver.flush();
  assert.equal(review, saving);
  first.resolve({ id: 'note' });
  await review;
  assert.deepEqual(writes, [{ value: 'first edit', previous: undefined }, { value: 'new edit while saving', previous: { id: 'note' } }]);
  assert.equal(saver.dirty, false);
});

test('a failed draft save remains dirty and can be retried without losing its content', async () => {
  let attempts = 0;
  const saver = new DraftSaver<string, string>(async (value) => { if (++attempts === 1) throw new Error('offline'); return value; }, 'existing');
  saver.initialize('original'); saver.change('latest');
  await assert.rejects(saver.flush(), /offline/);
  assert.equal(saver.dirty, true);
  assert.equal(await saver.flush(), 'latest');
  assert.equal(saver.dirty, false);
});

const ctx: VisitContext = { encounter, appointment, patient: { resourceType: 'Patient', id: 'patient' }, note: { ...makeNote(), status: 'preliminary' }, amendments: [] };
test('review and signing retain the measures snapshot without duplicating comments', () => {
  const withMeasures: NoteData = { ...data, template: 'med-mgmt', sections: { ...data.sections, measures: 'Patient comment' } };
  const draft = buildComposition(ctx, withMeasures, provider, { measures: 'PHQ-9 6' });
  const signed = buildComposition({ ...ctx, note: draft }, noteData(draft)!, provider, { sign: true });
  assert.deepEqual(signed.section, draft.section);
  assert.equal(signed.section?.find(s => s.title === 'Measures')?.text?.div.match(/Patient comment/g)?.length, 1);
});

test('signing commits note, encounter and appointment in one version-checked transaction', async () => {
  let committed: Bundle | undefined;
  await signVisit(client({ readResource: async () => encounter, readReference: async () => appointment, executeBatch: async (b: Bundle) => { committed = b; return { entry: b.entry?.map(() => ({ response: { status: '200 OK' } })) }; } }), ctx, data, provider);
  assert.equal(committed?.type, 'transaction');
  assert.deepEqual(committed?.entry?.map(e => e.resource?.resourceType), ['Composition', 'Encounter', 'Appointment']);
  assert.deepEqual(committed?.entry?.map(e => e.request?.ifMatch), ['W/"1"', 'W/"2"', 'W/"4"']);
  assert.equal((committed?.entry?.[2].resource as Appointment).status, 'fulfilled');
});

test('signing freezes medication text so later chart edits cannot change the visit snapshot', async () => {
  let committed: Bundle | undefined;
  const medications = [{ resourceType: 'MedicationStatement', medicationCodeableConcept: { text: 'Synthetic medicine' }, dosage: [{ text: 'Test dose' }] }];
  await signVisit(client({ searchResources: async () => medications, readResource: async () => encounter, readReference: async () => appointment, executeBatch: async (b: Bundle) => { committed = b; return { entry: b.entry?.map(() => ({ response: { status: '200 OK' } })) }; } }), ctx, data, provider);
  medications[0].medicationCodeableConcept.text = 'Changed later';
  assert.deepEqual(noteData(committed?.entry?.[0].resource as Composition)?.medicationsSnapshot, ['Synthetic medicine · Test dose']);
});

test('transaction failures surface and legacy completion retries are idempotent', async () => {
  await assert.rejects(signVisit(client({ readResource: async () => encounter, readReference: async () => appointment, executeBatch: async () => { throw new Error('conflict'); } }), ctx, data, provider), /conflict/);
  let writes = 0;
  await finishVisit(client({ readResource: async (type: string) => type === 'Composition' ? makeNote() : { ...encounter, status: 'finished' }, readReference: async () => ({ ...appointment, status: 'fulfilled' }), executeBatch: async () => { writes++; } }), ctx);
  assert.equal(writes, 0);
});

test('signing refuses to write when the project lacks real transaction support', async () => {
  let writes = 0;
  await assert.rejects(signVisit(client({ getProject: () => ({ features: [] }), readResource: async () => encounter, readReference: async () => appointment, executeBatch: async () => { writes++; } }), ctx, data, provider), /Atomic visit completion is not enabled/);
  assert.equal(writes, 0);
});

test('legacy completion reports failure, then retries only encounter and appointment writes', async () => {
  let attempts = 0;
  const m = client({
    readResource: async (type: string) => type === 'Composition' ? makeNote() : encounter,
    readReference: async () => appointment,
    executeBatch: async (b: Bundle) => {
      assert.deepEqual(b.entry?.map(e => e.resource?.resourceType), ['Encounter', 'Appointment']);
      if (++attempts === 1) throw new Error('temporarily unavailable');
      return { entry: b.entry?.map(() => ({ response: { status: '200' } })) };
    },
  });
  await assert.rejects(finishVisit(m, ctx), /temporarily unavailable/);
  await finishVisit(m, ctx);
  assert.equal(attempts, 2);
});
