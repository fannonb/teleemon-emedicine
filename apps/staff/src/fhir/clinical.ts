import type { MedplumClient } from '@medplum/core';
import { getExtensionValue } from '@medplum/core';
import type { Condition, Consent, MedicationStatement, Observation, Patient } from '@medplum/fhirtypes';
import type { ConsentTypeCode, MeasureDef, Schedule } from '@teleemon/core';
import { CODE_SYSTEMS, CONSENT_TYPES, EXT, ICD10CM_SYSTEM, MEASURE_LIST, findMedication } from '@teleemon/core';
import type { Point } from '../components/charts';

export const ref = (p: Patient): string => `Patient/${p.id}`;

export function conditionCode(c: Condition): string | undefined {
  return c.code?.coding?.find((x) => x.system === ICD10CM_SYSTEM)?.code;
}

export function conditionStatus(c: Condition): string {
  return c.clinicalStatus?.coding?.[0]?.code ?? 'active';
}

export function medSchedule(m: MedicationStatement): Schedule | undefined {
  return (getExtensionValue(m, EXT.controlledSchedule) as Schedule | undefined) ?? findMedication(m.medicationCodeableConcept?.text)?.schedule;
}

export function medName(m: MedicationStatement): string {
  return m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? 'Medication';
}

export async function loadConditions(medplum: MedplumClient, p: Patient): Promise<Condition[]> {
  return medplum.searchResources('Condition', { subject: ref(p), _count: '100', _sort: '-recorded-date' }, { cache: 'no-cache' });
}

export async function loadMeds(medplum: MedplumClient, p: Patient, includeInactive = false): Promise<MedicationStatement[]> {
  return medplum.searchResources(
    'MedicationStatement',
    { subject: ref(p), ...(includeInactive ? {} : { status: 'active' }), _count: '100', _sort: '-_lastUpdated' },
    { cache: 'no-cache' }
  );
}

export interface ScoreSeries {
  readonly def: MeasureDef;
  readonly points: (Point & { observation: Observation })[];
}

/** Score Observations grouped by measure, oldest first. */
export async function loadScores(medplum: MedplumClient, p: Patient): Promise<ScoreSeries[]> {
  const obs = await medplum.searchResources('Observation', { subject: ref(p), category: 'survey', _sort: 'date', _count: '500' }, { cache: 'no-cache' });
  return MEASURE_LIST.map((def) => ({
    def,
    points: obs
      .filter((o) => o.code.coding?.some((c) => c.system === def.scoreCode.system && c.code === def.scoreCode.code))
      .map((o) => ({ date: o.effectiveDateTime ?? o.meta?.lastUpdated ?? '', value: o.valueInteger ?? 0, observation: o })),
  })).filter((s) => s.points.length > 0);
}

export function consentType(c: Consent): ConsentTypeCode | undefined {
  return c.category?.flatMap((x) => x.coding ?? []).find((x) => x.system === CODE_SYSTEMS.consentType)?.code as ConsentTypeCode | undefined;
}

export function consentIsCurrent(c: Consent, on = new Date()): boolean {
  if (c.status !== 'active') return false;
  const end = c.provision?.period?.end;
  return !end || new Date(end) >= on;
}

export interface ConsentStatus {
  readonly code: ConsentTypeCode;
  readonly label: string;
  readonly required: boolean;
  readonly current?: Consent;
  readonly expired?: Consent;
}

/**
 * Which standing consents a patient needs and whether each is on file. A controlled-substance
 * agreement is required when the patient has an active controlled medication.
 */
export function consentStatus(consents: Consent[], onControlled: boolean): ConsentStatus[] {
  const required: ConsentTypeCode[] = ['treatment', 'telehealth', 'recording', 'financial', 'privacy-notice', ...(onControlled ? (['controlled-substance'] as const) : [])];
  return CONSENT_TYPES.filter((t) => !t.perSession && t.code !== 'roi' && t.code !== 'restriction').map((t) => {
    const ofType = consents.filter((c) => consentType(c) === t.code);
    return {
      code: t.code,
      label: t.display,
      required: required.includes(t.code),
      current: ofType.find((c) => consentIsCurrent(c)),
      expired: ofType.find((c) => c.status === 'active' && !consentIsCurrent(c)),
    };
  });
}
