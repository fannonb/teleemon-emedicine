import type { MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import type { DocumentCategoryCode } from '@teleemon/core';
import { CODE_SYSTEMS, DOCUMENT_CATEGORIES } from '@teleemon/core';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp'];

/**
 * Uploads a file as a DocumentReference. The Binary's security context is the DocumentReference
 * itself, so the file can only be fetched by users who can read that document (SYSTEM-DESIGN.md §5.2).
 */
export async function uploadDocument(
  medplum: MedplumClient,
  opts: { patient: Patient; file: File; category: DocumentCategoryCode; title?: string; description?: string; encounter?: Encounter; related?: { reference: string } }
): Promise<DocumentReference> {
  const { patient, file, category } = opts;
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${file.name} is larger than 20 MB.`);
  }
  const display = DOCUMENT_CATEGORIES.find((c) => c.code === category)?.display;
  const title = opts.title?.trim() || file.name;
  const doc = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    docStatus: 'preliminary',
    category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: category, display }] }],
    subject: createReference(patient),
    date: new Date().toISOString(),
    description: opts.description?.trim() || title,
    context: opts.encounter || opts.related ? { encounter: opts.encounter ? [createReference(opts.encounter)] : undefined, related: opts.related ? [opts.related] : undefined } : undefined,
    content: [{ attachment: { contentType: file.type || 'application/octet-stream', title } }],
  });
  const attachment = await medplum.createAttachment({
    data: file,
    contentType: file.type || 'application/octet-stream',
    filename: file.name,
    securityContext: createReference(doc),
  });
  return medplum.updateResource<DocumentReference>({
    ...doc,
    docStatus: 'final',
    content: [{ attachment: { ...attachment, title, size: file.size } }],
  });
}

export function documentCategory(doc: DocumentReference): DocumentCategoryCode | undefined {
  return doc.category?.flatMap((c) => c.coding ?? []).find((c) => c.system === CODE_SYSTEMS.documentCategory)?.code as DocumentCategoryCode | undefined;
}
