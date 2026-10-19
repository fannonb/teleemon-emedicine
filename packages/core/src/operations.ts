import type { Appointment, AuditEvent, Consent, Device, Organization, Patient, Practitioner, PractitionerRole, Reference, RelatedPerson, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT } from './fhir';

export type RecallChannel = 'phone' | 'portal' | 'sms' | 'email' | 'consent-review';
export type RecallConsentState = 'current' | 'unknown' | 'not-authorized';

export interface WaitlistDraft {
  readonly patient: Reference<Patient>;
  readonly visitTypeCode?: string;
  readonly visitTypeLabel: string;
  readonly provider?: Reference<Practitioner>;
  readonly modality?: 'video' | 'phone' | 'office';
  readonly preferredStart?: string;
  readonly preferredEnd?: string;
  readonly note?: string;
}

/** Build a standards-based waitlist Appointment. requestedPeriod stores the requested time window. */
export function buildWaitlistAppointment(input: WaitlistDraft, now = new Date()): Appointment {
  if (!input.patient.reference?.startsWith('Patient/')) throw new Error('Choose a patient for the waitlist request.');
  if (!input.visitTypeLabel.trim()) throw new Error('Choose a visit type for the waitlist request.');
  const start = input.preferredStart?.trim();
  const end = input.preferredEnd?.trim();
  if (start && !Number.isFinite(Date.parse(start))) throw new Error('The preferred start date is invalid.');
  if (end && !Number.isFinite(Date.parse(end))) throw new Error('The preferred end date is invalid.');
  if (start && end && Date.parse(start) > Date.parse(end)) throw new Error('The preferred start must be before the preferred end.');

  return {
    resourceType: 'Appointment',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: `waitlist:${input.patient.reference}:${input.visitTypeCode ?? input.visitTypeLabel.trim().toLowerCase()}:${start ?? ''}:${end ?? ''}` }],
    status: 'waitlist',
    created: now.toISOString(),
    appointmentType: {
      coding: input.visitTypeCode ? [{ system: CODE_SYSTEMS.visitType, code: input.visitTypeCode, display: input.visitTypeLabel.trim() }] : undefined,
      text: input.visitTypeLabel.trim(),
    },
    participant: [
      { actor: input.patient, status: 'accepted', required: 'required' },
      ...(input.provider ? [{ actor: input.provider, status: 'needs-action' as const, required: 'required' as const }] : []),
    ],
    requestedPeriod: start || end ? [{ ...(start ? { start } : {}), ...(end ? { end } : {}) }] : undefined,
    extension: [
      ...(input.modality ? [{ url: EXT.modality, valueCode: input.modality }] : []),
      ...(input.note?.trim() ? [{ url: EXT.waitlistNote, valueString: input.note.trim().slice(0, 500) }] : []),
    ],
  };
}

export function waitlistPatientRef(appointment: Appointment): string | undefined {
  return appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
}

export interface SlotOfferCriteria {
  readonly providerRef?: string;
  readonly modality?: string;
}

export interface AvailableInterval {
  readonly start: string;
  readonly end: string;
}

/** Earliest eligible waitlist requests for a genuinely free slot; never books or contacts anyone. */
export function waitlistCandidatesForInterval(appointments: Appointment[], interval: AvailableInterval, criteria: SlotOfferCriteria = {}): Appointment[] {
  const startAt = Date.parse(interval.start);
  const endAt = Date.parse(interval.end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return [];
  return appointments
    .filter((a) => a.status === 'waitlist')
    .filter((a) => {
      const periods = a.requestedPeriod ?? [];
      // requestedPeriod is a choice of acceptable windows; match if any alternative contains the interval.
      if (periods.length && !periods.some((p) => {
        const pStart = p.start ? Date.parse(p.start) : Number.NEGATIVE_INFINITY;
        const pEnd = p.end ? Date.parse(p.end) : Number.POSITIVE_INFINITY;
        return (!p.start || Number.isFinite(pStart)) && (!p.end || Number.isFinite(pEnd)) && startAt >= pStart && endAt <= pEnd;
      })) return false;
      const provider = a.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;
      if (provider && criteria.providerRef && provider !== criteria.providerRef) return false;
      if (provider && !criteria.providerRef) return false;
      const modality = a.extension?.find((e) => e.url === EXT.modality)?.valueCode;
      if (modality && criteria.modality && modality !== criteria.modality) return false;
      if (modality && !criteria.modality) return false;
      return !!waitlistPatientRef(a);
    })
    .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
}

export interface RecallDraft {
  readonly patient: Reference<Patient>;
  readonly dueDate: string;
  readonly reasonCode: string;
  readonly reasonLabel: string;
  readonly channel: RecallChannel;
  readonly consent: RecallConsentState;
  readonly requester?: Reference<Practitioner>;
}

export interface RecallContactability {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly consentReviewRequired: boolean;
}

/** Staff follow-up only: unknown consent creates a consent-review Task, never an outbound message. */
export function recallContactability(patient: Patient, channel: RecallChannel, consent: RecallConsentState): RecallContactability {
  if (!patient.id || patient.active === false || patient.deceasedBoolean || patient.deceasedDateTime) {
    return { allowed: false, reason: 'The patient record is inactive or deceased.', consentReviewRequired: false };
  }
  if (channel === 'consent-review') return { allowed: true, consentReviewRequired: true };
  if (consent !== 'current') return { allowed: false, reason: consent === 'unknown' ? 'Current contact consent is not on file.' : 'The patient has not authorized this contact channel.', consentReviewRequired: true };

  const system = channel === 'email' ? 'email' : channel === 'portal' ? undefined : 'phone';
  if (system && !patient.telecom?.some((point) => point.system === system && !!point.value?.trim())) {
    return { allowed: false, reason: `No ${system} contact is on file.`, consentReviewRequired: false };
  }
  const optedOut = patient.extension?.some((e) => {
    if (e.url !== EXT.contactOptOut) return false;
    const value = e.valueCode;
    return value === channel || (channel === 'phone' && value === 'voice');
  });
  if (optedOut) return { allowed: false, reason: `The patient opted out of ${channel} contact.`, consentReviewRequired: false };
  return { allowed: true, consentReviewRequired: false };
}

/**
 * Resolve only explicit contact consent. A matching Consent uses category
 * `operations|recall-contact` and provision.code `operations|<channel>`; ordinary treatment
 * consent does not authorize reminders or outreach.
 */
export function recallConsentState(consents: Consent[], channel: Exclude<RecallChannel, 'consent-review'>, now = new Date()): RecallConsentState {
  const current = consents
    .filter((consent) => consent.category?.some((category) => category.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === 'recall-contact')))
    .filter((consent) => consent.status === 'active')
    .filter((consent) => {
      const period = consent.provision?.period;
      return (!period?.start || Date.parse(period.start) <= now.getTime()) && (!period?.end || Date.parse(period.end) >= now.getTime());
    })
    .filter((consent) => consent.provision?.code?.some((code) => code.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === channel)))
    .sort((a, b) => (b.dateTime ?? '').localeCompare(a.dateTime ?? ''))[0];
  if (!current) return 'unknown';
  return current.provision?.type === 'permit' ? 'current' : 'not-authorized';
}

export function buildRecallTask(input: RecallDraft, now = new Date()): Task {
  if (!input.patient.reference?.startsWith('Patient/')) throw new Error('Choose a patient for the recall.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || !Number.isFinite(Date.parse(`${input.dueDate}T00:00:00Z`))) throw new Error('Enter a valid recall date.');
  if (!input.reasonCode.trim() || !input.reasonLabel.trim()) throw new Error('Choose a reason for the recall.');
  if (input.channel !== 'consent-review') {
    if (input.consent !== 'current') throw new Error('A current contact consent is required. Create a consent-review task instead.');
  }
  const key = `recall:${input.patient.reference}:${input.dueDate}:${input.reasonCode}:${input.channel}`;
  return {
    resourceType: 'Task',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
    status: 'requested',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.operations, code: 'recall' }], text: input.channel === 'consent-review' ? 'Review contact consent' : 'Patient recall' },
    description: input.channel === 'consent-review' ? 'Review and document contact consent before scheduling follow-up outreach.' : input.reasonLabel.trim(),
    for: input.patient,
    requester: input.requester,
    authoredOn: now.toISOString(),
    executionPeriod: { start: input.dueDate },
    restriction: { period: { end: input.dueDate } },
    input: [
      { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'recall-channel' }] }, valueCode: input.channel },
      { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'recall-consent' }] }, valueCode: input.consent },
      { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'recall-reason' }] }, valueCode: input.reasonCode },
    ],
  };
}

export function recallTaskPatientRef(task: Task): string | undefined {
  return task.for?.reference?.startsWith('Patient/') ? task.for.reference : undefined;
}

export function hasFutureBookedVisit(patientRef: string, appointments: Appointment[], now = new Date()): boolean {
  return appointments.some((a) => waitlistPatientRef(a) === patientRef && ['booked', 'arrived', 'checked-in'].includes(a.status) && !!a.start && Date.parse(a.start) >= now.getTime());
}

export interface AuditAlert {
  readonly id: string;
  readonly occurredAt: string;
  readonly severity: 'warning' | 'high' | 'critical' | 'review';
  readonly outcome: string;
  readonly action?: string;
  readonly actor?: string;
  readonly breakGlass?: boolean;
  readonly detail?: string;
  readonly summary: string;
}

/** Alerts come from actual failed operations or a recorded break-the-glass purpose. */
export function deriveAuditAlerts(events: AuditEvent[]): AuditAlert[] {
  return events
    .filter((event) => event.outcome !== '0' || isBreakGlass(event))
    .map((event): AuditAlert => {
      const breakGlass = isBreakGlass(event);
      return {
        id: event.id ?? `${event.recorded ?? ''}:${event.action ?? ''}:${event.outcome ?? ''}`,
        occurredAt: event.recorded,
        severity: breakGlass ? 'high' : event.outcome === '4' ? 'warning' : event.outcome === '8' ? 'high' : event.outcome === '12' ? 'critical' : 'review',
        outcome: event.outcome ?? 'unknown',
        action: event.action,
        actor: event.agent?.map((a) => a.who?.display ?? a.who?.reference).filter(Boolean).join(', '),
        breakGlass: breakGlass || undefined,
        detail: breakGlass ? event.outcomeDesc?.slice(0, 500) : undefined,
        summary: breakGlass ? 'Restricted chart access was recorded; review the stated reason.' : 'A recorded operation did not succeed. Review the audit event.',
      };
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function isBreakGlass(event: AuditEvent): boolean {
  return !!event.purposeOfEvent?.some((purpose) => purpose.coding?.some((coding) => coding.system === 'http://terminology.hl7.org/CodeSystem/v3-ActReason' && coding.code === 'BTG'));
}

export type IntegrationSignalState = 'available' | 'unavailable' | 'unknown' | 'not-configured';
export interface IntegrationSignal {
  readonly key: string;
  readonly label: string;
  readonly configured: boolean | undefined;
  readonly lastOutcome?: 'success' | 'failure';
  readonly lastSignalAt?: string;
  readonly source?: Reference;
}
export interface IntegrationHealth extends IntegrationSignal {
  readonly state: IntegrationSignalState;
  /** A recent failed attempt needs attention even when the selected adapter is a local mock. */
  readonly alert: boolean;
}

/** Minimal, PHI-free snapshot emitted by the local worker after it observes a run result. */
export interface WorkerOperationalSignal {
  readonly key: string;
  readonly label: string;
  readonly configured?: boolean;
  readonly outcome?: 'success' | 'failure';
  readonly observedAt?: string;
  readonly mode?: string;
  readonly failureClass?: string;
}

export function buildIntegrationHealthTask(signal: WorkerOperationalSignal): Task {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(signal.key)) throw new Error('Invalid integration health signal key.');
  if (!signal.label.trim() || signal.outcome && (!signal.observedAt || !Number.isFinite(Date.parse(signal.observedAt)))) throw new Error('Integration health signal requires a label and valid timestamp.');
  return {
    resourceType: 'Task',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: `integration-health:${signal.key}` }],
    status: signal.outcome === 'success' ? 'completed' : signal.outcome === 'failure' ? 'failed' : 'ready',
    intent: 'order',
    priority: signal.outcome === 'failure' ? 'urgent' : 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.operations, code: 'integration-health' }], text: signal.label.trim() },
    description: 'Worker operational signal. Contains no patient data.',
    authoredOn: signal.observedAt,
    lastModified: signal.observedAt,
    input: [
      { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'signal-key' }] }, valueCode: signal.key },
      { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'signal-label' }] }, valueString: signal.label.trim() },
      ...(signal.outcome ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'signal-outcome' }] }, valueCode: signal.outcome }] : []),
      ...(signal.observedAt ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'observed-at' }] }, valueDateTime: signal.observedAt }] : []),
      ...(signal.configured !== undefined ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'configured' }] }, valueBoolean: signal.configured }] : []),
      ...(signal.mode ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'mode' }] }, valueCode: signal.mode.slice(0, 40) }] : []),
      ...(signal.failureClass ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'failure-class' }] }, valueCode: signal.failureClass.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) }] : []),
    ],
  };
}

export function integrationSignalFromTask(task: Task): IntegrationSignal | undefined {
  if (!task.code?.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === 'integration-health')) return undefined;
  const read = (code: string) => task.input?.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));
  const key = read('signal-key')?.valueCode;
  const label = read('signal-label')?.valueString ?? task.code.text;
  const outcome = read('signal-outcome')?.valueCode;
  const at = read('observed-at')?.valueDateTime;
  if (!key || !label || (outcome !== undefined && outcome !== 'success' && outcome !== 'failure') || (outcome && (!at || !Number.isFinite(Date.parse(at))))) return undefined;
  return {
    key,
    label,
    configured: read('configured')?.valueBoolean,
    lastOutcome: outcome,
    lastSignalAt: at,
    source: task.id ? { reference: `Task/${task.id}` } : undefined,
  };
}

/** Health is based on explicit configuration and recent observed signals; stale silence is unknown. */
export function integrationHealth(signals: IntegrationSignal[], now = new Date(), maxAgeMs = 5 * 60_000): IntegrationHealth[] {
  return signals.map((signal) => {
    const age = signal.lastSignalAt ? now.getTime() - Date.parse(signal.lastSignalAt) : Number.POSITIVE_INFINITY;
    const fresh = Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
    const alert = fresh && signal.lastOutcome === 'failure';
    if (signal.configured === false) return { ...signal, state: 'not-configured', alert };
    const state: IntegrationSignalState = fresh && signal.lastOutcome === 'success'
      ? 'available'
      : fresh && signal.lastOutcome === 'failure'
        ? 'unavailable'
        : 'unknown';
    return { ...signal, state, alert };
  });
}

export type AttestationActor = Reference<Device | Organization | Patient | Practitioner | PractitionerRole | RelatedPerson>;

export type ComplianceEvidence =
  | { readonly kind: 'attestation'; readonly recordedAt: string; readonly recordedBy?: Reference; readonly evidence?: Reference; readonly note?: string }
  | { readonly kind: 'observed'; readonly observedAt: string; readonly source: Reference; readonly summary: string };

export interface ComplianceAttestationDraft {
  readonly checkpoint: string;
  readonly title: string;
  readonly evidence: Reference;
  readonly recordedBy?: AttestationActor;
  readonly recordedAt?: string;
  readonly vendor?: string;
  readonly executedOn?: string;
  readonly expiresOn?: string;
  readonly note?: string;
}

export function buildComplianceAttestation(input: ComplianceAttestationDraft, now = new Date()): Task {
  if (!input.checkpoint.trim() || !input.title.trim()) throw new Error('Choose a compliance checkpoint.');
  if (!input.evidence.reference) throw new Error('Attach or select evidence before recording an attestation.');
  if (input.checkpoint === 'baa-agreement' && (!input.vendor?.trim() || !input.executedOn)) throw new Error('A BAA attestation needs a vendor and execution date.');
  if (input.executedOn && !validDateOnly(input.executedOn)) throw new Error('Enter a valid agreement execution date.');
  if (input.expiresOn && !validDateOnly(input.expiresOn)) throw new Error('Enter a valid agreement expiry date.');
  if (input.executedOn && input.expiresOn && input.expiresOn < input.executedOn) throw new Error('The agreement expiry date must be on or after its execution date.');
  const inputs: NonNullable<Task['input']> = [
    { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'compliance-checkpoint' }] }, valueCode: input.checkpoint },
    { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'evidence-kind' }] }, valueCode: 'attestation' },
    { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'evidence-reference' }] }, valueReference: input.evidence },
    { type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'attested-at' }] }, valueDateTime: input.recordedAt ?? now.toISOString() },
    ...(input.recordedBy ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'attested-by' }] }, valueReference: input.recordedBy }] : []),
    ...(input.vendor ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'vendor' }] }, valueString: input.vendor.trim() }] : []),
    ...(input.executedOn ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'executed-on' }] }, valueDate: input.executedOn }] : []),
    ...(input.expiresOn ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'expires-on' }] }, valueDate: input.expiresOn }] : []),
    ...(input.note?.trim() ? [{ type: { coding: [{ system: CODE_SYSTEMS.operations, code: 'attestation-note' }] }, valueString: input.note.trim().slice(0, 500) }] : []),
  ];
  return {
    resourceType: 'Task',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: `compliance:${input.checkpoint}:${input.vendor?.trim().toLowerCase().replace(/\s+/g, ' ') ?? input.evidence.reference}:${input.executedOn ?? input.recordedAt ?? now.toISOString().slice(0, 10)}` }],
    status: 'completed',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.operations, code: 'compliance-checkpoint' }], text: input.title.trim() },
    description: `${input.title.trim()} — attested; evidence has not been independently verified.`,
    authoredOn: input.recordedAt ?? now.toISOString(),
    requester: input.recordedBy,
    input: inputs,
  };
}

export function complianceEvidenceFromTask(task: Task): ComplianceEvidence | undefined {
  const input = task.input ?? [];
  const value = (code: string) => input.find((item) => item.type.coding?.some((c) => c.system === CODE_SYSTEMS.operations && c.code === code));
  if (value('evidence-kind')?.valueCode === 'observed') {
    const at = value('observed-at')?.valueDateTime;
    const source = value('evidence-reference')?.valueReference;
    if (at && source?.reference) return { kind: 'observed', observedAt: at, source, summary: value('evidence-summary')?.valueString ?? 'Observed system evidence.' };
  }
  if (value('evidence-kind')?.valueCode === 'attestation') {
    return {
      kind: 'attestation',
      recordedAt: value('attested-at')?.valueDateTime ?? task.authoredOn ?? '',
      recordedBy: value('attested-by')?.valueReference ?? task.requester,
      evidence: value('evidence-reference')?.valueReference,
      note: value('attestation-note')?.valueString,
    };
  }
  return undefined;
}

function validDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
