// Patient portal configuration (Phase 7, ADR-012; SYSTEM-DESIGN.md §5.2). Applied by
// `npm run setup -- --portal-only` (and the full setup).
//
// Patients and proxies sign in through the portal ClientApplication. Their policies are
// parameterized: %patient is the patient's own profile, or for a proxy the patient named on the
// membership. Reads are limited to that patient's compartment. Writes that carry rules (booking,
// cancelling, check-in, e-signatures, card on file) go through the portal service; the direct
// writes allowed here are guarded by policy constraints and the pre-commit Bots.

import type { AccessPolicy, AccessPolicyResource, ResourceType } from '@medplum/fhirtypes';
import { CODE_SYSTEMS } from '@teleemon/core';

type Rule = AccessPolicyResource;

const READ: Rule['interaction'] = ['read', 'vread', 'search'];
const CREATE: Rule['interaction'] = ['read', 'vread', 'search', 'create'];
const WRITE: Rule['interaction'] = ['read', 'vread', 'search', 'create', 'update'];
const COMM = CODE_SYSTEMS.communicationCategory;
const readonly = (...types: ResourceType[]): Rule[] => types.map((resourceType) => ({ resourceType, readonly: true }));

/** Appointments without staff comments or extensions: the telehealth link is released only after check-in. */
const APPOINTMENTS: Rule = { resourceType: 'Appointment', criteria: 'Appointment?patient=%patient', interaction: READ, hiddenFields: ['extension', 'comment'] };
const PRACTITIONERS: Rule = { resourceType: 'Practitioner', interaction: READ, hiddenFields: ['qualification', 'identifier', 'telecom', 'address', 'birthDate'] };

/** Everything a patient sees and does directly; also what a parent or guardian with full access gets. */
function patientResources(): Rule[] {
  return [
    // Contact details only: the Patient pre-commit Bot refuses changes to anything else.
    { resourceType: 'Patient', criteria: 'Patient?_id=%patient.id', interaction: ['read', 'vread', 'search', 'update'] },
    { resourceType: 'RelatedPerson', criteria: 'RelatedPerson?patient=%patient', interaction: READ },
    APPOINTMENTS,
    PRACTITIONERS,
    // Released documents only: after-visit summaries. Files follow their document (Binary.securityContext).
    { resourceType: 'DocumentReference', criteria: `DocumentReference?patient=%patient&category=${CODE_SYSTEMS.documentCategory}|after-visit-summary`, interaction: READ },
    // Insurance card photos the patient uploads: their own id-insurance documents, preliminary until
    // staff check them. Staff-entered cards are readable but not editable. The document Bot checks content.
    {
      resourceType: 'DocumentReference', criteria: `DocumentReference?patient=%patient&category=${CODE_SYSTEMS.documentCategory}|id-insurance`, interaction: WRITE,
      writeConstraint: [{ language: 'text/fhirpath', expression: "%after.docStatus = 'preliminary' and (%before.exists().not() or %before.docStatus = 'preliminary')" }],
    },
    // Files follow their document (Binary.securityContext): readable and uploadable only for the documents above.
    { resourceType: 'Binary', interaction: CREATE },
    { resourceType: 'Communication', criteria: `Communication?subject=%patient&category=${COMM}|portal-message,${COMM}|portal-reply`, interaction: CREATE },
    // Intake and measures: answers can be saved and resumed, and are locked once submitted.
    {
      resourceType: 'QuestionnaireResponse', criteria: 'QuestionnaireResponse?subject=%patient', interaction: WRITE,
      writeConstraint: [{ language: 'text/fhirpath', expression: "%before.exists().not() or %before.status = 'in-progress'" }],
    },
    { resourceType: 'Questionnaire', interaction: READ },
    { resourceType: 'Consent', criteria: 'Consent?patient=%patient', interaction: READ },
    // Insurance the patient enters stays a draft until staff verify it.
    {
      resourceType: 'Coverage', criteria: 'Coverage?beneficiary=%patient', interaction: WRITE,
      writeConstraint: [{ language: 'text/fhirpath', expression: "%after.status = 'draft' and (%before.exists().not() or %before.status = 'draft')" }],
    },
    { resourceType: 'MedicationStatement', criteria: 'MedicationStatement?subject=%patient', interaction: READ },
    // Statements (X08). Amounts owed come from the ledger through the portal service.
    { resourceType: 'Invoice', criteria: 'Invoice?subject=%patient&status=issued', interaction: READ },
    { resourceType: 'MedicationRequest', criteria: 'MedicationRequest?subject=%patient', interaction: READ, hiddenFields: ['extension', 'note'] },
    { resourceType: 'Task', criteria: `Task?patient=%patient&code=${CODE_SYSTEMS.taskCode}|rx-renewal`, interaction: CREATE, hiddenFields: ['note'] },
  ];
}

export const PORTAL_POLICY_NAMES = {
  patient: 'Teleemon Patient',
  proxy: 'Teleemon Proxy',
  proxyLimited: 'Teleemon Proxy (limited)',
} as const;

export const PORTAL_POLICIES: AccessPolicy[] = [
  { resourceType: 'AccessPolicy', name: PORTAL_POLICY_NAMES.patient, resource: patientResources() },
  { resourceType: 'AccessPolicy', name: PORTAL_POLICY_NAMES.proxy, resource: patientResources() },
  {
    // A minor who controls their own mental-health records (proxyLevel 'limited'): the parent or
    // guardian sees scheduling, demographics and insurance, and nothing clinical.
    resourceType: 'AccessPolicy',
    name: PORTAL_POLICY_NAMES.proxyLimited,
    resource: [
      { resourceType: 'Patient', criteria: 'Patient?_id=%patient.id', interaction: READ, hiddenFields: ['extension', 'contact', 'generalPractitioner'] },
      { resourceType: 'RelatedPerson', criteria: 'RelatedPerson?_id=%profile.id', interaction: READ },
      APPOINTMENTS,
      PRACTITIONERS,
      { resourceType: 'Coverage', criteria: 'Coverage?beneficiary=%patient', interaction: READ },
    ],
  },
];

/**
 * The portal service (services/portal): public booking and the portal writes that carry rules.
 * It reads schedules to offer free times without exposing anyone's appointments, and never reads
 * clinical notes, measures or documents.
 */
export const PORTAL_SERVICE_POLICY: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Teleemon Service: portal',
  resource: [
    ...readonly('Practitioner', 'Schedule', 'Slot', 'RelatedPerson', 'MedicationRequest'),
    { resourceType: 'Basic', criteria: `Basic?code=${CODE_SYSTEMS.portal}|invitation`, interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'Basic', readonly: true },
    { resourceType: 'Patient', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'Appointment', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'Consent', interaction: ['read', 'search', 'create'] },
    { resourceType: 'Invoice', interaction: ['read', 'search'] },
    { resourceType: 'Task', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'Communication', criteria: `Communication?category=${COMM}|portal-reply`, interaction: ['read', 'search', 'update'] },
    // Only to see whether new-patient forms were submitted (reminders) and which visit an estimate covers.
    ...readonly('QuestionnaireResponse'),
  ],
};

/**
 * Portal accounts: creates a patient's or proxy's sign-in when they open their invitation, and keeps
 * each proxy on the policy their patient's age and state allow. Medplum lets only project
 * administrators create logins for existing profiles, so this client is an administrator restricted
 * to these reads. It is used only by the invitation and proxy-review code paths, and must run as a
 * separate internal workload in production (ADR-012).
 */
export const PORTAL_ACCOUNTS_POLICY: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Teleemon Service: portal accounts',
  resource: readonly('Patient', 'RelatedPerson', 'AccessPolicy'),
};

/** Public client for the portal app (PKCE, no secret). */
export const PORTAL_CLIENT_NAME = 'Teleemon patient portal';
