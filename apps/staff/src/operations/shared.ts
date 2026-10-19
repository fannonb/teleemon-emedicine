import type { MedplumClient } from '@medplum/core';
import type { BundleEntry, Patient, Resource, ResourceType } from '@medplum/fhirtypes';

export async function collectEntries(medplum: MedplumClient, type: ResourceType, params: [string, string][]): Promise<BundleEntry[]> {
  const out: BundleEntry[] = [];
  for await (const page of medplum.searchResourcePages(type, new URLSearchParams(params), { cache: 'no-cache' })) {
    out.push(...(page.bundle.entry ?? []));
  }
  return out;
}

/** Fetches every matching row up to a hard ceiling; throws instead of returning a silent partial list. */
export async function collectResources<T extends Resource>(
  medplum: MedplumClient,
  type: ResourceType,
  params: URLSearchParams,
  maxRows = 5000
): Promise<T[]> {
  params.set('_count', '200');
  const out: T[] = [];
  let reportedTotal: number | undefined;
  for await (const page of medplum.searchResourcePages(type, params, { cache: 'no-cache' })) {
    reportedTotal ??= page.bundle.total;
    if (reportedTotal !== undefined && reportedTotal > maxRows) throw new Error(`This queue contains more than ${maxRows} records; narrow the date or patient filter.`);
    for (const entry of page.bundle.entry ?? []) {
      if (entry.resource?.resourceType === type) out.push(entry.resource as T);
    }
    if (out.length > maxRows) throw new Error(`This queue contains more than ${maxRows} records; narrow the date or patient filter.`);
  }
  if (reportedTotal !== undefined && out.length < reportedTotal) throw new Error('The complete list could not be loaded. Refresh or narrow the search.');
  return out;
}

export function resourcesFrom<T extends { resourceType: string }>(entries: readonly BundleEntry[], type: T['resourceType']): T[] {
  return entries.flatMap((entry) => entry.resource?.resourceType === type ? [entry.resource as T] : []);
}

export function idOf(reference: string | undefined): string | undefined {
  return reference?.split('/')[1] || undefined;
}

export async function patientsByRef(medplum: MedplumClient, references: readonly (string | undefined)[]): Promise<Map<string, Patient>> {
  const ids = [...new Set(references.map((ref) => ref?.startsWith('Patient/') ? idOf(ref) : undefined).filter((id): id is string => !!id))];
  const out = new Map<string, Patient>();
  for (let i = 0; i < ids.length; i += 40) {
    const patients = await medplum.searchResources('Patient', { _id: ids.slice(i, i + 40).join(','), _count: '40' }, { cache: 'no-cache' });
    for (const patient of patients) out.set(`Patient/${patient.id}`, patient);
  }
  return out;
}
