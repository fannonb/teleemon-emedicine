import type { Patient } from '@medplum/fhirtypes';

// Duplicate-patient rule (P07, P08). Used by the registration form for an early warning and by
// the duplicate-patient pre-commit Bot as the authoritative check (SYSTEM-DESIGN.md §6).

export interface DuplicateMatch {
  readonly patient: Patient;
  readonly reasons: string[];
}

function norm(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function phones(p: Patient): string[] {
  return (p.telecom ?? [])
    .filter((t) => t.system === 'phone' && t.value)
    .map((t) => (t.value as string).replace(/\D/g, '').slice(-10))
    .filter((d) => d.length === 10);
}

function emails(p: Patient): string[] {
  return (p.telecom ?? []).filter((t) => t.system === 'email' && t.value).map((t) => (t.value as string).trim().toLowerCase());
}

/**
 * Two records are a likely duplicate when they share a birth date and either
 * (a) the same family name and first initial, or (b) a phone number or email address.
 */
export function duplicateReasons(candidate: Patient, other: Patient): string[] {
  if (!candidate.birthDate || candidate.birthDate !== other.birthDate) {
    return [];
  }
  const reasons: string[] = [];
  const a = candidate.name?.[0];
  const b = other.name?.[0];
  if (a && b && norm(a.family) && norm(a.family) === norm(b.family) && norm(a.given?.[0]).charAt(0) === norm(b.given?.[0]).charAt(0)) {
    reasons.push('same last name, first initial and date of birth');
  }
  const sharedPhone = phones(candidate).find((p) => phones(other).includes(p));
  if (sharedPhone) {
    reasons.push('same date of birth and phone number');
  }
  const sharedEmail = emails(candidate).find((e) => emails(other).includes(e));
  if (sharedEmail) {
    reasons.push('same date of birth and email address');
  }
  return reasons;
}

export function findDuplicates(candidate: Patient, sameBirthDate: Patient[]): DuplicateMatch[] {
  return sameBirthDate
    .filter((p) => p.id !== candidate.id && p.active !== false)
    .map((patient) => ({ patient, reasons: duplicateReasons(candidate, patient) }))
    .filter((m) => m.reasons.length > 0);
}
