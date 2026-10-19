import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { handler } from '../bots/src/audit-rules';

const audit: AuditEvent = { resourceType: 'AuditEvent', type: { code: 'rest' }, recorded: '2026-10-18T12:00:00Z', agent: [{ requestor: true }], source: { observer: { reference: 'Practitioner/test' } } };
const event = (input: AuditEvent, headers?: Record<string, string>): BotEvent<AuditEvent> => ({ input, headers, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {} });
test('new audit events are accepted without changing their content', async () => {
  const client = {} as MedplumClient;
  assert.equal(await handler(client, event(audit)), audit);
});
test('even administrator-authored audit updates and deletes are refused', async () => {
  const client = { readResource: async () => audit } as unknown as MedplumClient;
  await assert.rejects(handler(client, event({ ...audit, id: 'audit-1', meta: { author: { reference: 'Practitioner/admin' } } })), /append-only/);
  await assert.rejects(handler(client, event({ ...audit, id: 'audit-1' }, { 'X-Medplum-Deleted-Resource': 'true' })), /cannot be deleted/);
});
test('failed previous-version reads fail closed', async () => {
  const client = { readResource: async () => { throw new Error('Network unavailable'); } } as unknown as MedplumClient;
  await assert.rejects(handler(client, event({ ...audit, id: 'audit-1' })), /Network unavailable/);
});
