// Recurring tasks (P29). When a recurring Task is completed, the next occurrence is created once
// (idempotent on the completed Task), keeping its assignee, team, patient and recurrence.

import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { DERIVED_IDENTIFIER_SYSTEM, nextOccurrence } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<Task>): Promise<string> {
  const next = nextOccurrence(event.input);
  if (!next) return 'skipped';
  const key = `recur-${event.input.id}`;
  await medplum.createResourceIfNoneExist<Task>(
    { ...next, identifier: [{ system: DERIVED_IDENTIFIER_SYSTEM, value: key }] },
    new URLSearchParams({ identifier: `${DERIVED_IDENTIFIER_SYSTEM}|${key}` }).toString()
  );
  return 'next occurrence ensured';
}
