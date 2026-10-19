import type { MedplumClient, QueryTypes } from '@medplum/core';
import type { ExtractResource, ResourceType } from '@medplum/fhirtypes';

/** Work queues must not silently lose items beyond the server's first search page. */
export async function searchAll<RT extends ResourceType>(client: MedplumClient, type: RT, query: QueryTypes): Promise<ExtractResource<RT>[]> {
  const rows: ExtractResource<RT>[] = [];
  for await (const page of client.searchResourcePages(type, query, { cache: 'no-cache' })) rows.push(...page);
  return rows;
}
