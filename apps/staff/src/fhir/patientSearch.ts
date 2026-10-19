import type { MedplumClient } from '@medplum/core';
import type { Appointment, Patient } from '@medplum/fhirtypes';
import { MRN_SYSTEM, duplicateReasons, phoneSearchValues } from '@teleemon/core';

// One search box for everything (P07): name (partial), date of birth, phone, email, chart number
// (MRN) or insurance member ID.

const ISO_DOB = /^\d{4}-\d{2}-\d{2}$/;
const US_DOB = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MRN = /^tm-?[0-9a-f]{4,}$/i;

export type QueryKind = 'name' | 'dob' | 'phone' | 'email' | 'mrn' | 'member';

export function classifyQuery(query: string): { kind: QueryKind; params: Record<string, string> } {
  const q = query.trim();
  const us = US_DOB.exec(q);
  if (us) return { kind: 'dob', params: { birthdate: `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` } };
  if (ISO_DOB.test(q)) return { kind: 'dob', params: { birthdate: q } };
  if (MRN.test(q)) return { kind: 'mrn', params: { identifier: `${MRN_SYSTEM}|${q.toUpperCase().replace(/^TM-?/, 'TM-')}` } };
  if (q.includes('@')) return { kind: 'email', params: { email: q.toLowerCase() } };
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length === q.replace(/[\s().+-]/g, '').length) return { kind: 'phone', params: { phone: phoneSearchValues(q).join(',') } };
  if (/^[A-Z]{2,4}\d{4,}$/i.test(q) && !MRN.test(q)) return { kind: 'member', params: {} };
  return { kind: 'name', params: { name: q } };
}

export async function searchPatients(medplum: MedplumClient, query: string, count = 25): Promise<Patient[]> {
  const { kind, params } = classifyQuery(query);
  if (kind === 'member') {
    // Member IDs are stored as a Coverage identifier (type MB) as well as subscriberId.
    const coverages = await medplum.searchResources('Coverage', { identifier: query.trim().toUpperCase(), _count: '10' });
    const ids = [...new Set(coverages.map((c) => c.beneficiary.reference?.split('/')[1]).filter(Boolean))];
    return ids.length ? medplum.searchResources('Patient', { _id: ids.join(','), _count: String(count) }) : [];
  }
  return medplum.searchResources('Patient', { ...params, _count: String(count), _sort: 'family' }, { cache: 'no-cache' });
}

/** Server-side directory/search pagination; never limits searching to the visible page. */
export async function patientPage(medplum: MedplumClient, query: string, page: number): Promise<{ patients: Patient[]; total: number }> {
  const trimmed = query.trim();
  const { kind, params } = trimmed ? classifyQuery(trimmed) : { kind: 'name', params: {} };
  let filters = params;
  if (kind === 'member') {
    const ids = new Set<string>();
    for await (const coverages of medplum.searchResourcePages('Coverage', { identifier: trimmed.toUpperCase(), _count: '100' }, { cache: 'no-cache' })) {
      for (const coverage of coverages) {
        const id = coverage.beneficiary.reference?.split('/')[1];
        if (id) ids.add(id);
      }
    }
    if (!ids.size) return { patients: [], total: 0 };
    filters = { _id: [...ids].join(',') };
  }
  const bundle = await medplum.search('Patient', {
    ...filters, _count: '10', _offset: String((Math.max(1, page) - 1) * 10),
    _total: 'accurate', _sort: 'family,given,_id',
  }, { cache: 'no-cache' });
  if (typeof bundle.total !== 'number') throw new Error('The patient count could not be loaded. Please try again.');
  return { patients: (bundle.entry ?? []).flatMap((e) => e.resource?.resourceType === 'Patient' ? [e.resource] : []), total: bundle.total };
}

/** Next upcoming appointment per patient, in one request. */
export async function nextAppointments(medplum: MedplumClient, patients: Patient[]): Promise<Map<string, Appointment>> {
  const result = new Map<string, Appointment>();
  if (patients.length === 0) return result;
  const appts = await medplum.searchResources(
    'Appointment',
    new URLSearchParams([
      ['patient', patients.map((p) => `Patient/${p.id}`).join(',')],
      ['date', `ge${new Date().toISOString()}`],
      ['status', 'booked,arrived,checked-in,pending,proposed'],
      ['_sort', 'date'],
      ['_count', '100'],
    ])
  );
  for (const a of appts) {
    const ref = a.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const id = ref?.split('/')[1];
    if (id && !result.has(id)) result.set(id, a);
  }
  return result;
}

/** Patients in the list that look like another patient in the list. */
export function possibleDuplicates(patients: Patient[]): Set<string> {
  const flagged = new Set<string>();
  for (let i = 0; i < patients.length; i++) {
    for (let j = i + 1; j < patients.length; j++) {
      if (duplicateReasons(patients[i], patients[j]).length > 0) {
        flagged.add(patients[i].id as string);
        flagged.add(patients[j].id as string);
      }
    }
  }
  return flagged;
}

const RECENT_KEY = 'teleemon.recentPatients';

/** Recently opened patient IDs (opaque IDs only, never names) for quick return. */
export function rememberPatient(id: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...list.filter((x) => x !== id)].slice(0, 8)));
  } catch {
    // Storage unavailable: recent list is a convenience only.
  }
}

export function recentPatientIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
