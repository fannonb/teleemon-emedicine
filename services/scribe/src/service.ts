import { createHash, randomUUID } from 'node:crypto';
import { MedplumClient, createReference, getExtensionValue } from '@medplum/core';
import type { Composition, Consent, DocumentReference, Encounter, Patient, Practitioner } from '@medplum/fhirtypes';
import { AUDIO_RATE, CODE_SYSTEMS, EXT, MAX_AUDIO_SECONDS, SCRIBE_DATA, SCRIBE_SYSTEM, SEED_IDENTIFIER_SYSTEM, applyProposals, assertApplyVersion, canProcess, checkLicensure, findDiagnosis, findTemplate, noteSections, readWav, validMeetUrl, wavBytes, zonedDate } from '@teleemon/core';
import type { NoteData, ScribeSession } from '@teleemon/core';
import type { AiAdapter } from './openai';

export class ScribeError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
const fail = (message: string, status = 400): never => { throw new ScribeError(message, status); };
const fresh = { cache: 'no-cache' } as const;
export const sessionData = (doc: DocumentReference): ScribeSession => {
  const raw = getExtensionValue(doc, SCRIBE_DATA);
  if (typeof raw !== 'string') return fail('Not a scribe session');
  const value = JSON.parse(raw) as ScribeSession;
  if (value.schema !== '1' || doc.context?.encounter?.[0]?.reference !== `Encounter/${value.encounterId}` || doc.subject?.reference !== `Patient/${value.patientId}`) return fail('Invalid session identity');
  if (!findTemplate(value.template) || !Array.isArray(value.chunks) || value.chunks.length > 5000 || value.chunks.some((c, index) => c.sequence !== index || !Number.isSafeInteger(c.samples) || c.samples < 1 || c.samples > AUDIO_RATE * 15 || !/^[a-zA-Z0-9-]+$/.test(c.binaryId) || !/^[a-f0-9]{64}$/.test(c.digest)) || value.chunks.reduce((sum, c) => sum + c.samples, 0) > MAX_AUDIO_SECONDS * AUDIO_RATE || !Array.isArray(value.transcript) || !Array.isArray(value.applied) || !value.usage || typeof value.instructions !== 'string' || value.instructions.length > 4000 || typeof value.legalHold !== 'boolean' || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.retainUntil))) return fail('Invalid stored session. Do not modify scribe session payloads directly.');
  return value;
};
export function updatedDocument(doc: DocumentReference, value: ScribeSession): DocumentReference {
  return { ...doc, extension: [...(doc.extension ?? []).filter((e) => e.url !== SCRIBE_DATA), { url: SCRIBE_DATA, valueString: JSON.stringify(value) }] };
}
export async function saveSession(m: MedplumClient, doc: DocumentReference, value: ScribeSession): Promise<DocumentReference> {
  return m.updateResource(updatedDocument(doc, value), { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } });
}

export class ScribeService {
  // Per-resource serialization plus FHIR If-Match protects retries and multiple instances.
  private readonly busy = new Set<string>();
  constructor(private readonly ai: AiAdapter, private readonly env: NodeJS.ProcessEnv = process.env) {}
  async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) return fail('Session is busy. Wait for the current operation.', 409);
    this.busy.add(id); try { return await run(); } finally { this.busy.delete(id); }
  }
  async authorize(m: MedplumClient, encounterId: string, recording = false): Promise<{ encounter: Encounter; patient: Patient; provider: string; standing?: Consent }> {
    const profile = await m.getProfileAsync();
    const provider = profile ? `${profile.resourceType}/${profile.id}` : '';
    if (profile?.resourceType !== 'Practitioner') return fail('Only the encounter provider can use the scribe.', 403);
    const encounter = await m.readResource('Encounter', encounterId, fresh);
    if (!encounter.participant?.some((p) => p.individual?.reference === provider)) return fail('Only the encounter provider can use the scribe.', 403);
    // Probe clinical access as well as encounter access (front desk can read encounters).
    const notes = await m.searchResources('Composition', { encounter: `Encounter/${encounterId}`, _count: '100' }, fresh);
    if (recording && (encounter.status !== 'in-progress' || notes.some((n) => n.status !== 'preliminary'))) return fail('Recording and generation require an unsigned, in-progress encounter.', 409);
    const patient = await m.readReference(encounter.subject as { reference: string }, fresh) as Patient;
    if (this.env.SCRIBE_ALLOW_PHI !== 'true' && !patient.identifier?.some((i) => i.system === SEED_IDENTIFIER_SYSTEM)) return fail('Scribe is restricted to synthetic patients until clinical configuration is approved.', 403);
    if (this.env.SCRIBE_ALLOW_PHI === 'true' && this.env.SCRIBE_CLINICAL_APPROVED !== 'true') return fail('Clinical vendor, retention and privacy configuration has not been approved.', 503);
    if (recording) {
      const state = getExtensionValue(encounter, EXT.patientLocationState) as string;
      const licence = checkLicensure(profile as Practitioner, state, zonedDate(new Date()));
      if (!state || !licence.ok) return fail('Patient location and provider licence must be valid before recording.', 403);
      const standing = (await m.searchResources('Consent', { patient: `Patient/${patient.id}`, status: 'active', _count: '200' }, fresh)).find((c) => this.consentCurrent(c) && c.category?.some((cat) => cat.coding?.some((coding) => coding.system === CODE_SYSTEMS.consentType && coding.code === 'recording')));
      if (!standing) return fail('Standing recording and AI scribe consent is required.', 403);
      return { encounter, patient, provider, standing };
    }
    return { encounter, patient, provider };
  }
  private consentCurrent(c: Consent): boolean { const p = c.provision?.period; const now = Date.now(); return c.status === 'active' && c.provision?.type !== 'deny' && (!p?.start || Date.parse(p.start) <= now) && (!p?.end || Date.parse(p.end) >= now); }
  private async checkConsent(m: MedplumClient, s: ScribeSession): Promise<void> {
    if (Date.parse(s.expiresAt) < Date.now()) return fail('Recording authorization expired. Start a new session.', 403);
    const c = await m.readResource('Consent', s.consentId, fresh);
    if (!this.consentCurrent(c) || c.patient?.reference !== `Patient/${s.patientId}` || !c.category?.some((cat) => cat.coding?.some((code) => code.system === CODE_SYSTEMS.consentType && code.code === 'recording-session')) || !c.provision?.data?.some((d) => d.reference.reference === `Encounter/${s.encounterId}`)) return fail('Session recording consent is no longer active.', 403);
    const standing = await m.readResource('Consent', s.standingConsentId, fresh);
    if (!this.consentCurrent(standing) || standing.patient?.reference !== `Patient/${s.patientId}` || !standing.category?.some((cat) => cat.coding?.some((code) => code.system === CODE_SYSTEMS.consentType && code.code === 'recording'))) return fail('Standing recording consent is no longer active.', 403);
  }
  async audit(m: MedplumClient, doc: DocumentReference, action: string): Promise<void> {
    await m.createResource({ resourceType: 'AuditEvent', type: { system: SCRIBE_SYSTEM, code: 'scribe' }, action: 'E', recorded: new Date().toISOString(), outcome: '0', agent: [{ requestor: true, who: createReference((await m.getProfileAsync())!) }], source: { observer: { display: 'Teleemon scribe' } }, entity: [{ what: createReference(doc), detail: [{ type: 'action', valueString: action }] }] });
  }
  async create(m: MedplumClient, encounterId: string, input: { consent: boolean; instructions?: string; meetingUrl?: string }): Promise<DocumentReference> {
    if (input.consent !== true) return fail('Confirm this session’s verbal recording consent before starting.');
    const { patient, provider, standing } = await this.authorize(m, encounterId, true);
    if (input.meetingUrl && !validMeetUrl(input.meetingUrl)) return fail('Use a Google Meet link without query parameters.');
    if (typeof input.instructions !== 'undefined' && (typeof input.instructions !== 'string' || input.instructions.length > 4000)) return fail('Template instructions must be at most 4,000 characters.');
    const active = await m.searchResources('DocumentReference', { encounter: `Encounter/${encounterId}`, type: `${SCRIBE_SYSTEM}|session`, _count: '100' }, fresh);
    if (active.some((d) => ['recording', 'paused', 'transcribing', 'drafting'].includes(sessionData(d).state))) return fail('Finish or discard the existing session before starting another.', 409);
    const encounter = await m.readResource('Encounter', encounterId, fresh);
    const visitCode = encounter.type?.[0]?.coding?.[0];
    const { templateForVisitType } = await import('@teleemon/core');
    const template = visitCode?.system === CODE_SYSTEMS.noteTemplate ? findTemplate(visitCode.code) : templateForVisitType(visitCode?.code);
    if (!template) return fail('Unknown encounter template');
    const consent = await m.createResource<Consent>({ resourceType: 'Consent', status: 'active', scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] }, policyRule: { text: 'Verbal authorization for recording and AI-assisted documentation for this encounter only' }, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: 'recording-session' }] }], patient: createReference(patient), dateTime: new Date().toISOString(), performer: [{ reference: provider }], extension: [{ url: EXT.consentMethod, valueCode: 'verbal-recorded' }], provision: { type: 'permit', data: [{ meaning: 'instance', reference: { reference: `Encounter/${encounterId}` } }] } });
    const now = Date.now();
    const session: ScribeSession = { schema: '1', encounterId, patientId: patient.id!, provider, consentId: consent.id!, standingConsentId: standing!.id!, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 4 * 3600000).toISOString(), retainUntil: new Date(now + 30 * 86400000).toISOString(), state: 'recording', template: template.code, instructions: input.instructions ?? '', meetingUrl: input.meetingUrl, chunks: [], transcript: [], legalHold: false, applied: [], usage: { audioSeconds: 0, inputTokens: 0, outputTokens: 0, transcriptionRequests: [] } };
    const doc = await m.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', type: { coding: [{ system: SCRIBE_SYSTEM, code: 'session' }] }, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'transcript' }] }], subject: createReference(patient), author: [{ reference: provider }], context: { encounter: [{ reference: `Encounter/${encounterId}` }] }, date: session.createdAt, description: 'Encounter recording and AI draft', extension: [{ url: SCRIBE_DATA, valueString: JSON.stringify(session) }], content: [{ attachment: { contentType: 'application/json', title: 'Scribe session' } }] });
    await this.audit(m, doc, 'consent-confirmed; session-started'); return doc;
  }
  async load(m: MedplumClient, id: string, recording = false): Promise<{ doc: DocumentReference; session: ScribeSession }> {
    const doc = await m.readResource('DocumentReference', id, fresh); const session = sessionData(doc);
    const { provider } = await this.authorize(m, session.encounterId, recording);
    if (session.provider !== provider) return fail('Session belongs to another provider.', 403);
    return { doc, session };
  }
  async withdraw(m: MedplumClient, id: string): Promise<void> {
    const { doc, session } = await this.load(m, id);
    const consent = await m.readResource('Consent', session.consentId, fresh);
    await m.updateResource({ ...consent, status: 'inactive' });
    // Consent is authoritative and can be withdrawn even while a processing lease is held.
    session.state = 'cancelled';
    await saveSession(m, doc, session).catch(() => undefined);
    await this.audit(m, doc, 'consent-withdrawn');
  }
  async upload(m: MedplumClient, id: string, sequence: number, bytes: Uint8Array): Promise<DocumentReference> {
    const { doc, session: s } = await this.load(m, id, true); await this.checkConsent(m, s);
    if (!['recording', 'paused'].includes(s.state)) return fail('Recording has already stopped.', 409);
    const samples = readWav(bytes); const digest = createHash('sha256').update(bytes).digest('hex');
    if (!Number.isSafeInteger(sequence) || sequence < 0) return fail('Invalid chunk sequence');
    const existing = s.chunks[sequence];
    if (existing) { if (existing.digest !== digest) return fail('Chunk retry does not match stored audio.', 409); return doc; }
    if (sequence !== s.chunks.length) return fail('Upload chunks in sequence; retry missing audio first.', 409);
    if (s.chunks.reduce((n, c) => n + c.samples, 0) + samples.length > MAX_AUDIO_SECONDS * AUDIO_RATE) return fail('Maximum recording duration reached.');
    const binary = await m.createBinary({ data: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), contentType: 'audio/wav', filename: `${id}-${sequence}.wav`, securityContext: createReference(doc) });
    s.chunks.push({ sequence, binaryId: binary.id, digest, samples: samples.length });
    const saved = await saveSession(m, doc, s); return saved;
  }
  async state(m: MedplumClient, id: string, state: 'paused' | 'recording' | 'stopped' | 'cancelled', expectedChunks?: number): Promise<DocumentReference> {
    const { doc, session: s } = await this.load(m, id, state !== 'cancelled');
    if (state !== 'cancelled') await this.checkConsent(m, s);
    if (s.state === state) return doc;
    if (!['recording', 'paused'].includes(s.state) && state !== 'cancelled') return fail('Invalid recording transition.', 409);
    if (['transcribing', 'drafting'].includes(s.state)) return fail('Cancel after the in-flight provider request completes.', 409);
    if (state === 'stopped') {
      if (!expectedChunks || expectedChunks !== s.chunks.length) return fail('All audio must be uploaded before generating.', 409);
      s.expectedChunks = expectedChunks; s.stoppedAt = new Date().toISOString();
    }
    if (state === 'cancelled') { const c = await m.readResource('Consent', s.consentId, fresh); await m.updateResource({ ...c, status: 'inactive' }); }
    s.state = state; const saved = await saveSession(m, doc, s); await this.audit(m, saved, state); return saved;
  }
  async process(m: MedplumClient, id: string): Promise<DocumentReference> {
    let { doc, session: s } = await this.load(m, id, true); await this.checkConsent(m, s);
    if (s.state === 'ready') return doc;
    // A terminated service leaves a durable lease, not an infinitely busy UI.
    if (['transcribing', 'drafting'].includes(s.state) && Date.now() - Date.parse(s.processingStartedAt ?? s.createdAt) > 300000) s.state = 'failed';
    if (!canProcess(s)) return fail('Stop recording and finalize every upload before processing.', 409);
    const key = this.env.OPENAI_API_KEY; if (!key) return fail('OpenAI is not configured on the scribe server. Recording is saved; configure the key and retry.', 503);
    const template = findTemplate(s.template)!;
    // Lease starts with optimistic concurrency before any paid vendor request.
    s.state = 'transcribing'; s.processingStartedAt = new Date().toISOString(); s.error = undefined; doc = await saveSession(m, doc, s);
    try {
      let offset = 0; let cursor = 0; let block = 0;
      while (cursor < s.chunks.length) {
        const chunks = []; let samples = 0;
        while (cursor < s.chunks.length && samples + s.chunks[cursor].samples <= AUDIO_RATE * 480) { chunks.push(s.chunks[cursor++]); samples += chunks[chunks.length - 1].samples; }
        const end = offset + samples / AUDIO_RATE; const segmentId = `block-${block++}`;
        if (!s.transcript.some((t) => t.id === segmentId)) {
          await this.checkConsent(m, s); await this.authorize(m, s.encounterId, true);
          const pcm = new Int16Array(samples); let at = 0;
          for (const chunk of chunks) {
            const response = await m.download(m.fhirUrl('Binary', chunk.binaryId)); const bytes = new Uint8Array(await response.arrayBuffer());
            if (createHash('sha256').update(bytes).digest('hex') !== chunk.digest) return fail('Stored audio integrity check failed');
            const part = readWav(bytes); pcm.set(part, at); at += part.length;
          }
          const result = await this.ai.transcribe(wavBytes(pcm), key);
          await this.checkConsent(m, s); // Never persist results after withdrawal.
          s.transcript.push({ id: segmentId, start: offset, end, speaker: 'Unknown', text: result.text });
          s.usage.audioSeconds += samples / AUDIO_RATE; s.usage.transcriptionRequests.push(result.requestId);
          s.processingStartedAt = new Date().toISOString(); doc = await saveSession(m, doc, s);
        }
        offset = end;
      }
      if (!s.transcript.some((t) => t.text.trim())) return fail('No speech was detected. Review audio or document manually.');
      await this.checkConsent(m, s); await this.authorize(m, s.encounterId, true);
      s.state = 'drafting'; s.processingStartedAt = new Date().toISOString(); doc = await saveSession(m, doc, s);
      const generated = await this.ai.draft(s.transcript, template, s.instructions, key);
      for (const diagnosis of generated.result.diagnosisSuggestions) if (!findDiagnosis(diagnosis.code)) generated.result.warnings.push(`Unrecognized diagnosis code ${diagnosis.code}; enter a validated diagnosis manually.`);
      generated.result.diagnosisSuggestions = generated.result.diagnosisSuggestions.filter((d) => !!findDiagnosis(d.code));
      await this.checkConsent(m, s); await this.authorize(m, s.encounterId, true);
      const note = await m.searchOne('Composition', { encounter: `Encounter/${s.encounterId}`, status: 'preliminary', _count: '1' }, fresh);
      s.result = generated.result; s.baseNoteId = note?.id; s.baseVersion = note?.meta?.versionId;
      s.usage.inputTokens += generated.inputTokens; s.usage.outputTokens += generated.outputTokens; s.usage.draftRequest = generated.requestId; s.state = 'ready';
      doc = await saveSession(m, doc, s); await this.audit(m, doc, 'draft-generated'); return doc;
    } catch (error) {
      s.state = 'failed'; s.error = error instanceof ScribeError ? error.message : 'Processing failed. Saved audio and completed transcript blocks are retained. Retry or document manually.';
      await saveSession(m, doc, s).catch(() => undefined); throw error;
    }
  }
  async refreshBase(m: MedplumClient, id: string): Promise<DocumentReference> {
    const { doc, session: s } = await this.load(m, id, true); if (s.state !== 'ready') return fail('No draft proposals to refresh.');
    const note = await m.searchOne('Composition', { encounter: `Encounter/${s.encounterId}`, status: 'preliminary', _count: '1' }, fresh);
    if (!note) return fail('Save your encounter draft first.'); s.baseNoteId = note.id; s.baseVersion = note.meta?.versionId;
    return saveSession(m, doc, s);
  }
  async apply(m: MedplumClient, id: string, input: { fields: string[]; replace: boolean; noteId: string; version: string; edits?: Record<string, string> }): Promise<Composition> {
    const { doc, session: s } = await this.load(m, id, true); await this.checkConsent(m, s);
    assertApplyVersion(s, input.noteId, input.version);
    const note = await m.readResource('Composition', input.noteId, fresh);
    if (note.status !== 'preliminary' || note.relatesTo?.length || note.encounter?.reference !== `Encounter/${s.encounterId}` || note.subject?.reference !== `Patient/${s.patientId}` || note.meta?.versionId !== input.version) return fail('The draft changed or was signed. Reload before applying.', 409);
    if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 40 || input.fields.some((f) => typeof f !== 'string' || !s.result?.proposals.some((p) => p.field === f))) return fail('Select valid proposals.');
    if (input.edits && (typeof input.edits !== 'object' || Object.entries(input.edits).some(([field, value]) => !input.fields.includes(field) || typeof value !== 'string' || value.length > 16000))) return fail('Invalid reviewed field edits.');
    const proposals = s.result!.proposals.filter((p) => input.fields.includes(p.field)).map((p) => ({ ...p, value: input.edits?.[p.field] ?? p.value }));
    const data = JSON.parse(getExtensionValue(note, EXT.noteData) as string) as NoteData;
    if (data.template !== s.template) return fail('The encounter template changed. Generate a new recording draft for the selected template.', 409);
    const next = applyProposals(data, proposals, findTemplate(s.template)!, input.replace === true);
    const changed: Composition = { ...note, section: noteSections(next), extension: [...(note.extension ?? []).filter((e) => e.url !== EXT.noteData && e.url !== EXT.aiAssisted), { url: EXT.noteData, valueString: JSON.stringify(next) }, { url: EXT.aiAssisted, valueBoolean: true }] };
    // Atomic provenance and draft update; no partly applied field set.
    if (!m.getProject()?.features?.includes('transaction-bundles')) return fail('Atomic transaction support is required for applying scribe proposals.', 503);
    const result = await m.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: [
      { resource: changed, request: { method: 'PUT', url: `Composition/${note.id}`, ifMatch: `W/"${input.version}"` } },
      { resource: { resourceType: 'Provenance', target: [{ reference: `Composition/${note.id}` }], recorded: new Date().toISOString(), agent: [{ who: { reference: s.provider } }], entity: [{ role: 'source', what: createReference(doc) }], activity: { coding: [{ system: SCRIBE_SYSTEM, code: 'apply-reviewed-proposals' }], text: proposals.map((p) => `${p.field}${input.edits?.[p.field] !== undefined ? ' (edited by provider)' : ''}`).join(', ') } }, request: { method: 'POST', url: 'Provenance' } },
    ] });
    if (result.entry?.some((e) => !e.response?.status?.startsWith('2'))) return fail('Draft application failed; reload and retry.', 409);
    const saved = await m.readResource('Composition', note.id!, fresh);
    s.applied = [...new Set([...s.applied, ...input.fields])]; s.baseVersion = saved.meta?.versionId;
    await saveSession(m, doc, s); await this.audit(m, doc, 'proposals-applied'); return saved;
  }
}
