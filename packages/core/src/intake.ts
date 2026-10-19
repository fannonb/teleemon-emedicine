// Portal intake wizard (X02): the questions, the consent documents patients e-sign, and how far a
// patient has got, so the wizard resumes where they stopped on any device.
//
// Consent wording is a PLACEHOLDER for the practice and counsel to replace before real use. Each
// document has a version: a signature records the version and a hash of the exact text shown.

import type { Consent, Coverage, Patient, QuestionnaireResponse } from '@medplum/fhirtypes';
import type { ConsentTypeCode } from './fhir';
import { CODE_SYSTEMS, EXT, TELEEMON_BASE } from './fhir';
import { cardOnFile, sexAtBirth } from './portal';

export const INTAKE_QUESTIONNAIRE_URL = `${TELEEMON_BASE}/Questionnaire/portal-intake`;

export interface IntakeQuestion {
  readonly linkId: string;
  readonly text: string;
  readonly type: 'string' | 'text' | 'boolean' | 'choice';
  readonly required?: boolean;
  readonly options?: readonly string[];
  /** Shown only when the named boolean question is answered yes. */
  readonly when?: string;
}

export interface IntakeSection {
  readonly key: string;
  readonly title: string;
  readonly questions: readonly IntakeQuestion[];
}

export const INTAKE_SECTIONS: readonly IntakeSection[] = [
  {
    key: 'reason',
    title: 'What brings you in',
    questions: [
      { linkId: 'reason', text: 'In your own words, what would you like help with?', type: 'text', required: true },
      { linkId: 'goals', text: 'What would you like to be different after treatment?', type: 'text' },
    ],
  },
  {
    key: 'history',
    title: 'Health history',
    questions: [
      { linkId: 'current-medications', text: 'Medications you take now, with doses (include supplements)', type: 'text' },
      { linkId: 'allergies', text: 'Medication allergies and what happened', type: 'text' },
      { linkId: 'prior-treatment', text: 'Have you had mental health treatment before?', type: 'boolean', required: true },
      { linkId: 'prior-treatment-detail', text: 'Who treated you, when, and what helped or did not', type: 'text', when: 'prior-treatment' },
      { linkId: 'hospitalized', text: 'Have you ever been hospitalized for mental health?', type: 'boolean', required: true },
      { linkId: 'hospitalized-detail', text: 'When and where', type: 'text', when: 'hospitalized' },
      { linkId: 'medical-conditions', text: 'Medical conditions (for example thyroid, heart, seizures, pregnancy)', type: 'text' },
      { linkId: 'primary-care', text: 'Primary care clinician, if any', type: 'string' },
    ],
  },
  {
    key: 'life',
    title: 'Daily life',
    questions: [
      { linkId: 'substance-use', text: 'Alcohol, cannabis, nicotine or other substances: what and how often', type: 'text' },
      { linkId: 'living', text: 'Who do you live with?', type: 'string' },
      { linkId: 'work-school', text: 'Work or school', type: 'string' },
      { linkId: 'supports', text: 'Who supports you?', type: 'string' },
    ],
  },
];

export const INTAKE_QUESTIONS = INTAKE_SECTIONS.flatMap((s) => s.questions);

export type IntakeAnswers = Record<string, string | boolean | undefined>;

export function intakeAnswers(qr: QuestionnaireResponse | undefined): IntakeAnswers {
  const out: IntakeAnswers = {};
  for (const item of qr?.item ?? []) {
    const a = item.answer?.[0];
    out[item.linkId] = a?.valueBoolean ?? a?.valueString ?? a?.valueCoding?.code;
  }
  return out;
}

export function intakeItems(answers: IntakeAnswers): NonNullable<QuestionnaireResponse['item']> {
  return INTAKE_QUESTIONS.filter((q) => answers[q.linkId] !== undefined && answers[q.linkId] !== '' && (!q.when || answers[q.when] === true)).map((q) => {
    const v = answers[q.linkId];
    return { linkId: q.linkId, text: q.text, answer: [typeof v === 'boolean' ? { valueBoolean: v } : { valueString: String(v).slice(0, 4000) }] };
  });
}

export function missingIntakeAnswers(answers: IntakeAnswers, section?: string): IntakeQuestion[] {
  const questions = section ? INTAKE_SECTIONS.find((s) => s.key === section)?.questions ?? [] : INTAKE_QUESTIONS;
  return questions.filter((q) => q.required && (!q.when || answers[q.when] === true) && (answers[q.linkId] === undefined || answers[q.linkId] === ''));
}

// ---- Consents signed in the portal ----

export interface ConsentDocument {
  readonly type: ConsentTypeCode;
  readonly version: string;
  readonly title: string;
  readonly body: string;
  /** A parent or guardian with limited proxy access may sign only these. */
  readonly proxyLimitedMaySign: boolean;
  /** Required only while the patient takes a controlled medication. */
  readonly onlyWhenControlled?: boolean;
}

const PLACEHOLDER = 'This wording is a placeholder for the practice to replace with counsel-approved text.';

export const PORTAL_CONSENTS: readonly ConsentDocument[] = [
  {
    type: 'treatment', version: 'treatment-2026-10', title: 'Consent to treatment', proxyLimitedMaySign: false,
    body: `I agree to receive psychiatric evaluation and treatment from Teleemon, which may include medication management and psychotherapy. Treatment has benefits and risks, and I can ask questions or stop at any time. In an emergency I will call 911 or 988, or go to the nearest emergency department; Teleemon does not provide emergency services. ${PLACEHOLDER}`,
  },
  {
    type: 'telehealth', version: 'telehealth-2026-10', title: 'Telehealth consent', proxyLimitedMaySign: false,
    body: `I agree to receive care by secure video or phone. I will be physically located in a state where my provider is licensed at the time of each visit and will confirm my location at check-in. I understand technology can fail and that a visit may need to be rescheduled or moved to phone. ${PLACEHOLDER}`,
  },
  {
    type: 'recording', version: 'recording-2026-10', title: 'Recording and AI scribe consent', proxyLimitedMaySign: false,
    body: `I agree that my provider may record the audio of visits so a secure AI assistant can draft visit notes for my provider to review. I will be asked again at the start of each recorded visit and can say no at any time without affecting my care. Recordings are deleted on a schedule set by the practice. ${PLACEHOLDER}`,
  },
  {
    type: 'financial', version: 'financial-2026-10', title: 'Financial policy', proxyLimitedMaySign: true,
    body: `I am responsible for charges not paid by insurance, including copays, deductibles and self-pay fees. Cancellations within 24 hours of a visit, and missed visits, may be charged a fee. I authorize Teleemon to charge my card on file for balances after each visit. ${PLACEHOLDER}`,
  },
  {
    type: 'privacy-notice', version: 'privacy-notice-2026-10', title: 'Notice of privacy practices (acknowledgment)', proxyLimitedMaySign: true,
    body: `I acknowledge that I have been offered Teleemon's Notice of Privacy Practices, which explains how my health information may be used and shared and my rights, including access to my records. ${PLACEHOLDER}`,
  },
  {
    type: 'controlled-substance', version: 'controlled-substance-2026-10', title: 'Controlled-substance agreement', proxyLimitedMaySign: false, onlyWhenControlled: true,
    body: `I agree to take controlled medications only as prescribed, from one prescriber and one pharmacy, and to keep them secure. I will not share them, and I will tell my provider about any other controlled medications or substances I use. Early refills are not given for lost or stolen medication without a police report. My provider will check the state prescription monitoring program and may ask for drug screening. Not following this agreement may lead to the medication being tapered or stopped. ${PLACEHOLDER}`,
  },
];

/** The consents a patient must have signed: the controlled-substance agreement only while on a controlled medication. */
export function requiredPortalConsents(onControlled: boolean): ConsentDocument[] {
  return PORTAL_CONSENTS.filter((d) => !d.onlyWhenControlled || onControlled);
}

export const findConsentDocument = (type: string, version?: string): ConsentDocument | undefined =>
  PORTAL_CONSENTS.find((d) => d.type === type && (!version || d.version === version));

export function signedPortalConsent(consents: readonly Consent[], doc: ConsentDocument): Consent | undefined {
  return consents.find((c) =>
    c.status === 'active' &&
    c.category?.some((x) => x.coding?.some((k) => k.system === CODE_SYSTEMS.consentType && k.code === doc.type)) &&
    (!c.provision?.period?.end || Date.parse(c.provision.period.end) > Date.now())
  );
}

// ---- Progress (save and resume) ----

export type IntakeStep = 'about' | 'insurance' | 'history' | 'measures' | 'consents' | 'payment' | 'review';

export const INTAKE_STEPS: readonly { key: IntakeStep; label: string }[] = [
  { key: 'about', label: 'About you' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'history', label: 'Health history' },
  { key: 'measures', label: 'Questionnaires' },
  { key: 'consents', label: 'Consents' },
  { key: 'payment', label: 'Payment' },
  { key: 'review', label: 'Review' },
];

export interface IntakeState {
  readonly patient: Patient;
  readonly intake?: QuestionnaireResponse;
  readonly coverages: readonly Coverage[];
  readonly consents: readonly Consent[];
  /** Measure keys still to complete for the next visit. */
  readonly measuresDue: readonly string[];
  /** The patient takes a controlled medication (controlled-substance agreement required). */
  readonly onControlled?: boolean;
  /** Self-pay with an upcoming visit whose good-faith estimate has not been acknowledged. */
  readonly estimateNeeded?: boolean;
}

export function aboutComplete(p: Patient): boolean {
  const hasPhone = !!p.telecom?.some((t) => t.system === 'phone' && t.value);
  const hasAddress = !!p.address?.some((a) => a.line?.length && a.city && a.state && a.postalCode);
  const hasEmergency = !!p.contact?.some((c) => c.relationship?.some((r) => r.coding?.some((x) => x.code === 'C' || x.code === 'GUARD')) && c.telecom?.some((t) => t.value));
  return hasPhone && hasAddress && hasEmergency && !!sexAtBirth(p);
}

export function stepDone(step: IntakeStep, s: IntakeState): boolean {
  switch (step) {
    case 'about':
      return aboutComplete(s.patient);
    case 'insurance':
      if (s.patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true)) return !s.estimateNeeded;
      return s.coverages.length > 0;
    case 'history':
      return !!s.intake && missingIntakeAnswers(intakeAnswers(s.intake)).length === 0;
    case 'measures':
      return s.measuresDue.length === 0;
    case 'consents':
      return requiredPortalConsents(!!s.onControlled).every((d) => signedPortalConsent(s.consents, d));
    case 'payment':
      return !!cardOnFile(s.patient);
    case 'review':
      return s.intake?.status === 'completed';
  }
}

/** The first step still to do, so the wizard resumes there. */
export function resumeStep(s: IntakeState): IntakeStep {
  return INTAKE_STEPS.find((step) => !stepDone(step.key, s))?.key ?? 'review';
}
