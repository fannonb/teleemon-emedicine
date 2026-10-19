// Manual lab orders and results (P16). Electronic ordering over HL7 or Health Gorilla comes in
// Phase 9; until then the provider orders here, prints a requisition for the lab, and results
// arrive as PDFs (upload or fax) that the provider reviews.

import type { Patient, Practitioner, Reference, ServiceRequest } from '@medplum/fhirtypes';
import { LOINC_SYSTEM } from './fhir';

export interface LabTest {
  readonly key: string;
  readonly label: string;
  readonly loinc?: string;
  readonly fasting?: boolean;
}

export const LAB_TESTS: readonly LabTest[] = [
  { key: 'lithium', label: 'Lithium level (12 h trough)', loinc: '14334-7' },
  { key: 'valproate', label: 'Valproic acid level', loinc: '4086-5' },
  { key: 'cbc', label: 'CBC with differential', loinc: '57021-8' },
  { key: 'anc', label: 'Absolute neutrophil count (clozapine)', loinc: '751-8' },
  { key: 'cmp', label: 'Comprehensive metabolic panel', loinc: '24323-8' },
  { key: 'tsh', label: 'TSH', loinc: '3016-3' },
  { key: 'a1c', label: 'Hemoglobin A1c', loinc: '4548-4' },
  { key: 'lipids', label: 'Lipid panel', loinc: '57698-3', fasting: true },
  { key: 'uds', label: 'Urine drug screen' },
];

export const LABS = ['LabCorp', 'Quest Diagnostics', 'Other (on requisition)'] as const;

export function findLabTest(key: string): LabTest | undefined {
  return LAB_TESTS.find((t) => t.key === key);
}

export function buildLabOrder(input: { patient: Reference<Patient>; requester: Reference<Practitioner>; test: LabTest; lab: string; note?: string; reasonCode?: string }): ServiceRequest {
  return {
    resourceType: 'ServiceRequest',
    status: 'active',
    intent: 'order',
    category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory procedure' }] }],
    code: { coding: input.test.loinc ? [{ system: LOINC_SYSTEM, code: input.test.loinc, display: input.test.label }] : [], text: input.test.label },
    subject: input.patient,
    requester: input.requester,
    authoredOn: new Date().toISOString(),
    performer: [{ display: input.lab }],
    patientInstruction: input.test.fasting ? 'Fasting for 9–12 hours before the blood draw.' : undefined,
    note: input.note?.trim() ? [{ text: input.note.trim() }] : undefined,
    reasonCode: input.reasonCode ? [{ text: input.reasonCode }] : undefined,
  };
}
