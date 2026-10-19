import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationAppointment, migrationPatient, validateMigration, type MigrationBundle } from '../packages/core/src/migration';
import type { MedplumClient } from '@medplum/core';
import { importSyntheticMigration } from './lib/migration-import';

const sample = (): MigrationBundle => ({ format: 'teleemon-advancedmd-v1', patients: [{ sourceId: 'synthetic-1', given: 'Test', family: 'Migration', birthDate: '1990-01-01' }], appointments: [{ sourceId: 'visit-1', patientSourceId: 'synthetic-1', start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:30:00Z', status: 'fulfilled' }] });
test('valid source rows reconcile to accepted counts and stable identifiers', () => {
  const data = sample(); const result = validateMigration(data);
  assert.equal(result.valid, true); assert.deepEqual(result.counts, { patients: 1, appointments: 1, acceptedPatients: 1, acceptedAppointments: 1 });
  assert.deepEqual(migrationPatient(data.patients[0]).identifier, migrationPatient(data.patients[0]).identifier);
  assert.equal(migrationAppointment(data.appointments[0], 'Patient/123').participant[0].actor?.reference, 'Patient/123');
});
test('rejects duplicate IDs, impossible birthdays, unlinked patients and unmapped status', () => {
  const data = sample(); data.patients.push({ ...data.patients[0], birthDate: '1990-02-30' });
  data.appointments[0].patientSourceId = 'missing'; data.appointments[0].status = 'bad' as never;
  const result = validateMigration(data); assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.issues.map(x => x.field)), new Set(['sourceId', 'birthDate', 'patientSourceId', 'status']));
});
test('refuses timezone-less and backwards appointment times', () => {
  const data = sample(); data.appointments[0].start = '2026-01-01T10:00:00'; data.appointments[0].end = '2026-01-01T09:00:00Z';
  assert.equal(validateMigration(data).valid, false);
  assert.throws(() => migrationAppointment(data.appointments[0], 'Patient/../other'));
});
test('rejects arbitrary FHIR payloads and oversized row batches', () => {
  assert.equal(validateMigration({ resourceType: 'Bundle' }).valid, false);
  const data = sample(); data.patients = Array.from({ length: 10001 }, () => data.patients[0]);
  assert.equal(validateMigration(data).issues[0].field, 'rows');
});
test('synthetic import refuses invalid, non-synthetic or active source data before any write', async () => {
  const client = {} as MedplumClient;
  const data = sample();
  data.patients[0].sourceId = 'real-1'; data.appointments[0].patientSourceId = 'real-1';
  await assert.rejects(importSyntheticMigration(client, data), /synthetic-prefixed/);
  const active = sample(); active.appointments[0].sourceId = 'synthetic-visit'; active.appointments[0].status = 'booked';
  await assert.rejects(importSyntheticMigration(client, active), /historical terminal/);
});
