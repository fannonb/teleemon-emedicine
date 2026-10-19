import type { MedplumClient } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { SCRIBE_DATA } from '@teleemon/core';
import type { ScribeSession } from '@teleemon/core';

export function scribeData(doc: DocumentReference): ScribeSession { return JSON.parse(doc.extension?.find((e) => e.url === SCRIBE_DATA)?.valueString ?? '{}') as ScribeSession; }
export async function scribeRequest<T>(medplum: MedplumClient, path: string, input?: unknown, method?: string): Promise<T> {
  const audio = input instanceof Uint8Array;
  const response = await fetch(`/api/scribe${path}`, { method: method ?? (input === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${medplum.getAccessToken()}`, ...(input === undefined ? {} : { 'Content-Type': audio ? 'audio/wav' : 'application/json' }) }, body: input === undefined ? undefined : audio ? new Uint8Array(input) : JSON.stringify(input) });
  if (!response.ok) { const value = await response.json().catch(() => undefined); throw new Error(value?.error ?? 'Scribe service is unavailable. Start it with npm run scribe.'); }
  return response.json() as Promise<T>;
}
