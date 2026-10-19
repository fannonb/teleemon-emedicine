import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { MedicationStatement, Patient, Reference, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, findMedication } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<MedicationStatement>): Promise<string> {
  const med = event.input;
  const known = findMedication(med.medicationCodeableConcept?.text ?? med.medicationCodeableConcept?.coding?.[0]?.display);
  if (med.status !== 'active' || !known?.monitoring || !med.subject.reference?.startsWith('Patient/')) return 'skipped';
  const patient = await medplum.readReference(med.subject as Reference<Patient>);
  const key = `monitoring-${med.id}`;
  const task: Task = {
    resourceType: 'Task', identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
    status: 'requested', intent: 'order', priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'lab-monitoring' }], text: 'Lab monitoring' },
    description: `${known.monitoring.label} (${known.name})`, for: createReference(patient), focus: createReference(med),
    owner: patient.generalPractitioner?.[0], authoredOn: med.dateAsserted ?? new Date().toISOString(),
    restriction: { period: { end: new Date(new Date(med.dateAsserted ?? med.meta?.lastUpdated ?? Date.now()).getTime() + Math.min(known.monitoring.everyDays, 30) * 86400000).toISOString() } },
  };
  await medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString());
  return 'monitoring task ensured';
}
