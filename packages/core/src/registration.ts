// Registration rules shared by the registration form (P08) and the patient-record Bot.
import type { Patient, PatientContact } from '@medplum/fhirtypes';
import { EXT } from './fhir';

export interface GuardianDetails {
  given: string;
  family: string;
  relationship: string;
  phone: string;
  email?: string;
  authority: boolean;
}

/** The snapshot is saved with Patient so a pre-commit Bot can validate a new minor atomically. */
export function guardianContact(v: GuardianDetails): PatientContact {
  return {
    relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'GUARD', display: 'guardian' }], text: v.relationship }],
    name: { given: [v.given.trim()], family: v.family.trim() },
    telecom: [
      { system: 'phone', value: normalizePhone(v.phone) ?? v.phone.trim() },
      ...(v.email?.trim() ? [{ system: 'email' as const, value: v.email.trim() }] : []),
    ],
    extension: [{ url: EXT.guardianAuthority, valueBoolean: v.authority }],
  };
}

export function hasConfirmedGuardian(patient: Patient): boolean {
  return patient.contact?.some((c) =>
    c.relationship?.some((r) => r.coding?.some((x) => x.code === 'GUARD')) &&
    !!c.name?.given?.some((g) => g.trim()) && !!c.name?.family?.trim() &&
    c.relationship.some((r) => !!r.text?.trim()) &&
    c.telecom?.some((t) => t.system === 'phone' && !!normalizePhone(t.value ?? '')) &&
    c.extension?.some((e) => e.url === EXT.guardianAuthority && e.valueBoolean === true)
  ) ?? false;
}

export const US_STATES: readonly { code: string; name: string }[] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([code, name]) => ({ code, name }));

/**
 * NPI check digit (Luhn over "80840" + first 9 digits), per the CMS NPI standard.
 * Catches typos before a referral or claim is rejected.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`.split('').map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = digits[i];
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

/** Chart number derived from the resource id: short, stable, effectively unique per practice. */
export function chartNumberFor(id: string, length = 8): string {
  return `TM-${id.replace(/-/g, '').slice(0, length).toUpperCase()}`;
}

export function normalizePhone(value: string): string | undefined {
  const digits = value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : undefined;
}

export const GENDER_IDENTITIES = ['Woman', 'Man', 'Non-binary', 'Transgender woman', 'Transgender man', 'Another identity', 'Prefer not to say'] as const;
export const PRONOUNS = ['she/her', 'he/him', 'they/them', 'she/they', 'he/they', 'Use my name', 'Prefer not to say'] as const;
export const SEXUAL_ORIENTATIONS = ['Straight or heterosexual', 'Lesbian or gay', 'Bisexual', 'Queer', 'Another orientation', "Don't know", 'Prefer not to say'] as const;
export const RACES = ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Native Hawaiian or Other Pacific Islander', 'White', 'Other race', 'Prefer not to say'] as const;
export const ETHNICITIES = ['Hispanic or Latino', 'Not Hispanic or Latino', 'Prefer not to say'] as const;
export const MARITAL_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus';
export const MARITAL_STATUSES: { code: string; label: string }[] = [
  { code: 'S', label: 'Never married' },
  { code: 'M', label: 'Married' },
  { code: 'T', label: 'Domestic partner' },
  { code: 'D', label: 'Divorced' },
  { code: 'L', label: 'Legally separated' },
  { code: 'W', label: 'Widowed' },
  { code: 'UNK', label: 'Prefer not to say' },
];
export const EMPLOYMENT_STATUSES = ['Employed', 'Self-employed', 'Student', 'Unemployed', 'Retired', 'Unable to work', 'Prefer not to say'] as const;
export const REFERRAL_SOURCES = ['Primary care referral', 'Another clinician', 'Insurer directory', 'Website', 'Friend or family', 'Returning patient', 'Other'] as const;

/**
 * Phone search values for FHIR token search, which matches the stored string exactly. Registration
 * stores 425-555-0123; older or imported records may use other common formats.
 */
export function phoneSearchValues(input: string): string[] {
  const digits = input.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return [input.trim()];
  const [a, b, c] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return [`${a}-${b}-${c}`, digits, `(${a}) ${b}-${c}`, `${a}.${b}.${c}`, `+1${digits}`, `+1-${a}-${b}-${c}`];
}
