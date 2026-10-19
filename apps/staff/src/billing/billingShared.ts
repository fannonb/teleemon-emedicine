import type { MedplumClient } from '@medplum/core';
import { formatHumanName, normalizeErrorString } from '@medplum/core';
import type { BundleEntry, Coverage, HumanName, Patient, ResourceType, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, TELEEMON_BASE, zonedDate } from '@teleemon/core';
import { LedgerApiError } from './ledgerApi';

// Shared by the Phase 8 work queues (P31–P34). No JSX here; see billingUi.tsx for the widgets.

/** Claim.extension: the reason a claim was closed (set when the biller closes it). */
export const CLOSE_REASON_EXT = `${TELEEMON_BASE}/StructureDefinition/close-reason`;
export const CLAIM_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/claim-type';
export const RELATED_CLAIM_SYSTEM = 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship';
export const PROCESS_PRIORITY_SYSTEM = 'http://terminology.hl7.org/CodeSystem/processpriority';
export const PLACE_OF_SERVICE_SYSTEM = 'https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code';

/** The server's words when it refuses (ledger or FHIR); otherwise the generic reading. */
export function errorMessage(err: unknown): string {
  return err instanceof LedgerApiError ? err.message : normalizeErrorString(err);
}

/** Today's date (YYYY-MM-DD) in the practice time zone. */
export const practiceToday = (now = new Date()): string => zonedDate(now);

/** The id part of a relative reference such as `Patient/abc`. */
export const idOf = (ref: string | undefined): string | undefined => ref?.split('/')[1] || undefined;

/** Task.code search value for one billing or inbox code. */
export const taskCodeParam = (code: string): string => `${CODE_SYSTEMS.taskCode}|${code}`;

/** Reads every page of a search, keeping the included resources. */
export async function collectEntries(medplum: MedplumClient, type: ResourceType, params: [string, string][]): Promise<BundleEntry[]> {
  const out: BundleEntry[] = [];
  for await (const page of medplum.searchResourcePages(type, new URLSearchParams(params), { cache: 'no-cache' })) {
    out.push(...(page.bundle.entry ?? []));
  }
  return out;
}

/** Runs `fn` over the items a few at a time, so a bulk action does not flood the server. */
export async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

/** The active Coverage of each patient, newest first (one per patient). */
export async function activeCoverageFor(medplum: MedplumClient, patientRefs: readonly string[]): Promise<Map<string, Coverage>> {
  const out = new Map<string, Coverage>();
  for (let i = 0; i < patientRefs.length; i += 40) {
    const batch = patientRefs.slice(i, i + 40);
    const found = await medplum.searchResources('Coverage', new URLSearchParams([['beneficiary', batch.join(',')], ['status', 'active'], ['_sort', '-_lastUpdated'], ['_count', '200']]), { cache: 'no-cache' });
    for (const cov of found) {
      const ben = cov.beneficiary?.reference;
      if (ben && !out.has(ben)) out.set(ben, cov);
    }
  }
  return out;
}

/** Display names for practitioner references, in one search per 40. */
export async function practitionerNames(medplum: MedplumClient, refs: readonly (string | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(refs.map((r) => idOf(r)).filter((x): x is string => x !== undefined))];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 40) {
    const found = await medplum.searchResources('Practitioner', { _id: ids.slice(i, i + 40).join(','), _count: '40' }, { cache: 'no-cache' });
    for (const p of found) out.set(`Practitioner/${p.id}`, formatHumanName(p.name?.[0] as HumanName) || 'Provider');
  }
  return out;
}

/** Patients by reference, from an included search result. */
export function patientsFrom(entries: readonly BundleEntry[]): Map<string, Patient> {
  const out = new Map<string, Patient>();
  for (const e of entries) {
    if (e.resource?.resourceType === 'Patient') out.set(`Patient/${e.resource.id}`, e.resource);
  }
  return out;
}

/** Patients by reference, read by id in batches of 40. References that are not patients are skipped. */
export async function patientsByRef(medplum: MedplumClient, refs: readonly (string | undefined)[]): Promise<Map<string, Patient>> {
  const ids = [...new Set(refs.map((r) => (r?.startsWith('Patient/') ? idOf(r) : undefined)).filter((x): x is string => x !== undefined))];
  const out = new Map<string, Patient>();
  for (let i = 0; i < ids.length; i += 40) {
    const found = await medplum.searchResources('Patient', { _id: ids.slice(i, i + 40).join(','), _count: '40' }, { cache: 'no-cache' });
    for (const p of found) out.set(`Patient/${p.id}`, p);
  }
  return out;
}

/** Reads the Task fresh and writes the change with the optimistic-lock header. */
export async function setTaskState(medplum: MedplumClient, taskId: string, change: (t: Task) => Task): Promise<Task> {
  const current = await medplum.readResource('Task', taskId, { cache: 'no-cache' });
  return medplum.updateResource(change(current), { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } });
}

/** A Task closed the way the inbox rules expect: completed, or closed with a reason. */
export const completedTask = (t: Task, note?: string, now = new Date()): Task => ({
  ...t,
  status: 'completed',
  lastModified: now.toISOString(),
  note: note ? [...(t.note ?? []), { text: note, time: now.toISOString() }] : t.note,
});

export const cancelledTask = (t: Task, reason: string, now = new Date()): Task => ({
  ...t,
  status: 'cancelled',
  statusReason: { text: reason },
  lastModified: now.toISOString(),
});
