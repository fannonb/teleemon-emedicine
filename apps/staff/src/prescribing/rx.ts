import type { MedplumClient } from '@medplum/core';
import type { MedicationRequest, Patient, Practitioner, Task } from '@medplum/fhirtypes';
import type { ErxStatus } from '@teleemon/core';
import { CODE_SYSTEMS, erxStatus } from '@teleemon/core';

/** Prescribing is vendor-neutral until an eRx/EPCS vendor is contracted (P25, ADR-008). */
// No live adapter exists yet. A frontend environment flag must never claim pharmacy delivery.
export const ERX_LIVE = false;

export async function loadPdmpChecks(medplum: MedplumClient, patient: Patient): Promise<Task[]> {
  return medplum.searchResources(
    'Task',
    { subject: `Patient/${patient.id}`, code: `${CODE_SYSTEMS.taskCode}|pdmp-check`, _sort: '-_lastUpdated', _count: '50' },
    { cache: 'no-cache' }
  );
}

export async function loadPrescriptions(medplum: MedplumClient, patient: Patient): Promise<MedicationRequest[]> {
  return medplum.searchResources('MedicationRequest', { subject: `Patient/${patient.id}`, _sort: '-_lastUpdated', _count: '100' }, { cache: 'no-cache' });
}

/** The prescriber's own Practitioner record, read fresh so new licences and DEA registrations apply. */
export async function loadPrescriber(medplum: MedplumClient): Promise<Practitioner | undefined> {
  const profile = medplum.getProfile();
  if (profile?.resourceType !== 'Practitioner') return undefined;
  return medplum.readResource('Practitioner', profile.id as string, { cache: 'no-cache' });
}

export type RxDisplay = { label: string; color: string; hint: string };

/** What a prescription's state means to the prescriber. */
export function rxDisplay(mr: MedicationRequest): RxDisplay {
  if (mr.status === 'draft') return { label: 'Draft', color: 'gray', hint: 'Not sent. Review and send, or discard.' };
  if (mr.status === 'entered-in-error') return { label: 'Discarded', color: 'gray', hint: 'Draft discarded.' };
  const s: ErxStatus | undefined = erxStatus(mr);
  switch (s) {
    case 'queued':
    case 'sending':
      return { label: 'Sending', color: 'blue', hint: 'Waiting for the e-prescribing service.' };
    case 'sent':
      return { label: ERX_LIVE ? 'Sent' : 'Sent (sandbox)', color: 'green', hint: ERX_LIVE ? 'Delivered to the pharmacy.' : 'Recorded by the mock vendor; no pharmacy received it.' };
    case 'failed':
      return { label: 'Not sent', color: 'red', hint: 'The e-prescribing service rejected it. Retry or cancel.' };
    case 'cancel-requested':
      return { label: 'Cancelling', color: 'orange', hint: 'Cancellation requested; awaiting service confirmation.' };
    case 'cancelled':
      return { label: 'Cancelled (sandbox)', color: 'gray', hint: 'Cancelled in the mock service; no pharmacy was contacted.' };
    default:
      return { label: mr.status, color: 'gray', hint: '' };
  }
}
