import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { MIGRATION_SYSTEM, migrationAppointment, migrationPatient, validateMigration, type MigrationBundle } from '../../packages/core/src/migration';

/** Explicit synthetic rehearsal. No overwrite, no production target and no real source records. */
export async function importSyntheticMigration(client: MedplumClient, data: MigrationBundle): Promise<{ patients: number; appointments: number; replayed: number }> {
  const validation = validateMigration(data);
  if (!validation.valid) throw new Error('Resolve all staging validation errors before import.');
  if (![...data.patients, ...data.appointments].every(row => row.sourceId.startsWith('synthetic-'))) throw new Error('Only synthetic-prefixed source IDs may be imported by this rehearsal.');
  if (data.appointments.some(row => !['fulfilled', 'cancelled', 'noshow', 'entered-in-error'].includes(row.status))) throw new Error('Only historical terminal appointments are supported by this rehearsal; active bookings require provider/slot mapping.');
  let replayed = 0;
  const entries: NonNullable<Bundle['entry']> = [];
  const refs = new Map<string, string>();
  for (const row of data.patients) {
    const expected = migrationPatient(row);
    const existing = await client.searchResources('Patient', { identifier: `${MIGRATION_SYSTEM}|patient:${row.sourceId}`, _count: '2' });
    if (existing.length > 1) throw new Error('Duplicate target patient identifiers require review.');
    if (existing[0]) {
      const actual = existing[0];
      if (actual.birthDate !== expected.birthDate || actual.name?.[0]?.family !== expected.name?.[0]?.family || actual.name?.[0]?.given?.join(' ') !== expected.name?.[0]?.given?.join(' ') || actual.gender !== expected.gender) throw new Error('Existing target patient differs from the source; no records were overwritten.');
      refs.set(row.sourceId, `Patient/${actual.id}`); replayed++;
    } else {
      const fullUrl = `urn:uuid:00000000-0000-4000-8000-${(entries.length + 1).toString().padStart(12, '0')}`;
      refs.set(row.sourceId, fullUrl);
      entries.push({ fullUrl, resource: expected, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${encodeURIComponent(`${MIGRATION_SYSTEM}|patient:${row.sourceId}`)}` } });
    }
  }
  for (const row of data.appointments) {
    const patientRef = refs.get(row.patientSourceId) as string;
    const expected = migrationAppointment(row, 'Patient/temporary');
    expected.participant[0].actor = { reference: patientRef };
    const existing = await client.searchResources('Appointment', { identifier: `${MIGRATION_SYSTEM}|appointment:${row.sourceId}`, _count: '2' });
    if (existing.length > 1) throw new Error('Duplicate target appointment identifiers require review.');
    if (existing[0]) {
      const actual = existing[0];
      if (actual.start !== expected.start || actual.end !== expected.end || actual.status !== expected.status || actual.participant[0]?.actor?.reference !== patientRef) throw new Error('Existing target appointment differs from the source; no records were overwritten.');
      replayed++;
    } else entries.push({ resource: expected, request: { method: 'POST', url: 'Appointment', ifNoneExist: `identifier=${encodeURIComponent(`${MIGRATION_SYSTEM}|appointment:${row.sourceId}`)}` } });
  }
  if (entries.length) {
    const response = await client.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries });
    if (response.entry?.some(entry => !/^2\d\d/.test(entry.response?.status ?? ''))) throw new Error('Migration transaction did not commit successfully. Review server validation.');
  }
  // Read back each stable identifier; do not infer import success from HTTP status alone.
  let patients = 0; let appointments = 0;
  for (const row of data.patients) {
    const result = await client.searchResources('Patient', { identifier: `${MIGRATION_SYSTEM}|patient:${row.sourceId}`, _count: '2' });
    if (result.length !== 1) throw new Error('Post-import patient counts do not reconcile.');
    const expected = migrationPatient(row);
    if (result[0].birthDate !== expected.birthDate || result[0].gender !== expected.gender || result[0].name?.[0]?.family !== expected.name?.[0]?.family || result[0].name?.[0]?.given?.join(' ') !== expected.name?.[0]?.given?.join(' ')) throw new Error('Post-import patient content does not reconcile.');
    refs.set(row.sourceId, `Patient/${result[0].id}`);
    patients++;
  }
  for (const row of data.appointments) {
    const result = await client.searchResources('Appointment', { identifier: `${MIGRATION_SYSTEM}|appointment:${row.sourceId}`, _count: '2' });
    if (result.length !== 1) throw new Error('Post-import appointment counts do not reconcile.');
    if (result[0].status !== row.status || result[0].start !== row.start || result[0].end !== row.end || result[0].participant[0]?.actor?.reference !== refs.get(row.patientSourceId)) throw new Error('Post-import appointment content does not reconcile.');
    appointments++;
  }
  return { patients, appointments, replayed };
}
