// Pre-commit Bot on Composition (P21, P23; SYSTEM-DESIGN.md §6).
// - A signed note (final) can never be changed or deleted: corrections are new Compositions that
//   "append" to or "replace" the original, which stays as signed.
// - Signing requires the provider's legal attestation and a note that passes signProblems():
//   at least one valid diagnosis, risk assessment, MSE, assessment, plan, reviewed medications,
//   and billing codes consistent with documented time (e.g. 90836 needs 38–52 minutes).
// Drafts (preliminary) may be saved incomplete at any time; autosave depends on that.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest, getExtensionValue, isNotFound, normalizeOperationOutcome } from '@medplum/core';
import type { Composition, Encounter, Reference } from '@medplum/fhirtypes';
import type { NoteData } from '@teleemon/core';
import { EXT, isLateEntry, noteSections, signProblems } from '@teleemon/core';

const LOCKED: Composition['status'][] = ['final', 'amended'];

export async function handler(medplum: MedplumClient, event: BotEvent<Composition>): Promise<boolean | Composition> {
  const note = event.input;
  const deleting = !!event.headers?.['X-Medplum-Deleted-Resource'] || !!event.headers?.['x-medplum-deleted-resource'];

  const previous = note.id ? await medplum.readResource('Composition', note.id).catch((err: unknown) => {
    // VM Bots and the server can load distinct copies of the SDK error class.
    const outcome = (err as OperationOutcomeError)?.outcome ?? normalizeOperationOutcome(err);
    if (isNotFound(outcome) || outcome.issue?.some((issue) => issue.code === 'not-found')) return undefined;
    throw err;
  }) : undefined;
  if (previous && LOCKED.includes(previous.status)) {
    reject(deleting ? 'Signed notes cannot be deleted.' : 'This note is signed and locked. Add an addendum or a correction instead.');
  }
  if (deleting) return true;
  if (!['preliminary', 'final', 'entered-in-error'].includes(note.status)) reject('Use a draft or a final note. Corrections are new signed addenda, not an amended status.');
  if (note.status !== 'final') {
    return true;
  }

  const attested = note.attester?.length === 1 && note.attester[0].mode === 'legal' && note.attester[0].party?.reference?.startsWith('Practitioner/') && note.attester[0].time;
  if (!attested) reject("A signed note needs the provider's legal attestation (name and time).");
  if (!note.subject?.reference?.startsWith('Patient/') || !note.encounter?.reference) reject('A signed note must belong to a patient and a visit.');

  // Only the visit's own provider may sign it (not another clinician or an administrator).
  const encounter = await medplum.readReference(note.encounter as Reference<Encounter>);
  const providers = (encounter.participant ?? []).map((p) => p.individual?.reference).filter(Boolean);
  const signer = note.attester?.find((a) => a.mode === 'legal')?.party?.reference;
  // Medplum 5.2.4 overwrites meta.author with repo.getAuthor() before invoking pre-commit
  // Bots. event.requester is not populated on this path; the payload's attester is untrusted.
  if (!signer || signer !== note.meta?.author?.reference || !providers.includes(signer)) reject("Only the visit's provider can sign this note.");
  if (note.subject.reference !== encounter.subject?.reference) reject('The note patient must match the visit patient.');
  if (previous && (previous.subject?.reference !== note.subject.reference || previous.encounter?.reference !== note.encounter?.reference)) reject('A note cannot be moved to a different patient or visit.');
  const now = new Date().toISOString();
  const signed: Composition = {
    ...note,
    attester: [{ ...note.attester![0], time: now }],
    extension: [
      ...(note.extension ?? []).filter((e) => e.url !== EXT.lateEntry),
      ...(isLateEntry(encounter.period?.start, now) ? [{ url: EXT.lateEntry, valueBoolean: true }] : []),
    ],
  };

  const amendment = note.relatesTo?.find((r) => r.code === 'appends' || r.code === 'replaces');
  if (amendment) {
    if (note.relatesTo?.length !== 1) reject('An amendment must reference exactly one original signed note.');
    const reason = (getExtensionValue(note, EXT.amendmentReason) as string | undefined)?.trim();
    const text = note.section?.map((s) => s.text?.div ?? '').join('').replace(/<[^>]+>/g, '').trim();
    if (!reason || reason.length < 5) reject('Give the reason for this addendum or correction.');
    if (!text) reject('An addendum or correction needs text.');
    const target = amendment.targetReference?.reference ? await medplum.readReference(amendment.targetReference as never).catch(() => undefined) : undefined;
    if (!amendment.targetReference?.reference?.startsWith('Composition/') || target?.resourceType !== 'Composition' || target.status !== 'final') reject('Addenda and corrections attach to a signed note.');
    const original = target as Composition;
    if (original.relatesTo?.length || original.subject?.reference !== note.subject.reference || original.encounter?.reference !== note.encounter.reference) reject('An amendment must belong to the same patient and visit as the original note.');
    return signed;
  }
  if (note.relatesTo?.length) reject('Only an addendum or correction can relate to another note.');

  const json = getExtensionValue(note, EXT.noteData) as string | undefined;
  if (!json) reject('The note has no structured content to validate.');
  let data: NoteData;
  try {
    data = JSON.parse(json as string) as NoteData;
  } catch {
    return reject('The note content is not valid.');
  }
  const problems = signProblems(data);
  if (problems.length) {
    reject(`The note can't be signed yet: ${problems.map((p) => p.message).join('; ')}.`);
  }
  const canonical = noteSections(data);
  // Compare values, not object insertion order. Extra fields/sections are also refused.
  const stable = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  if (stable(note.section) !== stable(canonical)) reject('The signed narrative must match the structured note. Save the draft and review it again.');
  return { ...signed, section: canonical };
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
