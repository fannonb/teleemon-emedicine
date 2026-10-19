// Pre-commit Bot on DocumentReference create/update (P16, P28). Medplum runs only the first
// matching pre-commit Bot per resource type, so every DocumentReference rule lives here.
//   - Inbound faxes: filing to a patient needs a fresh, personal confirmation of the match; removing
//     one from the queue needs a reason (nothing is deleted); a filed fax keeps its fax identity.
//   - Lab results: the review is recorded by the reviewer themselves and is final once made.
//   - Portal uploads: patients and proxies upload only insurance card photos to their own record.
// Other documents (uploads, exports, scribe sessions) pass straight through.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { DocumentReference, RelatedPerson } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT, isInboundFax, isPortalAuthor, matchProblem } from '@teleemon/core';
import { previous } from './previous';

const isLab = (d: DocumentReference): boolean => !!d.category?.some((c) => c.coding?.some((x) => x.system === CODE_SYSTEMS.documentCategory && x.code === 'lab-report'));
const review = (d: DocumentReference | undefined): string => JSON.stringify(d?.extension?.find((e) => e.url === EXT.resultReview) ?? null);

export async function handler(medplum: MedplumClient, event: BotEvent<DocumentReference>): Promise<boolean> {
  if (Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource')) return true;
  const doc = event.input;
  const author = doc.meta?.author?.reference;
  if (isPortalAuthor(author)) return portalUpload(medplum, doc, author as string);
  const fast = !isInboundFax(doc) && !isLab(doc) && !doc.id;
  if (fast) return true;
  const before = await previous(medplum, doc);

  if (before && isInboundFax(before) && !isInboundFax(doc)) reject('A received fax keeps its fax identity; file it instead of changing its type.');
  if (isInboundFax(doc) || (before && isInboundFax(before))) {
    const problem = matchProblem(before, doc, author);
    if (problem) reject(problem);
  }

  if (isLab(doc) || (before && isLab(before))) {
    if (before && isLab(before) && !isLab(doc)) reject('A lab result keeps its category; mark an incorrect result entered in error with a reason.');
    if (before?.subject?.reference && before.subject.reference !== doc.subject?.reference) reject('A filed lab result cannot move between patient charts. Mark it entered in error and file a corrected document.');
    for (const ref of doc.context?.related?.filter((r) => r.reference?.startsWith('ServiceRequest/')) ?? []) {
      const order = await medplum.readResource('ServiceRequest', ref.reference!.split('/')[1]);
      if (order.subject?.reference !== doc.subject?.reference) reject('The lab order must belong to the same patient as the result.');
    }
    const was = review(before);
    const now = review(doc);
    if (was !== 'null' && was !== now) reject('A reviewed result cannot be changed. Add a new document or a chart note instead.');
    if (was !== 'null' && before && JSON.stringify([before.subject, before.content, before.context, before.description, before.docStatus]) !== JSON.stringify([doc.subject, doc.content, doc.context, doc.description, doc.docStatus])) reject('A reviewed result cannot be changed. Add a corrected result as a new document.');
    if (doc.status === 'entered-in-error' && before?.status !== doc.status && (doc.extension?.find((e) => e.url === EXT.removalReason)?.valueString?.trim().length ?? 0) < 5) reject('Give a reason for removing a lab result.');
    if (was === 'null' && now !== 'null') {
      const by = doc.extension?.find((e) => e.url === EXT.resultReview)?.extension?.find((x) => x.url === 'by')?.valueReference?.reference;
      if (!by || by !== author || !by.startsWith('Practitioner/')) reject('Results are reviewed under your own name.');
      if (!doc.subject?.reference?.startsWith('Patient/')) reject('File the result to a patient before reviewing it.');
      if (doc.status !== 'current' || doc.docStatus === 'preliminary' || !doc.content.some((c) => !!c.attachment.url)) reject('Wait for the completed result file before reviewing it.');
      const fields = doc.extension?.find((e) => e.url === EXT.resultReview)?.extension ?? [];
      const at = Date.parse(fields.find((e) => e.url === 'at')?.valueDateTime ?? '');
      if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 10 * 60000) reject('Record the result review at the time of review.');
      if (fields.find((e) => e.url === 'abnormal')?.valueBoolean && !fields.find((e) => e.url === 'comment')?.valueString?.trim()) reject('Record the follow-up plan for an abnormal result.');
    }
  }
  return true;
}

const PORTAL_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'];
export const PORTAL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Insurance card photos uploaded by a patient or proxy from the portal: their own record, the
 * ID-and-insurance category, an image or PDF up to 10 MB, and preliminary until staff check it.
 * The patient's policy limits them to their own id-insurance documents; this keeps the content honest.
 */
async function portalUpload(medplum: MedplumClient, doc: DocumentReference, author: string): Promise<boolean> {
  const category = doc.category?.flatMap((c) => c.coding ?? []).filter((c) => c.system === CODE_SYSTEMS.documentCategory).map((c) => c.code);
  if (category?.length !== 1 || category[0] !== 'id-insurance') reject('Only insurance card photos can be uploaded from the portal.');
  const patientRef = author.startsWith('RelatedPerson/') ? (await medplum.readResource('RelatedPerson', author.split('/')[1]) as RelatedPerson).patient?.reference : author;
  if (!patientRef || doc.subject?.reference !== patientRef) reject('Upload cards to your own record.');
  if (doc.docStatus !== 'preliminary' || doc.status !== 'current') reject('Uploaded cards stay preliminary until the care team checks them.');
  if (doc.type || doc.extension?.length || doc.context?.related?.length) reject('Only the card photo itself can be uploaded.');
  for (const c of doc.content ?? []) {
    if (!PORTAL_UPLOAD_TYPES.includes(c.attachment.contentType ?? '')) reject('Upload a photo (JPEG, PNG, HEIC or WebP) or a PDF.');
    if ((c.attachment.size ?? 0) > PORTAL_UPLOAD_MAX_BYTES) reject('Card photos must be 10 MB or smaller.');
  }
  return true;
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
