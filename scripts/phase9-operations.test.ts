import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent, Consent, Patient, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from '../packages/core/src/fhir';
import {
  buildComplianceAttestation, buildIntegrationHealthTask, buildRecallTask, buildWaitlistAppointment,
  complianceEvidenceFromTask, deriveAuditAlerts, hasFutureBookedVisit, integrationHealth, integrationSignalFromTask,
  recallConsentState, recallContactability, waitlistCandidatesForInterval,
} from '../packages/core/src/operations';
import { handler as taskRules } from '../bots/src/task-rules';
import { recordWorkerConfiguration, recordWorkerHeartbeat } from '../services/worker/src/operations';
import { loadAuditEvents } from '../apps/staff/src/operations/audit';

const at = new Date('2026-10-18T12:00:00.000Z');
const patient = (overrides: Partial<Patient> = {}): Patient => ({ resourceType: 'Patient', id: 'p1', active: true, telecom: [{ system: 'phone', value: '+12065550100' }], ...overrides });
const consent = (channel: string, type: 'permit' | 'deny' = 'permit'): Consent => ({
  resourceType: 'Consent', status: 'active', scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] }, patient: { reference: 'Patient/p1' }, dateTime: at.toISOString(),
  category: [{ coding: [{ system: CODE_SYSTEMS.operations, code: 'recall-contact' }] }],
  provision: { type, period: { start: '2026-01-01', end: '2027-01-01' }, code: [{ coding: [{ system: CODE_SYSTEMS.operations, code: channel }] }] },
});

test('waitlist requests use Appointment.waitlist and match any requestedPeriod alternative', () => {
  const waitlist = buildWaitlistAppointment({
    patient: { reference: 'Patient/p1' }, visitTypeLabel: 'Medication follow-up', preferredStart: '2026-10-19T09:00:00Z', preferredEnd: '2026-10-19T12:00:00Z',
  }, at);
  assert.equal(waitlist.status, 'waitlist');
  assert.equal(waitlist.requestedPeriod?.[0].start, '2026-10-19T09:00:00Z');
  assert.ok(waitlist.identifier?.[0].value?.startsWith('waitlist:Patient/p1:'));
  const alternatives = { ...waitlist, requestedPeriod: [
    { start: '2026-10-20T09:00:00Z', end: '2026-10-20T12:00:00Z' },
    { start: '2026-10-19T08:00:00Z', end: '2026-10-19T13:00:00Z' },
  ] };
  assert.equal(waitlistCandidatesForInterval([alternatives], { start: '2026-10-19T10:00:00Z', end: '2026-10-19T10:30:00Z' }).length, 1);
  assert.equal(waitlistCandidatesForInterval([{ ...waitlist, status: 'booked' }], { start: '2026-10-19T10:00:00Z', end: '2026-10-19T10:30:00Z' }).length, 0);
  assert.throws(() => buildWaitlistAppointment({ patient: { reference: 'Patient/p1' }, visitTypeLabel: 'Follow up', preferredStart: 'bad' }, at), /invalid/);
});

test('recall outreach requires explicit channel consent and respects opt-outs', () => {
  assert.equal(recallConsentState([], 'sms', at), 'unknown');
  assert.equal(recallConsentState([consent('sms')], 'sms', at), 'current');
  assert.equal(recallConsentState([consent('sms', 'deny')], 'sms', at), 'not-authorized');
  assert.equal(recallConsentState([consent('email')], 'sms', at), 'unknown');
  assert.equal(recallContactability(patient(), 'sms', 'current').allowed, true);
  const optedOut = patient({ extension: [{ url: EXT.contactOptOut, valueCode: 'sms' }] });
  assert.equal(recallContactability(optedOut, 'sms', 'current').allowed, false);
  assert.throws(() => buildRecallTask({ patient: { reference: 'Patient/p1' }, dueDate: '2026-11-01', reasonCode: 'follow-up', reasonLabel: 'Follow up', channel: 'sms', consent: 'unknown' }, at), /current contact consent/);
  assert.equal(buildRecallTask({ patient: { reference: 'Patient/p1' }, dueDate: '2026-11-01', reasonCode: 'follow-up', reasonLabel: 'Follow up', channel: 'consent-review', consent: 'unknown' }, at).status, 'requested');
});

test('recalls exclude patients with a future booked visit', () => {
  const booked = { resourceType: 'Appointment' as const, status: 'booked' as const, start: '2026-10-20T10:00:00Z', participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' as const }] };
  assert.equal(hasFutureBookedVisit('Patient/p1', [booked], at), true);
  assert.equal(hasFutureBookedVisit('Patient/p1', [{ ...booked, status: 'cancelled' }], at), false);
  assert.equal(hasFutureBookedVisit('Patient/p1', [{ ...booked, start: '2026-10-01T10:00:00Z' }], at), false);
});

test('audit alerts include successful break-the-glass access and omit unrelated success', () => {
  const success: AuditEvent = { resourceType: 'AuditEvent', type: { code: 'rest' }, recorded: at.toISOString(), outcome: '0', agent: [{ requestor: true }], source: { observer: { display: 'test' } } };
  const breakGlass: AuditEvent = {
    ...success, id: 'btg-1', outcomeDesc: 'Restricted chart opened. Reason: Clinical emergency — patient name omitted',
    purposeOfEvent: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'BTG' }] }],
  };
  const failed: AuditEvent = { ...success, id: 'fail-1', outcome: '8', outcomeDesc: 'Do not expose this detail' };
  const alerts = deriveAuditAlerts([success, breakGlass, failed]);
  assert.equal(alerts.length, 2);
  assert.equal(alerts.find((alert) => alert.id === 'btg-1')?.breakGlass, true);
  assert.match(alerts.find((alert) => alert.id === 'btg-1')?.detail ?? '', /Clinical emergency/);
  assert.equal(alerts.find((alert) => alert.id === 'fail-1')?.detail, undefined);
});

test('audit searches return a bounded cursor and include the full end date', async () => {
  let query = '';
  let followed = '';
  const firstBundle = {
    resourceType: 'Bundle', type: 'searchset', total: 4,
    link: [{ relation: 'next', url: 'http://localhost:8103/fhir/R4/AuditEvent?_getpages=page-2' }],
    entry: [{ resource: { resourceType: 'AuditEvent', id: 'a1', recorded: at.toISOString(), outcome: '0' } }],
  };
  const secondBundle = { resourceType: 'Bundle', type: 'searchset', total: 4, entry: [{ resource: { resourceType: 'AuditEvent', id: 'a2', recorded: at.toISOString(), outcome: '0' } }] };
  const client = {
    fhirUrl: () => 'http://localhost:8103/fhir/R4/AuditEvent',
    search: async (_type: string, params: URLSearchParams) => { query = params.toString(); return firstBundle; },
    get: async (url: string) => { followed = url; return secondBundle; },
  } as unknown as MedplumClient;
  const first = await loadAuditEvents(client, { since: '2026-10-01', until: '2026-10-18', limit: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.total, 4);
  assert.deepEqual(new URLSearchParams(query).getAll('date'), ['ge2026-10-01', 'lt2026-10-19']);
  assert.ok(first.nextCursor);
  const second = await loadAuditEvents(client, { since: '2026-10-01', until: '2026-10-18', limit: 1, cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.match(followed, /_getpages=page-2/);
});

test('compliance evidence preserves attestation provenance and validates BAA fields', () => {
  const task = buildComplianceAttestation({
    checkpoint: 'baa-agreement', title: 'Business Associate Agreement', evidence: { reference: 'DocumentReference/baa' },
    recordedBy: { reference: 'Practitioner/admin' }, vendor: 'Google Cloud', executedOn: '2026-10-01', expiresOn: '2027-10-01',
  }, at);
  assert.equal(complianceEvidenceFromTask(task)?.kind, 'attestation');
  assert.match(task.description ?? '', /not been independently verified/);
  assert.throws(() => buildComplianceAttestation({ checkpoint: 'baa-agreement', title: 'BAA', evidence: { reference: 'DocumentReference/baa' } }, at), /vendor and execution date/);
  assert.throws(() => buildComplianceAttestation({ checkpoint: 'baa-agreement', title: 'BAA', evidence: { reference: 'DocumentReference/baa' }, vendor: 'Google', executedOn: '2027-02-30' }, at), /valid agreement execution date/);
});

test('integration health is recent and observed; stale signals become unknown', () => {
  const task = buildIntegrationHealthTask({ key: 'worker', label: 'Background worker', configured: true, outcome: 'success', observedAt: at.toISOString() });
  const signal = integrationSignalFromTask(task);
  assert.ok(signal);
  assert.equal(integrationHealth([signal!], at)[0].state, 'available');
  assert.equal(integrationHealth([signal!], new Date(at.getTime() + 6 * 60_000))[0].state, 'unknown');
  assert.equal(integrationHealth([{ key: 'sms', label: 'SMS delivery', configured: false }], at)[0].state, 'not-configured');
  assert.equal(integrationHealth([{ key: 'meet', label: 'Google Meet', configured: true }], at)[0].state, 'unknown');
  const configuredOnly = integrationSignalFromTask(buildIntegrationHealthTask({ key: 'sms', label: 'SMS delivery', configured: false, mode: 'log' }));
  assert.equal(integrationHealth([configuredOnly!], at)[0].state, 'not-configured');
  const failedMock = integrationSignalFromTask(buildIntegrationHealthTask({ key: 'sms', label: 'SMS delivery', configured: false, mode: 'log', outcome: 'failure', observedAt: at.toISOString() }));
  assert.equal(integrationHealth([failedMock!], at)[0].alert, true);
  assert.equal(integrationHealth([failedMock!], new Date(at.getTime() + 6 * 60_000))[0].alert, false);
});

const botEvent = (input: Task): BotEvent<Task> => ({ input, bot: { reference: 'Bot/task-rules' }, contentType: 'application/fhir+json', secrets: {} });

test('compliance Bot validates a human author and current evidence; AccessPolicy supplies the admin gate', async () => {
  const author = { reference: 'Practitioner/admin' };
  const task = buildComplianceAttestation({
    checkpoint: 'baa-agreement', title: 'Business Associate Agreement', evidence: { reference: 'DocumentReference/baa' },
    recordedBy: author, vendor: 'Google Cloud', executedOn: '2026-10-01',
  }, at);
  task.meta = { author };
  const server = {
    readResource: async () => ({ resourceType: 'DocumentReference', status: 'current' }),
  } as unknown as MedplumClient;
  const stamped = await taskRules(server, botEvent(task)) as Task;
  // The Bot accepts the attestation and stamps who attested and when on the server.
  assert.equal(stamped.requester?.reference, author.reference);
  assert.ok(stamped.input?.some((i) => i.type.coding?.some((c) => c.code === 'attested-by') && i.valueReference?.reference === author.reference));
  assert.ok(stamped.input?.some((i) => i.type.coding?.some((c) => c.code === 'attested-at') && !!i.valueDateTime));
  // The AccessPolicy excludes every non-admin human role from this Task code. The Bot separately
  // refuses non-human authors because worker clients have broad Task write access for operations.
  const byService = { ...task, meta: { author: { reference: 'ClientApplication/worker' } } };
  await assert.rejects(taskRules(server, botEvent(byService)), /Only an administrator/);
  const missingEvidence = { ...server, readResource: async () => ({ resourceType: 'DocumentReference', status: 'entered-in-error' }) };
  await assert.rejects(taskRules(missingEvidence as unknown as MedplumClient, botEvent({ ...task, code: { coding: [{ system: CODE_SYSTEMS.operations, code: 'compliance-checkpoint' }] }, input: task.input?.map((item) => item.type.coding?.some((c) => c.code === 'compliance-checkpoint') ? { ...item, valueCode: 'risk-analysis' } : item) })), /evidence document must be current/);
});

test('only the named worker ClientApplication can create integration health Tasks', async () => {
  const task = buildIntegrationHealthTask({ key: 'worker', label: 'Background worker', configured: true, outcome: 'success', observedAt: at.toISOString() });
  task.meta = { author: { reference: 'ClientApplication/worker' } };
  const allowed = { readResource: async () => ({ resourceType: 'ClientApplication', name: 'Teleemon worker' }) } as unknown as MedplumClient;
  assert.equal(await taskRules(allowed, botEvent(task)), true);
  const denied = { readResource: async () => ({ resourceType: 'ClientApplication', name: 'Other client' }) } as unknown as MedplumClient;
  await assert.rejects(taskRules(denied, botEvent(task)), /Only the Teleemon worker/);
  const configOnly = buildIntegrationHealthTask({ key: 'sms', label: 'SMS delivery', configured: false, mode: 'log' });
  configOnly.meta = { author: { reference: 'ClientApplication/worker' } };
  assert.equal(await taskRules(allowed, botEvent(configOnly)), true);
});

test('worker heartbeat stores a safe error class, never raw error text', async () => {
  let created: Task | undefined;
  const client = {
    searchOne: async () => undefined,
    createResourceIfNoneExist: async (task: Task) => { created = task; return task; },
  } as unknown as MedplumClient;
  await recordWorkerHeartbeat(client, 'failure', new Error('patient name and secret transcript'), at);
  assert.equal(created?.status, 'failed');
  assert.equal(JSON.stringify(created).includes('secret transcript'), false);
  assert.equal(created?.input?.find((item) => item.type.coding?.some((coding) => coding.code === 'failure-class'))?.valueCode, 'Error');
});

test('configuration refresh preserves the last observed result and never invents health', async () => {
  const previous = buildIntegrationHealthTask({ key: 'sms', label: 'SMS delivery', configured: true, outcome: 'failure', observedAt: at.toISOString(), failureClass: 'TimeoutError' });
  previous.id = 'health-sms';
  previous.meta = { versionId: '7' };
  let updated: Task | undefined;
  const client = {
    searchOne: async () => previous,
    updateResource: async (task: Task) => { updated = task; return task; },
  } as unknown as MedplumClient;
  await recordWorkerConfiguration(client, { key: 'sms', label: 'SMS delivery', configured: false, mode: 'log' });
  const refreshed = integrationSignalFromTask(updated!);
  assert.equal(refreshed?.configured, false);
  assert.equal(refreshed?.lastOutcome, 'failure');
  assert.equal(refreshed?.lastSignalAt, at.toISOString());
  assert.equal(integrationHealth([refreshed!], at)[0].alert, true);
});
