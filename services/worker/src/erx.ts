// E-prescribing transmission (P25, ADR-008). Vendor-neutral: the worker hands queued
// prescriptions to an adapter and records the outcome. Until a vendor is contracted (iPrescribe
// Enterprise, DoseSpot or another certified eRx/EPCS partner) the mock adapter is the default: it
// sends nothing to any pharmacy and is for synthetic data only.
//
// States (EXT.erxStatus): queued → sending → sent | failed; a provider may request cancellation
// (cancel-requested) at any point, which ends in cancelled. Each prescription's id is passed to
// the vendor as the idempotency key, so a retried transmission cannot create a second order.

import type { MedplumClient } from '@medplum/core';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { MedicationRequest, MedicationStatement, Patient, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, ERX_IDENTIFIER_SYSTEM, EXT, TELEEMON_BASE, currentPdmpCheck, erxStatus, prescriptionProblems, readRx, rxSchedule, searchAll } from '@teleemon/core';
import type { ErxStatus } from '@teleemon/core';

export interface ErxAdapter {
  readonly mode: string;
  /** Sends a prescription; returns the vendor's prescription id. `key` is the idempotency key. */
  transmit(rx: MedicationRequest, patient: Patient, prescriber: Practitioner, key: string): Promise<{ vendorId: string }>;
  cancel(rx: MedicationRequest, vendorId: string): Promise<void>;
}

/** Local stand-in for the vendor. A pharmacy name containing "FAIL" simulates a rejected transmission. */
export class MockErxAdapter implements ErxAdapter {
  readonly mode = 'mock';
  async transmit(rx: MedicationRequest, _patient: Patient, _prescriber: Practitioner, key: string): Promise<{ vendorId: string }> {
    if (/FAIL/.test(readRx(rx).pharmacy)) throw new Error('Mock vendor: pharmacy rejected the prescription');
    return { vendorId: `MOCK-${key}` };
  }
  async cancel(): Promise<void> {}
}

export function erxAdapterFromEnv(): ErxAdapter {
  const vendor = process.env.ERX_VENDOR ?? 'mock';
  if (vendor !== 'mock') throw new Error(`E-prescribing vendor "${vendor}" has no adapter yet. Use ERX_VENDOR=mock until the vendor integration is built.`);
  return new MockErxAdapter();
}

const withStatus = (rx: MedicationRequest, status: ErxStatus, extra: NonNullable<MedicationRequest['extension']> = []): MedicationRequest => ({
  ...rx,
  extension: [...(rx.extension ?? []).filter((e) => e.url !== EXT.erxStatus && e.url !== EXT.erxError), { url: EXT.erxStatus, valueCode: status }, ...extra],
});
const vendorIdOf = (rx: MedicationRequest): string | undefined => rx.identifier?.find((i) => i.system === ERX_IDENTIFIER_SYSTEM)?.value;
const ATTEMPT_AT = `${TELEEMON_BASE}/StructureDefinition/erx-attempt-at`;
const freshAttempt = (rx: MedicationRequest): boolean => Date.now() - Date.parse(rx.extension?.find((e) => e.url === ATTEMPT_AT)?.valueInstant ?? '') < 5 * 60000;
const save = (m: MedplumClient, rx: MedicationRequest): Promise<MedicationRequest> => m.updateResource(rx, { headers: { 'If-Match': `W/"${rx.meta?.versionId}"` } });

/** One pass over recent prescriptions waiting for transmission or cancellation. */
export async function processPrescriptions(
  medplum: MedplumClient,
  adapter: ErxAdapter,
  only?: (rx: MedicationRequest) => boolean
): Promise<{ sent: number; failed: number; cancelled: number }> {
  const result = { sent: 0, failed: 0, cancelled: 0 };
  const recent = await searchAll(medplum, 'MedicationRequest', { status: 'active,cancelled,stopped', _count: '100' });
  for (const listed of recent.filter((r) => (!only || only(r)))) {
    try {
      const rx = await medplum.readResource('MedicationRequest', listed.id as string, { cache: 'no-cache' });
      const state = erxStatus(rx);
      // Reconcile local side effects after a crash without transmitting again.
      if (state === 'sent') {
        await writeChartMedication(medplum, rx, await medplum.readReference(rx.subject as Reference<Patient>));
        continue;
      }
      if (state === 'cancelled') { await stopChartMedication(medplum, rx); continue; }
      if (state === 'sending' && freshAttempt(rx)) continue;
      if (state === 'cancel-requested') {
        const vendorId = vendorIdOf(rx);
        // Do not acknowledge cancellation while a transmission may still be in flight.
        if (!vendorId && rx.extension?.some((e) => e.url === ATTEMPT_AT)) {
          if (freshAttempt(rx)) continue;
          await transmit(medplum, adapter, rx);
          continue;
        }
        if (vendorId) await adapter.cancel(rx, vendorId);
        await save(medplum, withStatus({ ...rx, status: rx.status === 'active' ? 'cancelled' : rx.status }, 'cancelled'));
        await stopChartMedication(medplum, rx);
        result.cancelled++;
      } else if (state === 'queued' || state === 'sending') {
        // A stale 'sending' (worker stopped mid-send) is retried with the same idempotency key.
        if (await transmit(medplum, adapter, rx)) result.sent++;
        else result.failed++;
      }
    } catch (err) {
      // Usually a concurrent edit (version conflict); the next pass re-reads and retries.
      console.error(`[worker] e-prescribing: ${listed.id}: ${normalizeErrorString(err)}`);
    }
  }
  return result;
}

async function transmit(medplum: MedplumClient, adapter: ErxAdapter, rx: MedicationRequest): Promise<boolean> {
  const recoveringCancel = erxStatus(rx) === 'cancel-requested';
  const claimed = await save(medplum, withStatus({ ...rx, extension: rx.extension?.filter((e) => e.url !== ATTEMPT_AT) }, recoveringCancel ? 'cancel-requested' : 'sending', [{ url: ATTEMPT_AT, valueInstant: new Date().toISOString() }]));
  const patient = await medplum.readReference(rx.subject as Reference<Patient>);
  const prescriber = await medplum.readReference(rx.requester as Reference<Practitioner>);
  let vendorId: string;
  try {
    const checks = await medplum.searchResources('Task', { subject: rx.subject.reference!, code: `${CODE_SYSTEMS.taskCode}|pdmp-check`, status: 'completed', _count: '100' }, { cache: 'no-cache' });
    const own = checks.filter((t) => t.owner?.reference === rx.requester?.reference);
    const problems = prescriptionProblems(readRx(rx), { practitioner: prescriber, pdmpChecks: own });
    const cited = rx.extension?.find((e) => e.url === EXT.pdmpCheck)?.valueReference?.reference;
    if (rxSchedule(rx) && !currentPdmpCheck(own.filter((t) => `Task/${t.id}` === cited), readRx(rx).state)) problems.push('The cited PDMP review is no longer valid.');
    // A recovery after possible vendor acceptance must reconcile the same immutable request.
    // Future live adapters must supply an idempotent transmit/status reconciliation contract.
    if (!recoveringCancel && problems.length) throw new Error(problems.join(' '));
    ({ vendorId } = await adapter.transmit(claimed, patient, prescriber, rx.id as string));
  } catch (err) {
    const message = normalizeErrorString(err);
    const latest = await medplum.readResource('MedicationRequest', rx.id as string, { cache: 'no-cache' });
    if (erxStatus(latest) !== 'cancel-requested') await save(medplum, withStatus(latest, 'failed', [{ url: EXT.erxError, valueString: message }]));
    await failureTask(medplum, rx, patient, message);
    return false;
  }
  // Record the vendor id even if the provider asked to cancel meanwhile; the next pass cancels it.
  for (let attempt = 0; ; attempt++) {
    const latest = await medplum.readResource('MedicationRequest', rx.id as string, { cache: 'no-cache' });
    const next: ErxStatus = erxStatus(latest) === 'cancel-requested' ? 'cancel-requested' : 'sent';
    const identifier = [...(latest.identifier ?? []).filter((i) => i.system !== ERX_IDENTIFIER_SYSTEM), { system: ERX_IDENTIFIER_SYSTEM, value: vendorId }];
    try {
      await save(medplum, withStatus({ ...latest, identifier }, next));
      if (next === 'sent') await writeChartMedication(medplum, latest, patient);
      return true;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** The chart medication list (P14) shows what was prescribed, linked to the prescription. */
async function writeChartMedication(medplum: MedplumClient, rx: MedicationRequest, patient: Patient): Promise<void> {
  const key = `rx-${rx.id}`;
  const statement: MedicationStatement = {
    resourceType: 'MedicationStatement',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
    status: 'active',
    basedOn: [{ reference: `MedicationRequest/${rx.id}` }],
    medicationCodeableConcept: rx.medicationCodeableConcept,
    subject: createReference(patient),
    informationSource: rx.requester as MedicationStatement['informationSource'],
    dateAsserted: new Date().toISOString(),
    effectivePeriod: { start: rx.authoredOn ?? new Date().toISOString() },
    dosage: [{ text: readRx(rx).sig }],
    extension: rx.extension?.filter((e) => e.url === EXT.controlledSchedule),
  };
  await medplum.createResourceIfNoneExist(statement, new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString());
}

async function stopChartMedication(medplum: MedplumClient, rx: MedicationRequest): Promise<void> {
  const statement = await medplum.searchOne('MedicationStatement', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|rx-${rx.id}` }, { cache: 'no-cache' });
  if (statement && statement.status === 'active') {
    await medplum.updateResource({ ...statement, status: 'stopped', effectivePeriod: { ...statement.effectivePeriod, end: new Date().toISOString() } });
  }
}

/** A failed transmission is never silent: the prescriber gets an urgent task (one per prescription). */
async function failureTask(medplum: MedplumClient, rx: MedicationRequest, patient: Patient, message: string): Promise<void> {
  const key = `erx-failure-${rx.id}`;
  const task: Task = {
    resourceType: 'Task',
    identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }],
    status: 'requested',
    intent: 'order',
    priority: 'urgent',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'erx-failure' }], text: 'Prescription not sent' },
    description: `${rx.medicationCodeableConcept?.text ?? 'Prescription'} was not sent: ${message}`,
    for: createReference(patient),
    focus: { reference: `MedicationRequest/${rx.id}` },
    owner: rx.requester as Task['owner'],
    authoredOn: new Date().toISOString(),
  };
  await medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString());
}
