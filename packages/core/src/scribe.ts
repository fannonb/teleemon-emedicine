import type { NoteData, NoteTemplate, SectionKey } from './notes';
import { MSE_DOMAINS, SECTION_LABELS } from './notes';

export const SCRIBE_SYSTEM = 'https://fhir.teleemon.com/scribe';
export const SCRIBE_DATA = `${SCRIBE_SYSTEM}/session`;
export const SCRIBE_VERSION = '1';
export const AUDIO_RATE = 16000;
export const MAX_AUDIO_SECONDS = 3 * 3600;
export const MAX_CHUNK_BYTES = AUDIO_RATE * 2 * 15 + 44;
export const MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const DRAFT_SECTIONS: SectionKey[] = ['chiefComplaint', 'intervalHistory', 'psychRos', 'substanceUse', 'pastHistory', 'socialHistory', 'assessment', 'plan', 'psychotherapy', 'followUp'];
export const SCRIBE_FIELDS: string[] = [...DRAFT_SECTIONS.map((s) => `sections.${s}`), ...MSE_DOMAINS.filter((d) => d.key !== 'appearance').map((d) => `mse.${d.key}`), 'risk.suicidalIdeation', 'risk.homicidalIdeation', 'risk.selfHarm', 'risk.notes'];
export type ScribeState = 'recording' | 'paused' | 'stopped' | 'transcribing' | 'drafting' | 'ready' | 'failed' | 'cancelled';
export interface TranscriptSegment { id: string; start: number; end: number; speaker: 'Unknown'; text: string }
export interface ScribeProposal { field: string; value: string; evidence: string[]; caution: string }
export interface ScribeResult { proposals: ScribeProposal[]; warnings: string[]; diagnosisSuggestions: { code: string; reason: string; evidence: string[] }[] }
export interface AudioChunk { sequence: number; binaryId: string; digest: string; samples: number }
export interface ScribeSession {
  schema: '1'; encounterId: string; patientId: string; provider: string; consentId: string; standingConsentId: string;
  createdAt: string; expiresAt: string; state: ScribeState; template: NoteTemplate['code']; instructions: string;
  meetingUrl?: string; chunks: AudioChunk[]; stoppedAt?: string; expectedChunks?: number; transcript: TranscriptSegment[];
  result?: ScribeResult; error?: string; processingStartedAt?: string; baseNoteId?: string; baseVersion?: string;
  legalHold: boolean; audioDeletedAt?: string; retainUntil: string; applied: string[];
  usage: { audioSeconds: number; inputTokens: number; outputTokens: number; transcriptionRequests: string[]; draftRequest?: string };
}

export function fieldLabel(field: string): string {
  const [group, key] = field.split('.');
  if (group === 'sections') return SECTION_LABELS[key as SectionKey] ?? key;
  if (group === 'mse') return `MSE · ${MSE_DOMAINS.find((d) => d.key === key)?.label ?? key}`;
  return `Risk · ${{ suicidalIdeation: 'Suicidal ideation', homicidalIdeation: 'Homicidal ideation', selfHarm: 'Self-harm', notes: 'Evidence / notes' }[key] ?? key}`;
}

export function fieldValue(note: NoteData, field: string): string {
  const [group, key] = field.split('.');
  if (group === 'sections') return note.sections[key as SectionKey] ?? '';
  if (group === 'mse') return note.mse[key] ?? '';
  if (group === 'risk') return String((note.risk as Record<string, unknown>)[key] ?? '');
  throw new Error('Unsupported scribe field');
}

/** Never writes diagnoses, billing, review confirmations, private notes or signatures. */
export function applyProposals(note: NoteData, proposals: ScribeProposal[], template: NoteTemplate, replace = false): NoteData {
  const next = structuredClone(note);
  for (const p of proposals) {
    validateProposal(p, template);
    if (!replace && fieldValue(next, p.field).trim()) throw new Error(`${fieldLabel(p.field)} already has content. Review replacement explicitly.`);
    const [group, key] = p.field.split('.');
    if (group === 'sections') next.sections[key as SectionKey] = p.value;
    if (group === 'mse') next.mse[key] = p.value;
    if (group === 'risk') (next.risk as Record<string, unknown>)[key] = p.value;
  }
  if (proposals.length) next.aiAssisted = true;
  return next;
}

function validateProposal(p: ScribeProposal, template: NoteTemplate): void {
  if (!p || !SCRIBE_FIELDS.includes(p.field) || typeof p.value !== 'string' || !p.value.trim() || p.value.length > 16000 || typeof p.caution !== 'string') throw new Error('Invalid clinical field proposal');
  const [group, key] = p.field.split('.');
  if (group === 'sections' && !template.sections.includes(key as SectionKey)) throw new Error('Proposal is outside the selected template');
  if ((group === 'mse' || group === 'risk') && !template.sections.includes(group)) throw new Error('Proposal is outside the selected template');
  const enums: Record<string, string[]> = { 'risk.suicidalIdeation': ['denied', 'passive', 'active-no-plan', 'active-plan'], 'risk.homicidalIdeation': ['denied', 'present'], 'risk.selfHarm': ['none', 'recent'] };
  if (enums[p.field] && !enums[p.field].includes(p.value)) throw new Error('Invalid risk value');
}

export function validateScribeResult(value: unknown, segments: TranscriptSegment[], template: NoteTemplate): ScribeResult {
  const v = value as ScribeResult;
  if (!v || !Array.isArray(v.proposals) || v.proposals.length > 40 || !Array.isArray(v.warnings) || !Array.isArray(v.diagnosisSuggestions)) throw new Error('Invalid scribe response');
  const ids = new Set(segments.map((s) => s.id));
  const fields = new Set<string>();
  const evidence = (refs: string[]): void => { if (!Array.isArray(refs) || !refs.length || refs.some((r) => !ids.has(r))) throw new Error('Missing or invalid transcript evidence'); };
  for (const p of v.proposals) { validateProposal(p, template); evidence(p.evidence); if (fields.has(p.field)) throw new Error('Duplicate clinical field'); fields.add(p.field); }
  if (v.warnings.length > 30 || v.warnings.some((w) => typeof w !== 'string' || w.length > 2000)) throw new Error('Invalid scribe warning');
  if (v.diagnosisSuggestions.length > 20) throw new Error('Too many diagnosis suggestions');
  for (const d of v.diagnosisSuggestions) { if (typeof d.code !== 'string' || typeof d.reason !== 'string' || d.reason.length > 2000) throw new Error('Invalid diagnosis suggestion'); evidence(d.evidence); }
  return v;
}

export function validMeetUrl(value: string): boolean {
  try { const u = new URL(value); return u.origin === 'https://meet.google.com' && !u.username && !u.password && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname) && !u.search && !u.hash; } catch { return false; }
}

export function canProcess(session: ScribeSession): boolean {
  return ['stopped', 'failed'].includes(session.state) && !!session.stoppedAt && session.expectedChunks === session.chunks.length && session.chunks.length > 0 && !session.audioDeletedAt;
}

export function assertApplyVersion(session: ScribeSession, noteId: string, version: string): void {
  if (session.state !== 'ready' || session.baseNoteId !== noteId || session.baseVersion !== version) throw new Error('The note changed. Refresh proposals against the current saved draft before applying.');
}

/** Mono PCM16 WAV: independent upload chunks, combined into <=8-minute API files after stop. */
export function wavBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, AUDIO_RATE, true); view.setUint32(28, AUDIO_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

export function readWav(bytes: Uint8Array): Int16Array {
  if (bytes.length < 46 || bytes.length > MAX_CHUNK_BYTES) throw new Error('Audio chunk size is invalid');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const text = (at: number, n: number): string => String.fromCharCode(...bytes.slice(at, at + n));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || text(12, 4) !== 'fmt ' || text(36, 4) !== 'data' || v.getUint32(16, true) !== 16 || v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== AUDIO_RATE || v.getUint16(34, true) !== 16 || v.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('Expected mono 16 kHz PCM16 WAV');
  const out = new Int16Array((bytes.length - 44) / 2); for (let i = 0; i < out.length; i++) out[i] = v.getInt16(44 + i * 2, true); return out;
}
