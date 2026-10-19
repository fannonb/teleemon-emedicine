import { badRequest, OperationOutcomeError, type BotEvent, type MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { previous } from './previous';

/** Applies to administrators too: corrections are additional events, never edits. */
export async function handler(medplum: MedplumClient, event: BotEvent<AuditEvent>): Promise<AuditEvent> {
  if (Object.keys(event.headers ?? {}).some(key => key.toLowerCase() === 'x-medplum-deleted-resource')) {
    throw new OperationOutcomeError(badRequest('Audit events cannot be deleted.'));
  }
  if (await previous(medplum, event.input)) throw new OperationOutcomeError(badRequest('Audit events are append-only. Record a separate correction event.'));
  return event.input;
}
