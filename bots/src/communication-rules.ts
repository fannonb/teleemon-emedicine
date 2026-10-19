// Pre-commit Bot on patient-message Communications (P03, X05): inbound texts that are not reminder
// keywords, and portal messages. Medplum runs only the first matching pre-commit Bot per resource
// type; reminders and outbound faxes are not patient messages and pass through.
//   - An unmatched message is linked to a patient only with a personal, fresh confirmation.
//   - Closing a message records how it was handled (a note), and removing one needs a reason.
//   - A portal message is sent by the signed-in patient or proxy, about that patient, as plain text.
//     Possible crisis language marks it urgent so staff see it first.
//   - A portal reply is sent by staff under their own name.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { Communication, RelatedPerson } from '@medplum/fhirtypes';
import { EXT, MIN_REASON, PORTAL_REPLY, communicationCategory, crisisLanguage, isPatientMessage, isPortalAuthor, matchProblem, portalMessageProblem, stableJson } from '@teleemon/core';
import { previous } from './previous';

export async function handler(medplum: MedplumClient, event: BotEvent<Communication>): Promise<Communication | boolean> {
  if (Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource')) return true;
  const msg = event.input;
  const author = msg.meta?.author?.reference;
  const before = await previous(medplum, msg);

  if (communicationCategory(msg) === PORTAL_REPLY || (before && communicationCategory(before) === PORTAL_REPLY)) {
    // Once sent, only the portal service's "patient was notified" marker may be added.
    if (before) {
      const content = (c: Communication): string => {
        const extension = c.extension?.filter((e) => e.url !== EXT.notifiedAt);
        return stableJson({ ...c, meta: undefined, extension: extension?.length ? extension : undefined });
      };
      if (content(before) !== content(msg)) reject('A sent portal reply cannot be changed.');
      return true;
    }
    if (!author?.startsWith('Practitioner/') || msg.sender?.reference !== author) reject('Reply under your own name.');
    if (!msg.subject?.reference?.startsWith('Patient/')) reject('A portal reply must name the patient.');
    if (!msg.payload?.some((p) => p.contentString?.trim())) reject('Write a reply.');
    return true;
  }

  if (!isPatientMessage(msg) && !(before && isPatientMessage(before))) return true;
  if (before && isPatientMessage(before) && communicationCategory(before) !== communicationCategory(msg)) reject('A patient message keeps its message category.');

  if (isPortalAuthor(author)) {
    // Patients and proxies send new messages; they never edit or close them (their policy is create-only).
    if (before) reject('A sent message cannot be changed.');
    const patientRef = author?.startsWith('RelatedPerson/')
      ? (await medplum.readResource('RelatedPerson', author.split('/')[1]) as RelatedPerson).patient?.reference
      : author;
    const problem = portalMessageProblem(msg, author, patientRef);
    if (problem) reject(problem);
    const text = msg.payload?.map((p) => p.contentString ?? '').join(' ') ?? '';
    return { ...msg, sent: new Date().toISOString(), priority: crisisLanguage(text) ? 'urgent' : 'routine' };
  }

  // Linking a patient on an existing message needs confirmation; the worker's own match of a
  // known phone number at creation is the original routing, not a re-assignment.
  if (before) {
    const problem = matchProblem(before, msg, author);
    if (problem) reject(problem);
  }
  if (before?.status !== 'completed' && msg.status === 'completed') {
    const note = msg.note?.map((n) => n.text ?? '').join(' ').trim() ?? '';
    if (note.length < MIN_REASON) reject('Record how the message was handled (for example: called patient back) before closing it.');
  }
  return true;
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
