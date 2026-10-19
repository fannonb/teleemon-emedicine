// Post-commit Bot on QuestionnaireResponse (P15, SYSTEM-DESIGN.md §6).
// Scores completed measures into a total-score Observation. A positive safety item (PHQ-9
// item 9) always creates an active Flag and an urgent Task for the patient's provider, whether
// the questionnaire was entered by staff or, from Phase 7, by the patient in the portal.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference, generateId, getExtensionValue } from '@medplum/core';
import type { BundleEntry, Flag, Observation, Patient, QuestionnaireResponse, Reference, Resource, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, measureFromQuestionnaireUrl, scoreMeasure } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<QuestionnaireResponse>): Promise<string> {
  const qr = event.input;
  const def = measureFromQuestionnaireUrl(qr.questionnaire);
  if (!def || qr.status !== 'completed' || !qr.subject?.reference?.startsWith('Patient/')) {
    return 'skipped: not a completed Teleemon measure';
  }

  const source = `QuestionnaireResponse/${qr.id}`;
  const existing = await medplum.searchOne('Observation', { 'derived-from': source });

  const answers: Record<string, number> = {};
  for (const item of qr.item ?? []) {
    const answer = item.answer?.[0];
    const value = answer?.valueInteger ?? (answer?.valueCoding?.code !== undefined ? Number(answer.valueCoding.code) : undefined);
    if (typeof value === 'number' && Number.isFinite(value)) {
      answers[item.linkId] = value;
    }
  }

  const patient = await medplum.readReference(qr.subject as Reference<Patient>);
  const sexAtBirth = getExtensionValue(patient, EXT.sexAssignedAtBirth) as string | undefined;
  const result = scoreMeasure(def, answers, sexAtBirth);
  const effective = qr.authored ?? new Date().toISOString();

  const entries: BundleEntry[] = [];
  const observationUrl = existing ? `Observation/${existing.id}` : `urn:uuid:${generateId()}`;
  const add = (resource: Resource, key: string, fullUrl?: string): void => {
    entries.push({
      fullUrl,
      resource: { ...resource, identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }] } as Resource,
      request: { method: 'POST', url: resource.resourceType, ifNoneExist: new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString() },
    });
  };
  if (!existing) add({
    resourceType: 'Observation',
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey', display: 'Survey' }] }],
    code: { coding: [def.scoreCode], text: def.shortTitle },
    subject: createReference(patient),
    encounter: qr.encounter,
    effectiveDateTime: effective,
    valueInteger: result.score,
    interpretation: result.band ? [{ text: result.band.label }] : undefined,
    derivedFrom: [createReference(qr)],
    note: result.complete ? undefined : [{ text: 'Incomplete: one or more items unanswered; score may be understated.' }],
  } satisfies Observation, `score-${qr.id}`, observationUrl);

  if (result.safetyConcern) {
    const provider = patient.generalPractitioner?.[0];
    // Support older scores/alerts without derived identifiers; never reopen a reviewed flag.
    const flags = await medplum.searchResources('Flag', { subject: qr.subject.reference, _count: '1000' });
    const priorFlag = flags.find((f) => f.extension?.some((e) => e.valueReference?.reference === observationUrl));
    const priorTask = await medplum.searchOne('Task', { focus: source, code: `${CODE_SYSTEMS.taskCode}|safety-review` });
    if (!priorFlag) add({
      resourceType: 'Flag',
      status: 'active',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/flag-category', code: 'clinical', display: 'Clinical' }] }],
      code: { coding: [{ system: CODE_SYSTEMS.flagCode, code: 'safety-screen-positive' }], text: 'Positive safety screen' },
      subject: createReference(patient),
      period: { start: effective },
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/flag-detail', valueReference: { reference: observationUrl } }],
    } satisfies Flag, `safety-flag-${qr.id}`);
    if (!priorTask) add({
      resourceType: 'Task',
      status: 'requested',
      intent: 'order',
      priority: 'stat',
      code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'safety-review' }], text: 'Safety review' },
      description: `${result.safetyDetail}. Review today and complete a safety assessment.`,
      for: createReference(patient),
      focus: createReference(qr),
      owner: provider,
      authoredOn: new Date().toISOString(),
    } satisfies Task, `safety-task-${qr.id}`);
  }
  // Score, flag and task commit together. Conditional creates also protect redelivery.
  // An older partial delivery is repaired instead of being skipped because its score exists.
  if (entries.length) await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries });
  return `scored ${def.shortTitle}=${result.score}`;
}
