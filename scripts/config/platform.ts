// Platform configuration as code: role AccessPolicies and the Bot registry
// (SYSTEM-DESIGN.md §5.2 and §6). `npm run setup` applies this idempotently.

import type { AccessPolicy, AccessPolicyResource, ResourceType } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from '@teleemon/core';

type Rule = AccessPolicyResource;

// Roles never hard-delete records (SYSTEM-DESIGN.md §4.3): status changes only.
const NO_DELETE: Rule['interaction'] = ['read', 'vread', 'search', 'history', 'create', 'update'];
const write = (...types: ResourceType[]): Rule[] => types.map((resourceType) => ({ resourceType, interaction: NO_DELETE }));
/** Append-only: the role can add an AuditEvent (e.g. a restricted-chart access reason) but never read or change one. */
const AUDIT_APPEND: Rule = { resourceType: 'AuditEvent', interaction: ['create'] };
const read = (...types: ResourceType[]): Rule[] => types.map((resourceType) => ({ resourceType, readonly: true }));
const CLIENT_IDENTITY: Rule = { resourceType: 'ClientApplication', interaction: ['read'], hiddenFields: ['secret', 'retiringSecret'] };

/**
 * Only administrators may add a duplicate-override reason to a Patient (P08). Non-admins can keep
 * an existing one when editing the record, but cannot create or change it.
 */
const PATIENT_NO_OVERRIDE: Rule = {
  resourceType: 'Patient',
  interaction: NO_DELETE,
  writeConstraint: [
    {
      language: 'text/fhirpath',
      expression:
        `%after.extension.where(url = '${EXT.duplicateOverride}').exists().not() or ` +
        `%after.extension.where(url = '${EXT.duplicateOverride}').value = %before.extension.where(url = '${EXT.duplicateOverride}').value`,
    },
  ],
};

/**
 * Signed notes are immutable (P23): a provider can create or edit a draft, never change a final
 * note. The note-rules Bot enforces the same rule for every principal, including admins.
 */
const COMPOSITION_DRAFTS_ONLY: Rule = {
  resourceType: 'Composition',
  interaction: NO_DELETE,
  writeConstraint: [{ language: 'text/fhirpath', expression: "%before.exists().not() or %before.status = 'preliminary'" }],
};

/**
 * Providers queue prescriptions and request cancellation; only the e-prescribing worker may
 * record that a prescription was sent, failed or cancelled at the pharmacy (P25).
 */
const ERX = `extension.where(url = '${EXT.erxStatus}').value`;
const MEDICATION_REQUEST_QUEUE_ONLY: Rule = {
  resourceType: 'MedicationRequest',
  interaction: NO_DELETE,
  writeConstraint: [
    {
      language: 'text/fhirpath',
      expression: `%after.${ERX}.exists().not() or %after.${ERX} = 'queued' or %after.${ERX} = 'cancel-requested' or (%before.exists() and %after.${ERX} = %before.${ERX})`,
    },
  ],
};

// Basic holds practice settings (hours, closures, reminder rules); roles read them, admins change them.
const REFERENCE_DATA = read('Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Schedule', 'Questionnaire', 'ValueSet', 'CodeSystem', 'Basic');

export const POLICY_NAMES = {
  provider: 'Teleemon Provider',
  frontdesk: 'Teleemon Front desk',
  biller: 'Teleemon Biller',
} as const;

export const ACCESS_POLICIES: AccessPolicy[] = [
  {
    resourceType: 'AccessPolicy',
    name: POLICY_NAMES.provider,
    resource: [
      PATIENT_NO_OVERRIDE,
      COMPOSITION_DRAFTS_ONLY,
      MEDICATION_REQUEST_QUEUE_ONLY,
      ...write(
        'RelatedPerson', 'Coverage', 'Appointment', 'Slot', 'Encounter',
        'Condition', 'MedicationStatement', 'AllergyIntolerance', 'Observation',
        'QuestionnaireResponse', 'ClinicalImpression', 'DiagnosticReport', 'ServiceRequest',
        'Flag', 'Consent', 'Binary', 'Media', 'Communication', 'CommunicationRequest',
        'Task', 'Provenance'
      ),
      // Billing work (P30–P36, practice decision 18 Oct 2026): providers review charges, build and
      // submit claims, and work remittances and denials like billers. The charge-rules and
      // claim-rules Bots still enforce every billing rule; only a charge's rendering provider can
      // accept its AI-suggested codes. Payers, fees and policy (P40) stay admin and biller only.
      ...write('ChargeItem', 'Claim', 'ClaimResponse', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse', 'Account', 'Invoice', 'PaymentNotice', 'PaymentReconciliation'),
      ...read('ExplanationOfBenefit'),
      { resourceType: 'DocumentReference', interaction: NO_DELETE, criteria: `DocumentReference?category:not=${CODE_SYSTEMS.documentCategory}|private-psychotherapy` },
      { resourceType: 'DocumentReference', interaction: NO_DELETE, criteria: `DocumentReference?category=${CODE_SYSTEMS.documentCategory}|private-psychotherapy&author=%profile` },
      AUDIT_APPEND,
      ...REFERENCE_DATA,
    ],
  },
  {
    // Registration, scheduling, documents and messages. No clinical notes, problems, measures or
    // labs: those requests are refused by the server, not just hidden in the UI.
    resourceType: 'AccessPolicy',
    name: POLICY_NAMES.frontdesk,
    resource: [
      PATIENT_NO_OVERRIDE,
      ...write(
        'RelatedPerson', 'Coverage', 'Appointment', 'Slot', 'Consent', 'Binary',
        'Communication', 'CommunicationRequest', 'AllergyIntolerance', 'MedicationStatement'
      ),
      {
        resourceType: 'Task', interaction: NO_DELETE,
        writeConstraint: [{ language: 'text/fhirpath', expression:
          `%after.code.coding.where(system = '${CODE_SYSTEMS.taskCode}' and code = 'pdmp-check').exists().not() and %before.code.coding.where(system = '${CODE_SYSTEMS.taskCode}' and code = 'pdmp-check').exists().not() and ` +
          `(%after.code.coding.where(system = '${CODE_SYSTEMS.taskCode}' and code = 'rx-renewal').exists().not() or (%after.status != 'completed' and %after.status != 'rejected' and %after.status != 'cancelled'))` }],
      },
      AUDIT_APPEND,
      // Scribe transcripts (Phase 4) are clinical and excluded. Front desk files faxed results but
      // never records the clinical review of one (P16).
      {
        resourceType: 'DocumentReference',
        interaction: NO_DELETE,
        criteria: `DocumentReference?category:not=${CODE_SYSTEMS.documentCategory}|transcript&category:not=${CODE_SYSTEMS.documentCategory}|private-psychotherapy`,
        writeConstraint: [{ language: 'text/fhirpath', expression: `%after.extension.where(url = '${EXT.resultReview}').exists().not() or (%before.exists() and %before.extension.where(url = '${EXT.resultReview}').exists())` }],
      },
      // Eligibility (P32): front desk checks coverage before visits and reads the payer's answer.
      // It creates the 270 request but never the 271 response (the worker records that).
      { resourceType: 'CoverageEligibilityRequest', interaction: ['read', 'search', 'create'] },
      { resourceType: 'CoverageEligibilityResponse', interaction: ['read', 'search'] },
      ...read('Encounter', 'ServiceRequest'),
      ...REFERENCE_DATA,
    ],
  },
  {
    resourceType: 'AccessPolicy',
    name: POLICY_NAMES.biller,
    resource: [
      ...write(
        'Coverage', 'CoverageEligibilityRequest', 'CoverageEligibilityResponse', 'Claim', 'ClaimResponse',
        'ChargeItem', 'Account', 'Invoice', 'PaymentNotice', 'PaymentReconciliation', 'Task', 'Communication', 'Binary'
      ),
      AUDIT_APPEND,
      {
        resourceType: 'DocumentReference',
        interaction: NO_DELETE,
        criteria: `DocumentReference?category=${CODE_SYSTEMS.documentCategory}|billing,${CODE_SYSTEMS.documentCategory}|prior-authorization,${CODE_SYSTEMS.documentCategory}|id-insurance`,
      },
      ...read('Patient', 'RelatedPerson', 'Encounter', 'Appointment', 'Condition', 'PaymentReconciliation', 'ExplanationOfBenefit'),
      // Payers, fees, scrub rules and billing policy (P40); other settings stay read-only.
      { resourceType: 'Basic', interaction: NO_DELETE, criteria: `Basic?identifier=${CODE_SYSTEMS.settings}|billing` },
      ...REFERENCE_DATA,
    ],
  },
];

// Operational control records are administrator/worker data, not ordinary clinical tasks.
// Apply at the server so direct Task reads/searches cannot bypass P44/P45 visibility.
for (const policy of ACCESS_POLICIES) {
  for (const rule of policy.resource ?? []) {
    if (rule.resourceType !== 'Task') continue;
    // Plain text, not URL-encoded: Medplum validates policy criteria as `Type?param=value&...`.
    const exclusion = `code:not=${CODE_SYSTEMS.operations}|integration-health&code:not=${CODE_SYSTEMS.operations}|compliance-checkpoint`;
    rule.criteria = `${rule.criteria ?? 'Task?'}${rule.criteria ? '&' : ''}${exclusion}`;
  }
}

export interface BotDef {
  /** File name in bots/src without extension. */
  readonly file: string;
  readonly name: string;
  /** Earlier names of the same Bot, so a rename updates it instead of creating a second one. */
  readonly formerNames?: string[];
  readonly description: string;
  /** Subscription criteria. Omitted for Bots that are run on demand (e.g. by the worker's clock). */
  readonly criteria?: string;
  readonly preCommit: boolean;
  readonly policy: AccessPolicy;
}

export const BOTS: BotDef[] = [
  {
    file: 'measure-validation', name: 'Teleemon: measure validation',
    description: 'Pre-commit. Requires complete, valid answers before a Teleemon measure is marked completed.',
    criteria: 'QuestionnaireResponse', preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: measure validation', resource: read('QuestionnaireResponse') },
  },
  {
    file: 'diagnosis-validation', name: 'Teleemon: diagnosis validation',
    description: 'Pre-commit. Validates catalogue codes and refuses duplicate unresolved diagnoses.',
    criteria: 'Condition', preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: diagnosis validation', resource: read('Condition') },
  },
  {
    file: 'medication-monitoring', name: 'Teleemon: medication monitoring',
    description: 'Ensures a monitoring task for active medications that require labs, including direct API entries.',
    criteria: 'MedicationStatement', preCommit: false,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: medication monitoring', resource: [...read('Patient', 'MedicationStatement'), ...write('Task')] },
  },
  {
    file: 'duplicate-patient',
    name: 'Teleemon: duplicate patient check',
    description: 'Pre-commit. Assigns the chart number; rejects a Patient that matches an existing record unless it carries an override reason (only admins can add one).',
    criteria: 'Patient',
    preCommit: true,
    policy: {
      resourceType: 'AccessPolicy',
      name: 'Teleemon Bot: duplicate patient check',
      resource: read('Patient'),
    },
  },
  {
    file: 'measure-scoring',
    name: 'Teleemon: measure scoring and safety alerts',
    description: 'Scores completed measures; a positive safety item creates a Flag and an urgent Task.',
    criteria: 'QuestionnaireResponse',
    preCommit: false,
    policy: {
      resourceType: 'AccessPolicy',
      name: 'Teleemon Bot: measure scoring',
      resource: [...read('Patient', 'QuestionnaireResponse'), ...write('Observation', 'Flag', 'Task')],
    },
  },
];

BOTS.push(
  {
    file: 'audit-rules',
    name: 'Teleemon: audit rules',
    description: 'Pre-commit. Audit events are append-only, including for administrators; corrections are new events.',
    criteria: 'AuditEvent',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: audit rules', resource: read('AuditEvent') },
  },
  {
    file: 'appointment-rules',
    name: 'Teleemon: appointment rules',
    description: 'Pre-commit. Booking requires a valid licence for the patient location and no overlap with appointments or blocked time, unless overbooked with a reason.',
    criteria: 'Appointment',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: appointment rules', resource: [...read('Appointment', 'Practitioner', 'Schedule', 'Slot', 'Basic', 'RelatedPerson'), CLIENT_IDENTITY] },
  },
  {
    file: 'reminder-scheduler',
    name: 'Teleemon: reminder scheduler',
    description: 'Run by the worker every few minutes. Queues due appointment reminders as Communications (idempotent).',
    preCommit: false,
    policy: {
      resourceType: 'AccessPolicy',
      name: 'Teleemon Bot: reminder scheduler',
      resource: [...read('Appointment', 'Patient', 'Basic'), { resourceType: 'Communication', interaction: ['read', 'search', 'create'] }],
    },
  }
);

BOTS.push(
  {
    file: 'note-rules',
    name: 'Teleemon: note rules',
    description: 'Pre-commit. Signed notes are locked; signing requires attestation and a complete, correctly coded note.',
    criteria: 'Composition',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: note rules', resource: read('Composition', 'Encounter') },
  },
  {
    file: 'encounter-rules',
    name: 'Teleemon: encounter rules',
    description: 'Pre-commit. A visit cannot start unless the provider is licensed where the patient is.',
    criteria: 'Encounter',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: encounter rules', resource: read('Encounter', 'Practitioner') },
  }
);

BOTS.push(
  {
    file: 'prescription-rules',
    name: 'Teleemon: prescription rules',
    description: 'Pre-commit. Sending a prescription requires licence, DEA coverage, refill limits and a PDMP check within 24 hours for controlled substances; sent prescriptions are locked.',
    criteria: 'MedicationRequest',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: prescription rules', resource: read('MedicationRequest', 'Practitioner', 'Task') },
  },
  {
    file: 'task-rules',
    name: 'Teleemon: task rules',
    formerNames: ['Teleemon: PDMP check rules'],
    description: 'Pre-commit. Tasks closed without completion need a reason; filed fax reviews stay closed; PDMP checks are recorded by their provider at the time of review and cannot be changed.',
    criteria: 'Task',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: task rules', resource: [...read('Task', 'DocumentReference', 'RelatedPerson', 'MedicationRequest', 'Patient', 'Coverage', 'Consent', 'MedicationStatement'), CLIENT_IDENTITY] },
  }
);

BOTS.push(
  {
    file: 'document-rules',
    name: 'Teleemon: document rules',
    description: 'Pre-commit. A fax is filed to a patient only after a personal confirmation of the match and is never removed without a reason; lab result reviews are made by the reviewer and are final.',
    criteria: 'DocumentReference',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: document rules', resource: read('DocumentReference', 'ServiceRequest', 'RelatedPerson') },
  },
  {
    file: 'communication-rules',
    name: 'Teleemon: message rules',
    description: 'Pre-commit. Unmatched patient messages are linked only after a confirmed match; closing a message records how it was handled.',
    criteria: 'Communication',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: message rules', resource: read('Communication', 'RelatedPerson') },
  },
  {
    file: 'result-review',
    name: 'Teleemon: result review',
    description: 'A lab result filed to a patient creates one review task for the provider; recording the review completes the task and the order.',
    criteria: `DocumentReference?category=${CODE_SYSTEMS.documentCategory}|lab-report`,
    preCommit: false,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: result review', resource: [...read('Patient', 'DocumentReference'), ...write('Task', 'ServiceRequest')] },
  },
  {
    file: 'recurring-tasks',
    name: 'Teleemon: recurring tasks',
    description: 'Completing a recurring task creates its next occurrence once.',
    criteria: 'Task?status=completed',
    preCommit: false,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: recurring tasks', resource: write('Task') },
  }
);

BOTS.push(
  {
    file: 'charge-capture',
    name: 'Teleemon: charge capture',
    description: 'When a provider signs a note, creates one ChargeItem per billed code for charge review (P30). Addenda and notes without a visit code create none.',
    criteria: 'Composition?status=final',
    preCommit: false,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: charge capture', resource: [...read('Composition', 'Encounter', 'Patient', 'Coverage', 'Basic'), { resourceType: 'ChargeItem', interaction: ['read', 'search', 'create'] }] },
  },
  {
    file: 'charge-rules',
    name: 'Teleemon: charge rules',
    description: 'Pre-commit. Charge status moves in order; billable charges need a payer, diagnosis, whole-cent amount and provider acceptance of AI codes; posted charges are frozen; charges are never deleted.',
    criteria: 'ChargeItem',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: charge rules', resource: read('ChargeItem') },
  },
  {
    file: 'claim-rules',
    name: 'Teleemon: claim rules',
    description: 'Pre-commit. Claim status moves in order; scrubbing and submission re-run the scrubber on the server; submitted claims are locked; one live claim per visit; payer outcomes only from the clearinghouse.',
    criteria: 'Claim',
    preCommit: true,
    policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: claim rules', resource: read('Claim', 'ChargeItem', 'Patient', 'Coverage', 'Practitioner', 'Organization', 'Encounter', 'Basic') },
  }
);

BOTS.push({
  file: 'onboarding-review',
  name: 'Teleemon: onboarding review',
  description: 'When a patient submits their new-patient forms in the portal, creates one front-desk review task to verify the record.',
  criteria: 'QuestionnaireResponse?status=completed',
  preCommit: false,
  policy: { resourceType: 'AccessPolicy', name: 'Teleemon Bot: onboarding review', resource: [...read('QuestionnaireResponse'), { resourceType: 'Task', interaction: ['read', 'search', 'create'] }] },
});

/** The delivery worker (services/worker): sends queued messages and handles inbound replies. */
export const WORKER_POLICY: AccessPolicy = {
  resourceType: 'AccessPolicy',
  name: 'Teleemon Service: worker',
  resource: [
    ...read('Bot', 'Basic'),
    // Opt-outs from STOP replies are written to Patient; confirmations to Appointment.
    { resourceType: 'Patient', interaction: ['read', 'search', 'update'] },
    { resourceType: 'Appointment', interaction: ['read', 'search', 'update'] },
    { resourceType: 'Communication', interaction: ['read', 'search', 'create', 'update'] },
    // E-prescribing (P25, P26): transmit queued prescriptions, write the chart medication list,
    // raise failure Tasks and record inbound renewal requests.
    ...read('Practitioner'),
    { resourceType: 'MedicationRequest', interaction: ['read', 'search', 'update'] },
    { resourceType: 'MedicationStatement', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'Task', interaction: ['read', 'search', 'create', 'update'] },
    // Fax (P28): inbound faxes are stored as unfiled DocumentReferences with their PDF; outbound
    // faxes are sent from documents. The daily summary email reads open Task counts only.
    { resourceType: 'DocumentReference', interaction: ['read', 'search', 'create', 'update'], criteria: `DocumentReference?category:not=${CODE_SYSTEMS.documentCategory}|private-psychotherapy&category:not=${CODE_SYSTEMS.documentCategory}|transcript` },
    { resourceType: 'Binary', interaction: ['read', 'create'] },
    // Revenue cycle (Phase 8): post reviewed charges, submit claims, record 277CA/835 results,
    // eligibility and statements. Billing documents only; no clinical notes.
    ...read('Encounter', 'Organization', 'Coverage'),
    { resourceType: 'ChargeItem', interaction: ['read', 'search', 'update'] },
    { resourceType: 'Claim', interaction: ['read', 'search', 'update'] },
    { resourceType: 'ClaimResponse', interaction: ['read', 'search', 'create'] },
    { resourceType: 'PaymentReconciliation', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'CoverageEligibilityRequest', interaction: ['read', 'search', 'create', 'update'] },
    { resourceType: 'CoverageEligibilityResponse', interaction: ['read', 'search', 'create'] },
    { resourceType: 'Invoice', interaction: ['read', 'search', 'create'] },
  ],
};

export const PRE_COMMIT_EXTENSION = 'https://medplum.com/fhir/StructureDefinition/pre-commit-bot';

export const SCRIBE_RETENTION_POLICY: AccessPolicy = {
  resourceType: 'AccessPolicy', name: 'Teleemon Service: scribe retention', resource: [
    { resourceType: 'DocumentReference', interaction: ['read', 'search', 'update'], criteria: 'DocumentReference?type=https://fhir.teleemon.com/scribe|session' },
    { resourceType: 'Composition', interaction: ['read', 'search'] },
    { resourceType: 'Binary', interaction: ['read', 'delete'] },
    { resourceType: 'AuditEvent', interaction: ['create'] },
  ],
};
