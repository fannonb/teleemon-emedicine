import type { Appointment, Patient } from '@medplum/fhirtypes';

/** A normalized bridge contract, not a claim that every AdvancedMD export has this shape. */
export const MIGRATION_SYSTEM = 'https://teleemon.com/identifier/advancedmd';
export interface MigrationPatient { sourceId: string; given: string; family: string; birthDate: string; gender?: Patient['gender']; }
export interface MigrationAppointment { sourceId: string; patientSourceId: string; start: string; end: string; status: Appointment['status']; }
export interface MigrationBundle { format: 'teleemon-advancedmd-v1'; patients: MigrationPatient[]; appointments: MigrationAppointment[]; }
export interface MigrationIssue { entity: 'file' | 'patient' | 'appointment'; row: number; field: string; message: string; }
export interface MigrationValidation { valid: boolean; issues: MigrationIssue[]; counts: { patients: number; appointments: number; acceptedPatients: number; acceptedAppointments: number }; }
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const APPOINTMENT_STATUSES = new Set(['proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'entered-in-error', 'checked-in', 'waitlist']);
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function validDate(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v && v <= new Date().toISOString().slice(0, 10);
}
function instant(v: unknown): number {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) ? Date.parse(v) : NaN;
}
export function validateMigration(value: unknown): MigrationValidation {
  const issues: MigrationIssue[] = [];
  const issue = (entity: MigrationIssue['entity'], row: number, field: string, message: string): void => { issues.push({ entity, row, field, message }); };
  if (!record(value) || value.format !== 'teleemon-advancedmd-v1' || !Array.isArray(value.patients) || !Array.isArray(value.appointments)) {
    return { valid: false, issues: [{ entity: 'file', row: 0, field: 'format', message: 'Expected teleemon-advancedmd-v1 with patients and appointments arrays.' }], counts: { patients: 0, appointments: 0, acceptedPatients: 0, acceptedAppointments: 0 } };
  }
  const counts = { patients: value.patients.length, appointments: value.appointments.length, acceptedPatients: 0, acceptedAppointments: 0 };
  if (counts.patients + counts.appointments > 10000) return { valid: false, issues: [{ entity: 'file', row: 0, field: 'rows', message: 'Split batches at 10,000 total records.' }], counts };
  const patients = new Set<string>();
  value.patients.forEach((v: unknown, index: number) => {
    const before = issues.length;
    const row = index + 1;
    if (!record(v)) { issue('patient', row, 'record', 'Expected an object.'); return; }
    if (typeof v.sourceId !== 'string' || !ID.test(v.sourceId)) issue('patient', row, 'sourceId', 'Use a stable source identifier, 1–80 letters, numbers, dots, underscores or hyphens.');
    else if (patients.has(v.sourceId)) issue('patient', row, 'sourceId', 'Duplicate source identifier.');
    else patients.add(v.sourceId);
    for (const field of ['given', 'family']) if (typeof v[field] !== 'string' || !v[field].trim() || v[field].length > 200) issue('patient', row, field, 'A nonempty name up to 200 characters is required.');
    if (!validDate(v.birthDate)) issue('patient', row, 'birthDate', 'Use a real, nonfuture YYYY-MM-DD date.');
    if (v.gender !== undefined && !['male', 'female', 'other', 'unknown'].includes(String(v.gender))) issue('patient', row, 'gender', 'Use a FHIR administrative gender.');
    if (before === issues.length) counts.acceptedPatients++;
  });
  const appointments = new Set<string>();
  value.appointments.forEach((v: unknown, index: number) => {
    const before = issues.length;
    const row = index + 1;
    if (!record(v)) { issue('appointment', row, 'record', 'Expected an object.'); return; }
    if (typeof v.sourceId !== 'string' || !ID.test(v.sourceId)) issue('appointment', row, 'sourceId', 'Invalid stable source identifier.');
    else if (appointments.has(v.sourceId)) issue('appointment', row, 'sourceId', 'Duplicate source identifier.');
    else appointments.add(v.sourceId);
    if (typeof v.patientSourceId !== 'string' || !patients.has(v.patientSourceId)) issue('appointment', row, 'patientSourceId', 'Patient must exist in this source batch.');
    if (!Number.isFinite(instant(v.start))) issue('appointment', row, 'start', 'An ISO timestamp with an explicit timezone is required.');
    if (!Number.isFinite(instant(v.end)) || instant(v.end) <= instant(v.start)) issue('appointment', row, 'end', 'End must be after start and include a timezone.');
    if (!APPOINTMENT_STATUSES.has(String(v.status))) issue('appointment', row, 'status', 'Unmapped appointment status.');
    if (before === issues.length) counts.acceptedAppointments++;
  });
  return { valid: issues.length === 0, issues, counts };
}
export function migrationPatient(input: MigrationPatient): Patient {
  return { resourceType: 'Patient', active: true, identifier: [{ system: MIGRATION_SYSTEM, value: `patient:${input.sourceId}` }], name: [{ given: [input.given.trim()], family: input.family.trim() }], birthDate: input.birthDate, gender: input.gender };
}
export function migrationAppointment(input: MigrationAppointment, patientRef: string): Appointment {
  if (!/^Patient\/[A-Za-z0-9.-]+$/.test(patientRef)) throw new Error('Expected a resolved Patient reference.');
  return { resourceType: 'Appointment', identifier: [{ system: MIGRATION_SYSTEM, value: `appointment:${input.sourceId}` }], status: input.status, start: input.start, end: input.end, participant: [{ actor: { reference: patientRef }, status: 'accepted' }] };
}
