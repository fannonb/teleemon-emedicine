// Reads made with the patient's own token, under their compartment policy (scripts/config/portal.ts).

import type { MedplumClient } from '@medplum/core';
import type { Appointment, Consent, Coverage, DocumentReference, MedicationStatement, Patient, QuestionnaireResponse } from '@medplum/fhirtypes';
import type { GoodFaithEstimate, IntakeState, MeasureDef } from '@teleemon/core';
import { CODE_SYSTEMS, INTAKE_QUESTIONNAIRE_URL, MEASURES, findVisitType, isActivePortalVisit, isControlledStatement, nextActivePortalVisit, questionnaireUrl } from '@teleemon/core';
import type { portalApi } from './api';
import type { Me } from './session';

const id = (ref: string): string => ref.split('/')[1];

export async function loadPatient(medplum: MedplumClient, me: Me): Promise<Patient> {
  return medplum.readResource('Patient', id(me.patientRef), { cache: 'no-cache' });
}

export async function loadAppointments(medplum: MedplumClient, me: Me): Promise<Appointment[]> {
  return medplum.searchResources('Appointment', { patient: me.patientRef, _sort: 'date', _count: '100' }, { cache: 'no-cache' });
}

/** Active visit status, not planned clock time, determines whether a visit remains actionable. */
export const isUpcoming = (a: Appointment): boolean =>
  isActivePortalVisit(a);

export const visitCode = (a: Appointment): string | undefined => a.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code;

export const providerName = (a: Appointment): string =>
  a.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.display ?? 'your provider';

/** Questionnaires due before the next visit: its measures not completed in the 14 days before it. */
export function dueMeasures(next: Appointment | undefined, responses: readonly QuestionnaireResponse[]): MeasureDef[] {
  if (!next?.start) return [];
  const keys = findVisitType(visitCode(next))?.measures ?? [];
  const since = Date.parse(next.start) - 14 * 86400000;
  return keys
    .map((k) => MEASURES[k as MeasureDef['key']])
    .filter((def): def is MeasureDef => !!def)
    .filter((def) => !responses.some((r) => r.questionnaire === questionnaireUrl(def.key) && r.status === 'completed' && Date.parse(r.authored ?? '') >= since));
}

export interface PortalOverview {
  readonly patient: Patient;
  readonly appointments: Appointment[];
  readonly next?: Appointment;
  readonly intakeState?: IntakeState;
  readonly measuresDue: MeasureDef[];
  /** Insurance card photos on file (the patient's uploads and staff scans). */
  readonly cards: DocumentReference[];
  /** The good-faith estimate for the next visit, for self-pay patients. */
  readonly estimate?: { needed: boolean; estimate?: GoodFaithEstimate };
}

export interface EstimateResponse {
  readonly needed: boolean;
  readonly estimate?: GoodFaithEstimate;
}

/** Everything Home and the intake wizard need. Limited proxies load scheduling data only. */
export async function loadOverview(medplum: MedplumClient, api: ReturnType<typeof portalApi>, me: Me): Promise<PortalOverview> {
  const [patient, appointments] = await Promise.all([loadPatient(medplum, me), loadAppointments(medplum, me)]);
  const next = nextActivePortalVisit(appointments);
  if (me.access === 'limited') return { patient, appointments, next, measuresDue: [], cards: [] };
  const [responses, consents, coverages, meds, cards, estimate] = await Promise.all([
    medplum.searchResources('QuestionnaireResponse', { subject: me.patientRef, _count: '200', _sort: '-_lastUpdated' }, { cache: 'no-cache' }),
    medplum.searchResources('Consent', { patient: me.patientRef, _count: '100' }, { cache: 'no-cache' }) as Promise<Consent[]>,
    medplum.searchResources('Coverage', { beneficiary: me.patientRef, _count: '20' }, { cache: 'no-cache' }) as Promise<Coverage[]>,
    medplum.searchResources('MedicationStatement', { subject: me.patientRef, status: 'active', _count: '100' }, { cache: 'no-cache' }) as Promise<MedicationStatement[]>,
    medplum.searchResources('DocumentReference', { patient: me.patientRef, category: `${CODE_SYSTEMS.documentCategory}|id-insurance`, status: 'current', _count: '20', _sort: '-date' }, { cache: 'no-cache' }) as Promise<DocumentReference[]>,
    api.get<EstimateResponse>('estimate'),
  ]);
  const measuresDue = dueMeasures(next, responses);
  const intake = responses.find((r) => r.questionnaire === INTAKE_QUESTIONNAIRE_URL);
  const onControlled = meds.some(isControlledStatement);
  return {
    patient, appointments, next, measuresDue, cards, estimate,
    intakeState: { patient, intake, consents, coverages, measuresDue: measuresDue.map((m) => m.key), onControlled, estimateNeeded: estimate.needed },
  };
}
