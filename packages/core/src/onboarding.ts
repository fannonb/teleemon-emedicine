// Patient onboarding (docs/PATIENT-ONBOARDING-PLAN.md): who may get a portal sign-in, what a new
// patient's record needs before staff verify it, and the good-faith estimate for self-pay visits.
// Shared by the portal app, the portal service, the staff app and the task-rules Bot.

import type { Appointment, Consent, Coverage, MedicationStatement, Patient, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT } from './fhir';
import { requiredPortalConsents, signedPortalConsent } from './intake';
import { findMedication } from './medications';
import { cardOnFile, sexAtBirth } from './portal';
import { addBusinessDays } from './prescribing';
import { teamCoding } from './inbox';
import type { VisitType } from './scheduling';
import { isMinor } from './time';

/**
 * Why a patient cannot be invited to their own portal sign-in, or undefined. Until the practice
 * decides at what age a teen signs in on their own (counsel), patients under 18 use a parent's or
 * guardian's proxy access only.
 */
export function patientInviteProblem(patient: Patient, now = new Date()): string | undefined {
  if (patient.active === false) return 'This record is inactive.';
  if (isMinor(patient.birthDate, now)) return "Patients under 18 use a parent's or guardian's portal access. Invite the guardian from Related people instead.";
  return undefined;
}

export interface OnboardingItem {
  readonly key: string;
  readonly label: string;
}

/** Registration details every patient record needs, however it was created (staff form, booking or portal). */
export function registrationGaps(p: Patient): OnboardingItem[] {
  const gaps: OnboardingItem[] = [];
  if (!sexAtBirth(p)) gaps.push({ key: 'sex-at-birth', label: 'Sex assigned at birth' });
  if (!p.telecom?.some((t) => t.system === 'phone' && t.value)) gaps.push({ key: 'phone', label: 'Mobile phone' });
  if (!p.telecom?.some((t) => t.system === 'email' && t.value)) gaps.push({ key: 'email', label: 'Email' });
  if (!p.address?.some((a) => a.state)) gaps.push({ key: 'home-state', label: 'Home state' });
  const emergency = p.contact?.some((c) => c.relationship?.some((r) => r.coding?.some((x) => x.code === 'C' || x.code === 'GUARD')) && c.telecom?.some((t) => t.value));
  if (!emergency) gaps.push({ key: 'emergency-contact', label: 'Emergency contact' });
  return gaps;
}

export function isControlledStatement(m: MedicationStatement): boolean {
  if (m.status !== 'active') return false;
  return !!m.extension?.some((e) => e.url === EXT.controlledSchedule) || !!findMedication(m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display)?.schedule;
}

export interface OnboardingState {
  readonly patient: Patient;
  readonly coverages: readonly Coverage[];
  readonly consents: readonly Consent[];
  /** The patient takes a controlled medication, so the controlled-substance agreement is required. */
  readonly onControlled: boolean;
}

/** What is still missing before staff can mark a new patient verified. Empty means ready. */
export function onboardingProblems(s: OnboardingState): OnboardingItem[] {
  const items = [...registrationGaps(s.patient)];
  const selfPay = s.patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true);
  if (!selfPay && !s.coverages.some((c) => c.status === 'active')) {
    items.push({ key: 'insurance', label: s.coverages.some((c) => c.status === 'draft') ? 'Insurance checked and made active (the patient entered it as a draft)' : 'Insurance, or self-pay' });
  }
  if (!cardOnFile(s.patient)) items.push({ key: 'card', label: 'Card on file' });
  for (const doc of requiredPortalConsents(s.onControlled)) {
    if (!signedPortalConsent(s.consents, doc)) items.push({ key: `consent-${doc.type}`, label: `Consent: ${doc.title}` });
  }
  return items;
}

export const ONBOARDING_REVIEW = 'onboarding-review';

/** One review Task per patient: created when they submit their new-patient forms. */
export function onboardingReviewIdentifier(patientId: string): { system: string; value: string } {
  return { system: DERIVED_IDENTIFIER_SYSTEM, value: `onboarding-review-${patientId}` };
}

export function buildOnboardingReviewTask(patientId: string, intakeId: string, now = new Date()): Task {
  return {
    resourceType: 'Task',
    identifier: [onboardingReviewIdentifier(patientId)],
    status: 'requested',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: ONBOARDING_REVIEW }], text: 'New patient forms to verify' },
    description: 'New patient forms submitted in the portal: check identity, insurance, card and consents, then mark verified.',
    for: { reference: `Patient/${patientId}` },
    focus: { reference: `QuestionnaireResponse/${intakeId}` },
    performerType: teamCoding('frontdesk'),
    authoredOn: now.toISOString(),
    restriction: { period: { end: addBusinessDays(now, 1).toISOString() } },
  };
}

export type OnboardingStatus = 'verified' | 'to-verify' | 'not-submitted';

export function onboardingStatus(reviewTasks: readonly Task[]): OnboardingStatus {
  if (reviewTasks.some((t) => t.status === 'completed')) return 'verified';
  if (reviewTasks.some((t) => !['completed', 'cancelled', 'rejected', 'entered-in-error'].includes(t.status))) return 'to-verify';
  return 'not-submitted';
}

// ---- Good-faith estimate (self-pay; No Surprises Act) ----

export const GFE_VERSION = 'gfe-2026-10';

export interface GoodFaithEstimate {
  readonly version: string;
  readonly appointmentId: string;
  readonly title: string;
  readonly amount: number;
  readonly body: string;
}

/**
 * The estimate a self-pay patient acknowledges before a visit. Wording is a PLACEHOLDER for the
 * practice and counsel; the price comes from the visit type's self-pay fee.
 */
export function goodFaithEstimate(appt: Appointment, type: VisitType, when: string): GoodFaithEstimate {
  const amount = type.selfPay;
  return {
    version: GFE_VERSION,
    appointmentId: appt.id as string,
    title: `Good-faith estimate: ${type.label}`,
    amount,
    body:
      `Good-faith estimate for ${type.label} (${type.minutes} minutes, by video) on ${when}. ` +
      `Expected charge: $${amount.toFixed(2)}, billed under code${type.codes.length > 1 ? 's' : ''} ${type.codes.join(', ')}. ` +
      'This estimate covers the visit itself; laboratory tests or other services ordered at the visit are billed separately. ' +
      'If the bill is $400 or more above this estimate, you may dispute it. Keep a copy of this estimate. ' +
      'This wording is a placeholder for the practice to replace with counsel-approved text.',
  };
}

export function estimateAcknowledged(consents: readonly Consent[], appointmentId: string): boolean {
  return consents.some((c) =>
    c.status === 'active' &&
    c.category?.some((x) => x.coding?.some((k) => k.system === CODE_SYSTEMS.consentType && k.code === 'good-faith-estimate')) &&
    c.provision?.data?.some((d) => d.reference.reference === `Appointment/${appointmentId}`)
  );
}
