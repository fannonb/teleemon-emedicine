// Lab result review (P16). Runs after any lab-report DocumentReference is saved: a result filed to a
// patient creates one review Task for the patient's provider (idempotent); recording the review
// completes the Task and the lab order it answers. No result is left unreviewed silently.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { DocumentReference, Patient, Reference, ServiceRequest, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, RESULT_REVIEW_SLA_BUSINESS_DAYS, addBusinessDays, teamCoding } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<DocumentReference>): Promise<string> {
  // Subscription jobs can arrive late or out of order. Always act on the latest saved document.
  const doc = await medplum.readResource('DocumentReference', event.input.id!, { cache: 'no-cache' });
  const isLab = doc.category?.some((c) => c.coding?.some((x) => x.system === CODE_SYSTEMS.documentCategory && x.code === 'lab-report'));
  if (!isLab || !doc.subject?.reference?.startsWith('Patient/') || doc.docStatus === 'preliminary' || !doc.content.some((c) => c.attachment.url)) return 'skipped';
  const key = `result-review-${doc.id}`;
  const existing = await medplum.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` });
  if (doc.status !== 'current') {
    if (existing && !['completed', 'cancelled'].includes(existing.status)) await medplum.updateResource({ ...existing, status: 'cancelled', statusReason: { text: 'Source lab result withdrawn; review the corrected result.' } }, { headers: { 'If-Match': `W/"${existing.meta?.versionId}"` } });
    return 'skipped';
  }
  const reviewed = doc.extension?.find((e) => e.url === EXT.resultReview);
  const order = doc.context?.related?.find((r) => r.reference?.startsWith('ServiceRequest/'));

  if (reviewed) {
    if (existing && existing.status !== 'completed') {
      await medplum.updateResource<Task>({ ...existing, status: 'completed', lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${existing.meta?.versionId}"` } });
    }
    if (order) {
      const sr = await medplum.readReference(order as Reference<ServiceRequest>).catch(() => undefined);
      if (sr && sr.subject?.reference === doc.subject.reference && sr.status === 'active') await medplum.updateResource<ServiceRequest>({ ...sr, status: 'completed' }, { headers: { 'If-Match': `W/"${sr.meta?.versionId}"` } });
    }
    return 'review recorded';
  }
  if (existing) return 'review task exists';
  const patient = await medplum.readReference(doc.subject as Reference<Patient>);
  const orderer = order ? (await medplum.readReference(order as Reference<ServiceRequest>).catch(() => undefined))?.requester : undefined;
  const owner = (orderer?.reference?.startsWith('Practitioner/') ? orderer : patient.generalPractitioner?.find((g) => g.reference?.startsWith('Practitioner/'))) as Task['owner'];
  await medplum.createResourceIfNoneExist<Task>(
    {
      resourceType: 'Task',
      identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
      status: 'requested',
      intent: 'order',
      priority: 'routine',
      code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'result-review' }], text: 'Review result' },
      description: `Review result: ${doc.description ?? doc.content?.[0]?.attachment?.title ?? 'lab report'}`,
      for: createReference(patient),
      focus: createReference(doc),
      owner,
      performerType: teamCoding('provider'),
      authoredOn: new Date().toISOString(),
      restriction: { period: { end: addBusinessDays(new Date(), RESULT_REVIEW_SLA_BUSINESS_DAYS).toISOString() } },
    },
    new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString()
  );
  return 'review task created';
}
