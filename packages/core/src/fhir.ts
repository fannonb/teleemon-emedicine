// Teleemon FHIR conventions (SYSTEM-DESIGN.md §4.1). Shared by the apps, Bots and scripts,
// so keep this file free of browser-only and Node-only imports.

export const TELEEMON_BASE = 'https://fhir.teleemon.com';

/** Identifier system for records created by scripts/seed.ts (synthetic data only). */
export const SEED_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/seed`;

/** Practice chart number (MRN) assigned at registration. */
export const MRN_SYSTEM = `${TELEEMON_BASE}/identifier/mrn`;
/** Stable identifiers for server-derived scores, alerts and monitoring tasks. */
export const DERIVED_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/derived`;

export const EXT = {
  /** valueCode: 'video' | 'phone' | 'office'. On Appointment and Encounter. */
  modality: `${TELEEMON_BASE}/StructureDefinition/visit-modality`,
  /** valueCode: two-letter US state where the patient is physically located for this visit. */
  patientLocationState: `${TELEEMON_BASE}/StructureDefinition/patient-location-state`,
  /** valueString: pronouns as the patient states them, e.g. "she/her". On Patient. */
  pronouns: `${TELEEMON_BASE}/StructureDefinition/pronouns`,
  /** valueCodeableConcept: gender identity. On Patient. */
  genderIdentity: `${TELEEMON_BASE}/StructureDefinition/gender-identity`,
  /** valueCode: sex assigned at birth (male | female | unknown). On Patient. */
  sexAssignedAtBirth: `${TELEEMON_BASE}/StructureDefinition/sex-assigned-at-birth`,
  /** valueCodeableConcept: sexual orientation, including "declined". On Patient. */
  sexualOrientation: `${TELEEMON_BASE}/StructureDefinition/sexual-orientation`,
  /** valueString: employment status as the patient describes it. On Patient. */
  employmentStatus: `${TELEEMON_BASE}/StructureDefinition/employment-status`,
  /** valueString: where the patient heard about the practice. On Patient. */
  referralSource: `${TELEEMON_BASE}/StructureDefinition/referral-source`,
  /** valueReference(Practitioner|PractitionerRole) or valueIdentifier (NPI) of the referring clinician. On Patient. */
  referringClinician: `${TELEEMON_BASE}/StructureDefinition/referring-clinician`,
  /** valueString (reason). Set by an administrator to save a record the duplicate check flagged. On Patient. */
  duplicateOverride: `${TELEEMON_BASE}/StructureDefinition/duplicate-override`,
  /** valueBoolean on Patient.contact: staff confirmed this guardian's authority. */
  guardianAuthority: `${TELEEMON_BASE}/StructureDefinition/guardian-authority-confirmed`,
  /** valueCode: channel the patient has opted out of ('sms' | 'email' | 'voice'). Repeats. On Patient. */
  contactOptOut: `${TELEEMON_BASE}/StructureDefinition/contact-opt-out`,
  /** valueBoolean: patient pays out of pocket (no insurance billed). On Patient. */
  selfPay: `${TELEEMON_BASE}/StructureDefinition/self-pay`,
  /** valueCode: DEA controlled-substance schedule ('2'..'5'). On MedicationStatement/MedicationRequest. */
  controlledSchedule: `${TELEEMON_BASE}/StructureDefinition/controlled-schedule`,
  /** valueCode: how a consent was captured ('portal-esignature' | 'verbal-recorded' | 'paper-scan' | 'in-person'). On Consent. */
  consentMethod: `${TELEEMON_BASE}/StructureDefinition/consent-method`,
  /** valueString: why a consent was withdrawn. On Consent. */
  revocationReason: `${TELEEMON_BASE}/StructureDefinition/revocation-reason`,
  /** valueDateTime: when a consent was revoked, independent of the original signature date. */
  revokedAt: `${TELEEMON_BASE}/StructureDefinition/consent-revoked-at`,
  /** valueString: the provider's summary when closing a safety flag. On Flag. */
  reviewNote: `${TELEEMON_BASE}/StructureDefinition/review-note`,
  /** valueString: why staff booked over an existing appointment or blocked time (P04/P05). On Appointment. */
  overbookReason: `${TELEEMON_BASE}/StructureDefinition/overbook-reason`,
  /** valueUrl: telehealth join link from the external platform. On Appointment. */
  telehealthUrl: `${TELEEMON_BASE}/StructureDefinition/telehealth-url`,
  /** valueString: reference of the auto-created Google Meet space or calendar event (no PHI). On Appointment. */
  meetSpace: `${TELEEMON_BASE}/StructureDefinition/meet-space`,
  /** valueDateTime: when Teleemon created the meeting link automatically. On Appointment. */
  meetProvisionedAt: `${TELEEMON_BASE}/StructureDefinition/meet-provisioned-at`,
  /** valueDateTime: when the patient confirmed by replying to a reminder. On Appointment. */
  confirmedAt: `${TELEEMON_BASE}/StructureDefinition/confirmed-at`,
  /** valueString (JSON): settings payload on a Basic settings resource (P38, P42). */
  settingsJson: `${TELEEMON_BASE}/StructureDefinition/settings-json`,
  /** valueCode: 'sms' | 'email'. Channel of a reminder Communication. On Communication. */
  channel: `${TELEEMON_BASE}/StructureDefinition/channel`,
  /** valueCode: DEA schedules covered by a registration ('2','2N','3','3N','4','5'). Repeats. On Practitioner.qualification. */
  deaSchedule: `${TELEEMON_BASE}/StructureDefinition/dea-schedule`,
  /** valueBoolean: the licence includes prescriptive authority. On Practitioner.qualification. */
  prescriptiveAuthority: `${TELEEMON_BASE}/StructureDefinition/prescriptive-authority`,
  /** valueString (JSON NoteData): structured note content for editing and server validation. On Composition. */
  noteData: `${TELEEMON_BASE}/StructureDefinition/note-data`,
  /** valueBoolean: signed more than 72 hours after the visit started. On Composition. */
  lateEntry: `${TELEEMON_BASE}/StructureDefinition/late-entry`,
  /** valueString: why an addendum or correction was made. On Composition. */
  amendmentReason: `${TELEEMON_BASE}/StructureDefinition/amendment-reason`,
  /** valueBoolean: content was drafted by AI and reviewed by the provider. On Composition. */
  aiAssisted: `${TELEEMON_BASE}/StructureDefinition/ai-assisted`,
  /** valueCode: e-prescribing transmission state on MedicationRequest ('queued' | 'sending' | 'sent' | 'failed' | 'cancel-requested' | 'cancelled'). Only the worker sets sending/sent/failed/cancelled. */
  erxStatus: `${TELEEMON_BASE}/StructureDefinition/erx-status`,
  /** valueString: last vendor error for a failed transmission. On MedicationRequest. */
  erxError: `${TELEEMON_BASE}/StructureDefinition/erx-error`,
  /** valueString: pharmacy chosen for the prescription (name, address or NCPDP ID until the vendor directory is connected). */
  pharmacy: `${TELEEMON_BASE}/StructureDefinition/pharmacy`,
  /** valueReference(Task): the PDMP check relied on for a controlled prescription. On MedicationRequest. */
  pdmpCheck: `${TELEEMON_BASE}/StructureDefinition/pdmp-check`,
  /** valueCode: PDMP review result ('no-concerns' | 'concerns-discussed' | 'not-prescribing'). On a pdmp-check Task. */
  pdmpResult: `${TELEEMON_BASE}/StructureDefinition/pdmp-result`,
  /** valueCode: recurrence of a task ('daily' | 'weekly' | 'every-2-weeks' | 'monthly' | 'quarterly'). On Task. */
  recurrence: `${TELEEMON_BASE}/StructureDefinition/recurrence`,
  /** Complex (by: Reference, at: dateTime): the person who confirmed which patient a document or message belongs to. */
  matchConfirmed: `${TELEEMON_BASE}/StructureDefinition/match-confirmed`,
  /** valueString: why an item was removed from a queue (entered-in-error). Faxes and messages are never deleted. */
  removalReason: `${TELEEMON_BASE}/StructureDefinition/removal-reason`,
  /** valueString: OCR text of an inbound fax from the fax vendor; used for suggestions only. On DocumentReference. */
  faxText: `${TELEEMON_BASE}/StructureDefinition/fax-text`,
  /** valueString (JSON FaxSuggestion): suggested patient and category for an inbound fax. On DocumentReference. */
  faxSuggestion: `${TELEEMON_BASE}/StructureDefinition/fax-suggestion`,
  /** valueString: sender fax number or phone of an inbound item. On DocumentReference / Communication. */
  inboundFrom: `${TELEEMON_BASE}/StructureDefinition/inbound-from`,
  /** valueString: destination fax number of an outbound fax. On Communication. */
  faxTo: `${TELEEMON_BASE}/StructureDefinition/fax-to`,
  /** Complex (by: Reference, at: dateTime, abnormal: boolean, comment: string): provider review of a lab result. On DocumentReference. */
  resultReview: `${TELEEMON_BASE}/StructureDefinition/result-review`,
  /** valueString: private psychotherapy narrative, on an author-restricted DocumentReference only. */
  privatePsychotherapy: `${TELEEMON_BASE}/StructureDefinition/private-psychotherapy`,
  /** valueCode: how a visit was booked online ('online' = public booking page, 'portal' = signed-in patient). On Appointment. */
  bookingChannel: `${TELEEMON_BASE}/StructureDefinition/booking-channel`,
  /** valueDateTime: an unconfirmed online booking holds its time until then; the portal service releases it afterwards. On Appointment. */
  holdExpires: `${TELEEMON_BASE}/StructureDefinition/hold-expires`,
  /** Complex (by: Reference, at: dateTime, state: code): the patient or proxy confirmed where the patient is at check-in. On Appointment. */
  locationConfirmed: `${TELEEMON_BASE}/StructureDefinition/location-confirmed`,
  /** Complex (by: Reference, at: dateTime, state: code): the provider confirmed on camera where the patient is when the visit started. On Encounter. */
  providerLocationConfirmed: `${TELEEMON_BASE}/StructureDefinition/provider-location-confirmed`,
  /** valueString (JSON CardOnFile): card saved through the payment processor; never card numbers. Written by the portal service. On Patient. */
  cardOnFile: `${TELEEMON_BASE}/StructureDefinition/card-on-file`,
  /** valueString: preferred pharmacy as the patient enters it (name and address). On Patient. */
  preferredPharmacy: `${TELEEMON_BASE}/StructureDefinition/preferred-pharmacy`,
  /** valueString: version of the consent document that was e-signed, e.g. "treatment-2026-10". On Consent. */
  consentDocument: `${TELEEMON_BASE}/StructureDefinition/consent-document`,
  /** valueString: SHA-256 of the exact consent text shown when it was e-signed. On Consent. */
  consentTextHash: `${TELEEMON_BASE}/StructureDefinition/consent-text-hash`,
  /** valueDateTime: when the patient was told a portal reply is waiting (no content is sent). On Communication. */
  notifiedAt: `${TELEEMON_BASE}/StructureDefinition/notified-at`,
  /** valueDateTime: when a portal invitation link expires. On a portal invitation Basic. */
  inviteExpires: `${TELEEMON_BASE}/StructureDefinition/invite-expires`,
  /** valueDateTime: when a portal invitation link was used; links are single-use. On a portal invitation Basic. */
  inviteUsed: `${TELEEMON_BASE}/StructureDefinition/invite-used`,
  /** valueDateTime: when the patient was reminded to finish their new-patient forms before this visit. On Appointment. */
  intakeReminderSent: `${TELEEMON_BASE}/StructureDefinition/intake-reminder-sent`,
  /** valueReference(Appointment): the held online booking that this invitation confirms. On a portal invitation Basic. */
  inviteAppointment: `${TELEEMON_BASE}/StructureDefinition/invite-appointment`,
  /** valueString (JSON ScrubFinding[]): last claim scrub result, stored with the claim. On Claim. */
  scrubResult: `${TELEEMON_BASE}/StructureDefinition/scrub-result`,
  /** valueCode: claim lifecycle state (see CLAIM_TRANSITIONS in billing.ts). On Claim. */
  claimStatus: `${TELEEMON_BASE}/StructureDefinition/claim-status`,
  /** valueBoolean: the billing code was proposed by AI. Not billable until providerAccepted. On ChargeItem. */
  aiSuggested: `${TELEEMON_BASE}/StructureDefinition/ai-suggested`,
  /** valueBoolean: the provider accepted an AI-suggested billing code. On ChargeItem. */
  providerAccepted: `${TELEEMON_BASE}/StructureDefinition/provider-accepted`,
  /** valueString: a non-clinical explanation of a waitlist request. On Appointment. */
  waitlistNote: `${TELEEMON_BASE}/StructureDefinition/waitlist-note`,
} as const;

export const CODE_SYSTEMS = {
  documentCategory: `${TELEEMON_BASE}/CodeSystem/document-category`,
  consentType: `${TELEEMON_BASE}/CodeSystem/consent-type`,
  taskCode: `${TELEEMON_BASE}/CodeSystem/task-code`,
  flagCode: `${TELEEMON_BASE}/CodeSystem/flag-code`,
  qualificationType: `${TELEEMON_BASE}/CodeSystem/qualification-type`,
  measure: `${TELEEMON_BASE}/CodeSystem/measure`,
  communicationCategory: `${TELEEMON_BASE}/CodeSystem/communication-category`,
  visitType: `${TELEEMON_BASE}/CodeSystem/visit-type`,
  cancellationReason: `${TELEEMON_BASE}/CodeSystem/cancellation-reason`,
  settings: `${TELEEMON_BASE}/CodeSystem/settings`,
  noteTemplate: `${TELEEMON_BASE}/CodeSystem/note-template`,
  /** Portal records kept on Basic (code 'invitation'). */
  portal: `${TELEEMON_BASE}/CodeSystem/portal`,
  /** Billing codes and states kept on Claim, ChargeItem and remittance records (Phase 8). */
  billing: `${TELEEMON_BASE}/CodeSystem/billing`,
  /** Phase 9 operations queues, compliance checkpoints and local worker signals. */
  operations: `${TELEEMON_BASE}/CodeSystem/operations`,
} as const;

/** Identifier system for portal invitation links: the value is the SHA-256 of the link token, never the token. */
export const PORTAL_INVITATION_SYSTEM = `${TELEEMON_BASE}/identifier/portal-invitation`;

/** Prescription identifier assigned by the e-prescribing vendor (or the local mock adapter). */
export const ERX_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/erx`;

/** Claim identifier assigned by Teleemon; the value is also the 837 patient control number. */
export const CLAIM_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/claim`;

/** Identifier system for reminders and other records generated by Bots and the worker (idempotency keys). */
export const GENERATED_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/generated`;

/** Kept for existing imports. */
export const LICENSE_QUALIFICATION_SYSTEM = CODE_SYSTEMS.qualificationType;

/** US Core race and ethnicity extensions; Teleemon stores the patient's own words in the 'text' sub-extension. */
export const US_CORE_RACE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race';
export const US_CORE_ETHNICITY = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity';

export const ICD10CM_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-cm';
export const LOINC_SYSTEM = 'http://loinc.org';
export const RXNORM_SYSTEM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';

/** HL7 confidentiality and sensitivity labels used by AccessPolicies (SYSTEM-DESIGN.md §5.2). */
export const SECURITY = {
  confidentialitySystem: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
  /** Restricted chart (VIP, staff-as-patient): opening it requires a reason. */
  restricted: 'R',
  actCodeSystem: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  /** 42 CFR Part 2 substance use disorder information. Not enforced until decision D2. */
  part2: 'SUD',
} as const;

export type Modality = 'video' | 'phone' | 'office';

/** Practice time zone (Bellevue, WA). Appointments are stored in UTC and displayed in this zone. */
export const PRACTICE_TIME_ZONE = 'America/Los_Angeles';

/**
 * States where the provider holds a licence. Phase 2 replaces this constant with the licence
 * engine, which reads Practitioner qualifications and their expiry dates.
 */
export const LICENSED_STATES = ['WA', 'CA', 'CO', 'RI'] as const;

export const US_STATE_TIME_ZONES: Record<string, string> = {
  WA: 'America/Los_Angeles',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  RI: 'America/New_York',
  TX: 'America/Chicago',
};

export const DOCUMENT_CATEGORIES = [
  { code: 'intake', display: 'Intake forms' },
  { code: 'consent', display: 'Consents' },
  { code: 'id-insurance', display: 'ID and insurance cards' },
  { code: 'outside-records', display: 'Outside records' },
  { code: 'lab-report', display: 'Lab reports' },
  { code: 'letter', display: 'Letters' },
  { code: 'prior-authorization', display: 'Prior authorizations' },
  { code: 'school-work', display: 'School and work notes' },
  { code: 'legal', display: 'Legal' },
  { code: 'correspondence', display: 'Correspondence' },
  { code: 'billing', display: 'Billing' },
  { code: 'other', display: 'Other' },
  { code: 'after-visit-summary', display: 'After-visit summaries' },
  { code: 'visit-export', display: 'Visit note exports' },
] as const;

export type DocumentCategoryCode = (typeof DOCUMENT_CATEGORIES)[number]['code'];

export const CONSENT_TYPES = [
  { code: 'treatment', display: 'Consent to treatment', perSession: false },
  { code: 'telehealth', display: 'Telehealth consent', perSession: false },
  { code: 'recording', display: 'Recording and AI scribe consent', perSession: false },
  { code: 'recording-session', display: 'Session recording consent', perSession: true },
  { code: 'financial', display: 'Financial policy', perSession: false },
  { code: 'privacy-notice', display: 'Notice of privacy practices (acknowledgment)', perSession: false },
  { code: 'controlled-substance', display: 'Controlled-substance agreement', perSession: false },
  { code: 'roi', display: 'Release of information', perSession: false },
  { code: 'restriction', display: 'Restriction request (HIPAA right to restrict)', perSession: false },
  { code: 'good-faith-estimate', display: 'Good-faith estimate (acknowledgment)', perSession: true },
] as const;

export type ConsentTypeCode = (typeof CONSENT_TYPES)[number]['code'];
