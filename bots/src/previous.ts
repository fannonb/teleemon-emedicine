import { isNotFound, normalizeOperationOutcome } from '@medplum/core';
import type { MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';

/** A failed read must never turn an update of a locked record into an apparent create. */
export async function previous<T extends Resource>(client: MedplumClient, resource: T): Promise<T | undefined> {
  if (!resource.id) return undefined;
  try {
    return await client.readResource(resource.resourceType, resource.id, { cache: 'no-cache' }) as T;
  } catch (error) {
    const outcome = (error as OperationOutcomeError)?.outcome ?? normalizeOperationOutcome(error);
    if (isNotFound(outcome) || outcome.issue?.some((issue) => issue.code === 'not-found')) return undefined;
    throw error;
  }
}
