import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { MedplumClient } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { AUDIO_RATE, CODE_SYSTEMS, EXT, SEED_IDENTIFIER_SYSTEM, applyProposals, canProcess, emptyNote, fieldValue, findTemplate, noteSections, readWav, toQualification, validateScribeResult, validMeetUrl, wavBytes } from '@teleemon/core';
import type { ScribeProposal, ScribeResult, TranscriptSegment } from '@teleemon/core';
import { ScribeService, sessionData, updatedDocument } from '../services/scribe/src/service';
import { OpenAiAdapter } from '../services/scribe/src/openai';
import type { AiAdapter } from '../services/scribe/src/openai';
import { DraftSaver } from '../apps/staff/src/utils/DraftSaver';
import { retentionDue, runRetention } from '../services/scribe/src/retention';

const template = findTemplate('med-mgmt')!;
const proposal: ScribeProposal = { field: 'sections.plan', value: 'Arrange follow-up in two weeks.', evidence: ['block-0'], caution: '' };
const result: ScribeResult = { proposals: [proposal], warnings: ['Overall risk was not assessed.'], diagnosisSuggestions: [] };
const segments: TranscriptSegment[] = [{ id: 'block-0', start: 0, end: 10, speaker: 'Unknown', text: 'Let us follow up in two weeks.' }];
class Memory {
  rows = new Map<string, any>(); binaries = new Map<string, Uint8Array>(); profile: any; aiCalls = { transcription: 0, draft: 0 }; failDraft = false;
  client = this as unknown as MedplumClient;
  service: ScribeService;
  constructor() {
    this.profile = { resourceType: 'Practitioner', id: 'provider', qualification: [toQualification({ kind: 'state-license', state: 'WA', number: 'TEST', start: '2020-01-01', end: '2099-01-01' })] };
    this.put({ resourceType: 'Patient', id: 'patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: 'scribe-test' }] });
    this.put({ resourceType: 'Encounter', id: 'visit', status: 'in-progress', participant: [{ individual: { reference: 'Practitioner/provider' } }], subject: { reference: 'Patient/patient' }, extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }] });
    this.put({ resourceType: 'Consent', id: 'standing', status: 'active', patient: { reference: 'Patient/patient' }, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: 'recording' }] }] });
    const data = emptyNote(template, 'video');
    this.put({ resourceType: 'Composition', id: 'note', status: 'preliminary', subject: { reference: 'Patient/patient' }, encounter: { reference: 'Encounter/visit' }, extension: [{ url: EXT.noteData, valueString: JSON.stringify(data) }], section: noteSections(data) });
    const ai: AiAdapter = { transcribe: async () => { this.aiCalls.transcription++; return { text: segments[0].text, requestId: 'transcribe-test' }; }, draft: async () => { this.aiCalls.draft++; if (this.failDraft) throw new Error('provider unavailable'); return { result: structuredClone(result), inputTokens: 10, outputTokens: 5, requestId: 'draft-test' }; } };
    this.service = new ScribeService(ai, { OPENAI_API_KEY: 'synthetic-not-a-real-key' });
  }
  put(row: any): any { const key = `${row.resourceType}/${row.id}`; const value = { ...structuredClone(row), meta: { ...row.meta, versionId: String(Number(this.rows.get(key)?.meta?.versionId ?? 0) + 1) } }; this.rows.set(key, value); return structuredClone(value); }
  async getProfileAsync(): Promise<any> { return structuredClone(this.profile); }
  getProject(): any { return { features: ['transaction-bundles'] }; }
  async readResource(type: string, id: string): Promise<any> { const row = this.rows.get(`${type}/${id}`); if (!row) throw new Error('Not found'); return structuredClone(row); }
  async readReference(ref: any): Promise<any> { const [type, id] = ref.reference.split('/'); return this.readResource(type, id); }
  async searchResources(type: string, query: any): Promise<any[]> {
    return [...this.rows.values()].filter((r) => r.resourceType === type && (!query.status || r.status === query.status) && (!query.patient || r.patient?.reference === query.patient) && (!query.encounter || r.encounter?.reference === query.encounter || r.context?.encounter?.some((e: any) => e.reference === query.encounter))).map((r) => structuredClone(r));
  }
  async searchOne(type: string, query: any): Promise<any> { return (await this.searchResources(type, query))[0]; }
  async createResource(row: any): Promise<any> { return this.put({ ...row, id: randomUUID() }); }
  async updateResource(row: any, opts?: any): Promise<any> { const expected = opts?.headers?.['If-Match']; if (expected && expected !== `W/"${this.rows.get(`${row.resourceType}/${row.id}`)?.meta?.versionId}"`) throw new Error('Version conflict'); return this.put(row); }
  async createBinary(opts: any): Promise<any> { const row = await this.createResource({ resourceType: 'Binary', contentType: opts.contentType, securityContext: opts.securityContext }); this.binaries.set(row.id, new Uint8Array(await opts.data.arrayBuffer())); return row; }
  fhirUrl(type: string, id: string): string { return `${type}/${id}`; }
  async download(url: string): Promise<Blob> { return new Blob([new Uint8Array(this.binaries.get(url.split('/')[1])!)]); }
  async executeBatch(bundle: any): Promise<any> { for (const entry of bundle.entry) { if (entry.request.method === 'PUT') await this.updateResource(entry.resource, { headers: { 'If-Match': entry.request.ifMatch } }); else await this.createResource(entry.resource); } return { entry: bundle.entry.map(() => ({ response: { status: '200 OK' } })) }; }
  async create(): Promise<DocumentReference> { return this.service.create(this.client, 'visit', { consent: true }); }
  async recorded(): Promise<DocumentReference> { const doc = await this.create(); await this.service.upload(this.client, doc.id!, 0, wavBytes(new Int16Array(AUDIO_RATE))); return this.service.state(this.client, doc.id!, 'stopped', 1); }
}

test('WAV round-trip preserves mono PCM and rejects malformed audio', () => {
  const samples = new Int16Array([-32768, -1, 0, 1, 32767]); const bytes = wavBytes(samples); assert.deepEqual(readWav(bytes), samples);
  bytes[24] = 0; assert.throws(() => readWav(bytes), /PCM16/); assert.throws(() => readWav(new Uint8Array(4)), /size/);
});
test('audio worklet is silent before start and flushes bounded PCM on pause and stop', () => {
  let Worklet: any; const messages: any[] = [];
  runInNewContext(readFileSync(new URL('../apps/staff/src/scribe/pcm.worklet.js', import.meta.url), 'utf8'), { AudioWorkletProcessor: class { port = { onmessage: undefined, postMessage: (v: any) => messages.push(v) }; }, sampleRate: 16000, registerProcessor: (_name: string, ctor: any) => { Worklet = ctor; } });
  const worklet = new Worklet(); const frame = [[new Float32Array(128).fill(0.5)]];
  worklet.process(frame); assert.equal(worklet.count, 0); assert.equal(messages.length, 0);
  worklet.port.onmessage({ data: 'resume' }); worklet.process(frame); worklet.port.onmessage({ data: 'pause' });
  assert.equal(messages.length, 1); assert.equal(new Int16Array(messages[0].pcm).length, 128);
  worklet.process(frame); assert.equal(worklet.count, 0);
  worklet.port.onmessage({ data: 'resume' }); worklet.process(frame); worklet.port.onmessage({ data: 'stop' }); assert.equal(messages.length, 3); assert.equal(messages[2].stopped, true);
});
test('Meet links exclude foreign origins, credentials, queries and lookalike hosts', () => {
  assert.equal(validMeetUrl('https://meet.google.com/abc-defg-hij'), true);
  for (const url of ['https://meet.google.com.evil.test/abc-defg-hij', 'https://user:secret@meet.google.com/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij?patient=123', 'javascript:alert(1)']) assert.equal(validMeetUrl(url), false);
});
test('evidence and field validation rejects hallucinated citations and unsafe automatic fields', () => {
  assert.deepEqual(validateScribeResult(result, segments, template), result);
  assert.throws(() => validateScribeResult({ ...result, proposals: [{ ...proposal, evidence: ['invented'] }] }, segments, template), /evidence/);
  for (const field of ['billing.primaryCode', 'risk.level', 'risk.safetyPlanReviewed', 'medsReviewed', 'privateNotes', 'mse.appearance']) assert.throws(() => validateScribeResult({ ...result, proposals: [{ ...proposal, field }] }, segments, template), /field/);
  assert.throws(() => validateScribeResult({ ...result, proposals: [proposal, proposal] }, segments, template), /Duplicate/);
});
test('field application preserves provider text unless replacement is explicitly reviewed', () => {
  const note = emptyNote(template); note.sections.plan = 'Provider plan'; note.privateNotes = 'Private';
  assert.throws(() => applyProposals(note, [proposal], template), /already has content/);
  const next = applyProposals(note, [proposal], template, true); assert.equal(next.sections.plan, proposal.value); assert.equal(note.sections.plan, 'Provider plan'); assert.equal(next.privateNotes, 'Private'); assert.equal(next.medsReviewed, false); assert.deepEqual(next.billing, note.billing); assert.deepEqual(next.diagnoses, []); assert.equal(next.aiAssisted, true);
});
test('risk enums and selected template boundaries are validated', () => {
  assert.throws(() => applyProposals(emptyNote(template), [{ ...proposal, field: 'risk.suicidalIdeation', value: 'normal' }], template), /risk value/);
  assert.throws(() => applyProposals(emptyNote(findTemplate('brief')!), [{ ...proposal, field: 'sections.chiefComplaint' }], findTemplate('brief')!), /template/);
  assert.equal(fieldValue(emptyNote(template), 'risk.notes'), '');
});
test('recording requires per-session consent, standing consent and provider identity', async () => {
  const m = new Memory(); await assert.rejects(m.service.create(m.client, 'visit', { consent: false }), /Confirm/);
  m.profile.id = 'someone-else'; await assert.rejects(m.create(), /provider/); m.profile.id = 'provider';
  m.rows.get('Consent/standing').status = 'inactive'; await assert.rejects(m.create(), /Standing/); assert.equal(m.aiCalls.transcription, 0);
});
test('real patients are refused by default and unlicensed locations block recording', async () => {
  const m = new Memory(); m.rows.get('Patient/patient').identifier = [];
  await assert.rejects(m.create(), /synthetic/); m.rows.get('Patient/patient').identifier = [{ system: SEED_IDENTIFIER_SYSTEM }];
  m.rows.get('Encounter/visit').extension[0].valueCode = 'TX'; await assert.rejects(m.create(), /licence/);
});
test('no paid AI calls occur during recording or pause; incomplete stop is refused', async () => {
  const m = new Memory(); const d = await m.create();
  await assert.rejects(m.service.process(m.client, d.id!), /Stop recording/);
  await m.service.state(m.client, d.id!, 'paused'); await assert.rejects(m.service.process(m.client, d.id!), /Stop recording/);
  await assert.rejects(m.service.state(m.client, d.id!, 'stopped', 1), /uploaded/); assert.deepEqual(m.aiCalls, { transcription: 0, draft: 0 });
});
test('audio chunks are sequenced, retries match hashes, and binaries use clinical security context', async () => {
  const m = new Memory(); const d = await m.create(); const audio = wavBytes(new Int16Array(AUDIO_RATE));
  await assert.rejects(m.service.upload(m.client, d.id!, 1, audio), /sequence/);
  await m.service.upload(m.client, d.id!, 0, audio); await m.service.upload(m.client, d.id!, 0, audio);
  assert.equal(m.binaries.size, 1); const binary = [...m.rows.values()].find((r) => r.resourceType === 'Binary'); assert.equal(binary.securityContext.reference, `DocumentReference/${d.id}`);
  const changed = audio.slice(); changed[45] = 1; await assert.rejects(m.service.upload(m.client, d.id!, 0, changed), /does not match/);
});
test('after-stop processing persists transcript and evidence-linked proposals without editing the note', async () => {
  const m = new Memory(); const d = await m.recorded(); assert.equal(canProcess(sessionData(d)), true);
  const ready = sessionData(await m.service.process(m.client, d.id!)); assert.equal(ready.state, 'ready'); assert.equal(ready.transcript[0].speaker, 'Unknown'); assert.deepEqual(m.aiCalls, { transcription: 1, draft: 1 });
  assert.equal(JSON.parse(m.rows.get('Composition/note').extension[0].valueString).sections.plan, undefined);
  await m.service.process(m.client, d.id!); assert.equal(m.aiCalls.transcription, 1);
});
test('draft failure retries reuse acknowledged transcript blocks', async () => {
  const m = new Memory(); const d = await m.recorded(); m.failDraft = true; await assert.rejects(m.service.process(m.client, d.id!));
  assert.equal(sessionData(await m.readResource('DocumentReference', d.id!)).state, 'failed'); m.failDraft = false;
  await m.service.process(m.client, d.id!); assert.deepEqual(m.aiCalls, { transcription: 1, draft: 2 });
});
test('withdrawal prevents upload, generation and field application', async () => {
  const m = new Memory(); const d = await m.recorded(); await m.service.state(m.client, d.id!, 'cancelled');
  await assert.rejects(m.service.process(m.client, d.id!), /consent/); assert.equal(m.aiCalls.transcription, 0);
});
test('revoked standing consent is checked again before processing', async () => {
  const m = new Memory(); const d = await m.recorded(); m.rows.get('Consent/standing').status = 'inactive'; await assert.rejects(m.service.process(m.client, d.id!), /Standing/); assert.equal(m.aiCalls.transcription, 0);
});
test('cross-patient session payloads and unauthorized readers fail closed', async () => {
  const m = new Memory(); const d = await m.create(); const s = sessionData(d); s.patientId = 'other'; m.put(updatedDocument(d, s)); await assert.rejects(m.service.load(m.client, d.id!), /identity/);
});
test('apply rejects stale versions and signed notes; successful apply writes provenance', async () => {
  const m = new Memory(); const d = await m.recorded(); await m.service.process(m.client, d.id!);
  const n = m.rows.get('Composition/note'); const opts = { fields: ['sections.plan'], replace: false, noteId: 'note', version: n.meta.versionId };
  await assert.rejects(m.service.apply(m.client, d.id!, { ...opts, version: 'stale' }), /note changed/);
  const applied = await m.service.apply(m.client, d.id!, opts); assert.equal(JSON.parse(applied.extension![0].valueString!).sections.plan, proposal.value); assert.equal([...m.rows.values()].filter((r) => r.resourceType === 'Provenance').length, 1);
  m.rows.get('Composition/note').status = 'final'; await assert.rejects(m.service.apply(m.client, d.id!, opts), /unsigned/);
});
test('concurrent operations on one session are refused while a different session can proceed', async () => {
  const m = new Memory(); let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = m.service.exclusive('one', () => gate); await assert.rejects(m.service.exclusive('one', async () => 1), /busy/); assert.equal(await m.service.exclusive('two', async () => 2), 2); finish(); await first;
});
test('draft saver adopts external results only after edits have reached storage', async () => {
  const saver = new DraftSaver<string, string>(async (v) => v, 'original'); saver.initialize('original'); saver.change('provider edit');
  assert.throws(() => saver.adopt('AI', 'v2'), /pending/); await saver.flush(); saver.adopt('reviewed AI', 'v3'); saver.change('next edit'); assert.equal(await saver.flush(), 'next edit');
});
test('OpenAI adapter sends files after capture and uses store:false plus strict schema', async () => {
  const calls: { path: string; body: any }[] = [];
  const ai = new OpenAiAdapter((async (url, init) => { const path = String(url); calls.push({ path, body: init!.body }); return new Response(JSON.stringify(path.endsWith('transcriptions') ? { text: 'Synthetic text' } : { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'x-request-id': 'test' } }); }) as typeof fetch);
  await ai.transcribe(wavBytes(new Int16Array(160)), 'test-key'); await ai.draft(segments, template, '', 'test-key');
  assert(calls[0].body instanceof FormData); const body = JSON.parse(calls[1].body); assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(body.stream, undefined);
});

test('retention honors legal holds, signing-based deadlines and unsigned session limits', async () => {
  const m = new Memory(); const s = sessionData(await m.recorded()); const future = new Date(Date.now() + 40 * 86400000);
  assert.equal(retentionDue(s, undefined, future), true); s.legalHold = true; assert.equal(retentionDue(s, undefined, future), false);
  s.legalHold = false; assert.equal(retentionDue(s, new Date(future.getTime() - 6 * 86400000).toISOString(), future), false);
  assert.equal(retentionDue(s, new Date(future.getTime() - 8 * 86400000).toISOString(), future), true);
  s.audioDeletedAt = future.toISOString(); assert.equal(retentionDue(s, undefined, future), false);
});

test('retention dry-run does not delete; apply is restart-safe and leaves transcript intact', async () => {
  const m = new Memory(); const d = await m.recorded(); const future = new Date(Date.now() + 40 * 86400000);
  (m as any).searchResourcePages = async function* () { yield [await m.readResource('DocumentReference', d.id!)]; };
  let deletes = 0; (m as any).deleteResource = async (type: string, id: string) => { deletes++; m.rows.delete(`${type}/${id}`); m.binaries.delete(id); };
  assert.equal((await runRetention(m.client, false, future)).due, 1); assert.equal(deletes, 0);
  assert.equal((await runRetention(m.client, true, future)).deleted, 1); assert.equal(deletes, 1);
  assert.equal((await runRetention(m.client, true, future)).deleted, 0); assert(m.rows.has(`DocumentReference/${d.id}`));
});
