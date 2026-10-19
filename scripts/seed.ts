// Synthetic data for development and phase verification. Never run against production.
// Idempotent: every record carries a seed identifier, so re-running only adds what is missing
// (for example, a new day's appointments). Also creates one login per role for verification.

import type { MedplumClient } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type {
  AllergyIntolerance,
  Appointment,
  Communication,
  Condition,
  Consent,
  Coverage,
  Encounter,
  Identifier,
  Location,
  MedicationStatement,
  Organization,
  Patient,
  Practitioner,
  QuestionnaireResponse,
  Reference,
  RelatedPerson,
  Resource,
  Schedule,
  Slot,
  Task,
} from '@medplum/fhirtypes';
import type { MeasureDef, VisitType } from '@teleemon/core';
import {
  NPI_SYSTEM, PAYER_IDENTIFIER_SYSTEM, TAX_ID_SYSTEM, payerIdOf,
  CODE_SYSTEMS,
  CONSENT_TYPES,
  EXT,
  ICD10CM_SYSTEM,
  LICENSE_QUALIFICATION_SYSTEM,
  MEASURES,
  MRN_SYSTEM,
  PRACTICE_TIME_ZONE,
  SECURITY,
  SEED_IDENTIFIER_SYSTEM,
  findDiagnosis,
  findVisitType,
  findMedication,
  guardianContact,
  hasConfirmedGuardian,
  isMinor,
  questionnaireUrl,
  readCredentials,
  toQualification,
  zonedDate,
  zonedTime,
} from '@teleemon/core';
import { POLICY_NAMES } from './config/platform';
import { baseUrl, connect } from './lib/client';

const DAY = 86400000;
const TEST_PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';

function seedId(key: string): Identifier {
  return { system: SEED_IDENTIFIER_SYSTEM, value: key };
}

let created = 0;
let existing = 0;

async function ensure<T extends Resource>(medplum: MedplumClient, key: string, resource: T): Promise<T> {
  const before = await medplum.searchOne(resource.resourceType, { identifier: `${SEED_IDENTIFIER_SYSTEM}|${key}` });
  if (before) {
    existing++;
    if (before.resourceType === 'Patient' && resource.resourceType === 'Patient' && isMinor(before.birthDate) && !hasConfirmedGuardian(before) && (resource as Patient).contact) {
      return await medplum.updateResource({ ...before, contact: [...(before.contact ?? []), ...((resource as Patient).contact ?? [])] }) as unknown as T;
    }
    return before as unknown as T;
  }
  const withId =
    resource.resourceType === 'QuestionnaireResponse'
      ? { ...resource, identifier: seedId(key) }
      : { ...resource, identifier: [...((resource as { identifier?: Identifier[] }).identifier ?? []), seedId(key)] };
  created++;
  return medplum.createResource(withId as T);
}

function memberId(value: string): Identifier {
  return { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB', display: 'Member Number' }] }, value };
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

function isoAt(offsetDays: number, hour = 10): string {
  return zonedTime(isoDate(offsetDays), hour, 0, PRACTICE_TIME_ZONE).toISOString();
}

interface SeedPatient {
  key: string;
  given: string;
  family: string;
  dob: string;
  gender: Patient['gender'];
  pronouns: string;
  state: string;
  city: string;
  selfPay?: boolean;
  restricted?: boolean;
  optOut?: string[];
}

const PATIENTS: SeedPatient[] = [
  { key: 'pt-01', given: 'Maya', family: 'Thornton', dob: '1991-04-12', gender: 'female', pronouns: 'she/her', state: 'WA', city: 'Bellevue' },
  { key: 'pt-02', given: 'Daniel', family: 'Okafor', dob: '1986-09-30', gender: 'male', pronouns: 'he/him', state: 'CA', city: 'Oakland', selfPay: true },
  { key: 'pt-03', given: 'Priya', family: 'Raman', dob: '1998-01-22', gender: 'female', pronouns: 'she/her', state: 'WA', city: 'Redmond' },
  { key: 'pt-04', given: 'Lucas', family: 'Bennett', dob: '2010-06-03', gender: 'male', pronouns: 'he/him', state: 'WA', city: 'Kirkland' },
  { key: 'pt-05', given: 'Sofia', family: 'Delgado', dob: '1979-11-15', gender: 'female', pronouns: 'she/her', state: 'CO', city: 'Denver' },
  { key: 'pt-06', given: 'Noah', family: 'Fitzgerald', dob: '1993-03-08', gender: 'male', pronouns: 'he/him', state: 'RI', city: 'Providence' },
  { key: 'pt-07', given: 'Grace', family: 'Kim', dob: '1988-07-19', gender: 'female', pronouns: 'she/they', state: 'CA', city: 'San Diego', optOut: ['sms'] },
  { key: 'pt-08', given: 'Elijah', family: 'Morales', dob: '2001-12-27', gender: 'male', pronouns: 'he/him', state: 'WA', city: 'Seattle' },
  { key: 'pt-09', given: 'Hannah', family: 'Whitaker', dob: '1972-02-14', gender: 'female', pronouns: 'she/her', state: 'CO', city: 'Boulder' },
  { key: 'pt-10', given: 'Omar', family: 'Haddad', dob: '1995-05-05', gender: 'male', pronouns: 'he/him', state: 'WA', city: 'Tacoma', restricted: true },
];

// Today's visits, wall-clock times in the practice zone. `locatedIn` overrides the booked state
// for pt-08 to show a licensed out-of-home location. Seeded appointments remain booked until a
// patient or staff member performs an audited, licence-checked check-in.
const VISITS: { patient: string; hour: number; minute: number; code: string; locatedIn?: string }[] = [
  { patient: 'pt-01', hour: 9, minute: 0, code: 'med-mgmt' },
  { patient: 'pt-06', hour: 9, minute: 30, code: 'new-eval' },
  { patient: 'pt-03', hour: 11, minute: 0, code: 'med-mgmt-therapy' },
  { patient: 'pt-10', hour: 12, minute: 30, code: 'office-med-mgmt' },
  { patient: 'pt-02', hour: 14, minute: 0, code: 'med-mgmt' },
  { patient: 'pt-04', hour: 15, minute: 0, code: 'new-eval' },
  { patient: 'pt-08', hour: 16, minute: 30, code: 'med-mgmt', locatedIn: 'CA' },
  { patient: 'pt-05', hour: 18, minute: 0, code: 'brief' },
  { patient: 'pt-07', hour: 19, minute: 30, code: 'med-mgmt-therapy' },
];

// Visits over the next days, so reminders (P42) have something to schedule.
const UPCOMING: { days: number; patient: string; hour: number; minute: number; code: string }[] = [
  { days: 1, patient: 'pt-01', hour: 10, minute: 0, code: 'med-mgmt' },
  { days: 1, patient: 'pt-09', hour: 14, minute: 30, code: 'med-mgmt' },
  { days: 2, patient: 'pt-06', hour: 11, minute: 0, code: 'new-eval' },
  { days: 3, patient: 'pt-07', hour: 9, minute: 0, code: 'med-mgmt-therapy' },
];

const CHART: Record<string, { diagnoses: string[]; meds: { name: string; dose: string }[]; allergies: { text: string; reaction: string; severity: 'mild' | 'moderate' | 'severe' }[] | 'nka' }> = {
  'pt-01': { diagnoses: ['F90.2', 'F41.1'], meds: [{ name: 'Lisdexamfetamine', dose: '40 mg by mouth every morning' }, { name: 'Sertraline', dose: '100 mg by mouth daily' }], allergies: [{ text: 'Penicillin', reaction: 'Hives', severity: 'moderate' }] },
  'pt-02': { diagnoses: ['F41.0'], meds: [{ name: 'Escitalopram', dose: '10 mg by mouth daily' }], allergies: 'nka' },
  'pt-03': { diagnoses: ['F33.1', 'F43.10'], meds: [{ name: 'Escitalopram', dose: '20 mg by mouth daily' }, { name: 'Prazosin', dose: '2 mg by mouth at bedtime' }, { name: 'Trazodone', dose: '50 mg by mouth at bedtime as needed' }], allergies: 'nka' },
  'pt-04': { diagnoses: ['F90.0'], meds: [{ name: 'Methylphenidate', dose: 'ER 18 mg by mouth every morning' }], allergies: 'nka' },
  'pt-05': { diagnoses: ['F31.81'], meds: [{ name: 'Lithium carbonate', dose: '600 mg by mouth twice daily' }, { name: 'Lamotrigine', dose: '100 mg by mouth daily' }], allergies: [{ text: 'Sulfonamide antibiotics', reaction: 'Rash', severity: 'mild' }] },
  'pt-07': { diagnoses: ['F25.0'], meds: [{ name: 'Aripiprazole', dose: '15 mg by mouth daily' }], allergies: 'nka' },
  'pt-09': { diagnoses: ['F10.20', 'F32.1'], meds: [{ name: 'Naltrexone', dose: '50 mg by mouth daily' }, { name: 'Bupropion XL', dose: '150 mg by mouth every morning' }], allergies: 'nka' },
  'pt-10': { diagnoses: ['F43.23'], meds: [], allergies: 'nka' },
};

// Measure history: [measure, total score, days ago, PHQ-9 item 9 value].
const MEASURE_HISTORY: Record<string, [MeasureDef['key'], number, number, number?][]> = {
  'pt-01': [['phq9', 14, 120], ['phq9', 11, 85], ['phq9', 8, 50], ['phq9', 6, 14], ['gad7', 12, 120], ['gad7', 10, 85], ['gad7', 8, 50], ['gad7', 7, 14], ['asrs-a', 18, 120]],
  'pt-03': [['phq9', 18, 75], ['phq9', 16, 40], ['phq9', 13, 2, 1], ['gad7', 15, 75], ['gad7', 12, 40], ['gad7', 11, 2]],
  'pt-05': [['phq9', 9, 60], ['phq9', 7, 20]],
  'pt-09': [['audit-c', 9, 90], ['audit-c', 6, 30], ['phq9', 12, 90], ['phq9', 10, 30]],
};

async function main(): Promise<void> {
  const medplum = await connect();
  if (process.argv.includes('--guardians-only')) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl()).hostname)) throw new Error('Synthetic guardian repair is local-only.');
    const minor = await medplum.searchOne('Patient', { identifier: `${SEED_IDENTIFIER_SYSTEM}|pt-04` });
    if (!minor) throw new Error('Synthetic minor fixture is missing.');
    if (!hasConfirmedGuardian(minor)) await medplum.updateResource({ ...minor, contact: [...(minor.contact ?? []), guardianContact({ given: 'Emma', family: 'Bennett', relationship: 'Mother', phone: '425-555-0194', authority: true })] });
    console.log('✓ Synthetic minor guardian snapshot is up to date; no users, roles or other fixtures changed.');
    return;
  }
  console.log(`Seeding synthetic data into ${baseUrl()}\n`);

  const org = await ensure<Organization>(medplum, 'org-teleemon', {
    resourceType: 'Organization',
    name: 'Teleemon Behavioral Health & Wellness, PLLC',
    active: true,
    address: [{ line: ['16301 NE 8th St', 'Suite 233'], city: 'Bellevue', state: 'WA', postalCode: '98008', country: 'US' }],
  });

  const office = await ensure<Location>(medplum, 'loc-bellevue', {
    resourceType: 'Location',
    name: 'Bellevue office',
    status: 'active',
    managingOrganization: createReference(org),
    address: { line: ['16301 NE 8th St', 'Suite 233'], city: 'Bellevue', state: 'WA', postalCode: '98008' },
    type: [{ coding: [{ system: 'https://www.cms.gov/Medicare/Coding/place-of-service-codes', code: '11', display: 'Office' }] }],
  });
  await ensure<Location>(medplum, 'loc-virtual', {
    resourceType: 'Location',
    name: 'Telehealth (virtual)',
    status: 'active',
    mode: 'kind',
    managingOrganization: createReference(org),
    type: [{ coding: [{ system: 'https://www.cms.gov/Medicare/Coding/place-of-service-codes', code: '10', display: 'Telehealth in patient home' }] }],
  });

  const licence = (state: string, number: string, daysToExpiry: number): NonNullable<Practitioner['qualification']>[number] => ({
    identifier: [{ system: `${LICENSE_QUALIFICATION_SYSTEM}/${state.toLowerCase()}`, value: number }],
    code: { coding: [{ system: LICENSE_QUALIFICATION_SYSTEM, code: 'state-license' }], text: `${state} licence` },
    period: { start: isoDate(-700), end: isoDate(daysToExpiry) },
    issuer: { display: `${state} board of nursing` },
  });

  const dea = (state: string, number: string, daysToExpiry: number, schedules: string[]): NonNullable<Practitioner['qualification']>[number] =>
    toQualification({ kind: 'dea-registration', state, number, start: isoDate(-700), end: isoDate(daysToExpiry), issuer: 'Drug Enforcement Administration', schedules });

  const provider = await ensure<Practitioner>(medplum, 'prac-provider', {
    resourceType: 'Practitioner',
    active: true,
    name: [{ given: ['Jordan'], family: 'Ellis', suffix: ['PMHNP-BC'] }],
    telecom: [{ system: 'email', value: 'provider@teleemon.test' }],
    // WA and CA numbers come from the scope document; CO and RI are placeholders. Expiry dates are
    // synthetic: CO is set to lapse within 90 days so the Today alert can be verified.
    // DEA (Phase 5, synthetic numbers): WA covers every schedule; CA excludes C-II narcotics;
    // RI has expired and CO has none, so controlled prescribing is blocked in both.
    qualification: [
      licence('WA', 'AP61135663', 420), licence('CA', '95017107', 300), licence('CO', 'DEMO-CO-0001', 45), licence('RI', 'DEMO-RI-0001', 520),
      dea('WA', 'ME0000001', 600, ['2', '2N', '3', '3N', '4', '5']), dea('CA', 'ME0000002', 400, ['2N', '3', '3N', '4', '5']), dea('RI', 'ME0000003', -10, ['2', '2N', '3', '3N', '4', '5']),
    ],
  });

  // Existing local databases predate Phase 5: add the synthetic DEA registrations once.
  if (!readCredentials(provider).some((c) => c.kind === 'dea-registration')) {
    const deaQuals = [dea('WA', 'ME0000001', 600, ['2', '2N', '3', '3N', '4', '5']), dea('CA', 'ME0000002', 400, ['2N', '3', '3N', '4', '5']), dea('RI', 'ME0000003', -10, ['2', '2N', '3', '3N', '4', '5'])];
    Object.assign(provider, await medplum.updateResource({ ...provider, qualification: [...(provider.qualification ?? []), ...deaQuals] }));
    console.log('  added synthetic DEA registrations (WA, CA; RI expired) to the provider');
  }

  // Billing identifiers (Phase 8, synthetic): the practice bills as a provider organization with
  // an NPI and tax id; the provider renders under their own NPI. Both NPIs pass the check digit.
  if (!org.identifier?.some((i) => i.system === NPI_SYSTEM)) {
    Object.assign(org, await medplum.updateResource({
      ...org,
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider' }] }],
      identifier: [...(org.identifier ?? []), { system: NPI_SYSTEM, value: '1999999992' }, { system: TAX_ID_SYSTEM, value: '91-0000001' }],
    }));
    console.log('  added synthetic billing NPI and tax id to the practice');
  }
  if (!provider.identifier?.some((i) => i.system === NPI_SYSTEM)) {
    Object.assign(provider, await medplum.updateResource({ ...provider, identifier: [...(provider.identifier ?? []), { system: NPI_SYSTEM, value: '1234567893' }] }));
    console.log('  added a synthetic rendering NPI to the provider');
  }

  const schedule = await ensure<Schedule>(medplum, 'sched-provider', {
    resourceType: 'Schedule',
    active: true,
    actor: [createReference(provider), createReference(office)],
    comment: 'Mon–Sat, 9:00 AM – 9:00 PM Pacific',
  });

  // One login per role (local and staging only).
  const users = await ensureRoleUsers(medplum, provider);

  const patients = new Map<string, Patient>();
  for (const [i, p] of PATIENTS.entries()) {
    const digits = p.key.slice(-2);
    const extension: NonNullable<Patient['extension']> = [
      { url: EXT.pronouns, valueString: p.pronouns },
      { url: EXT.sexAssignedAtBirth, valueCode: p.gender === 'female' ? 'female' : 'male' },
      { url: EXT.referralSource, valueString: i % 3 === 0 ? 'Primary care referral' : i % 3 === 1 ? 'Insurer directory' : 'Website' },
      ...(p.selfPay ? [{ url: EXT.selfPay, valueBoolean: true }] : []),
      ...(p.optOut ?? []).map((c) => ({ url: EXT.contactOptOut, valueCode: c })),
    ];
    patients.set(
      p.key,
      await ensure<Patient>(medplum, p.key, {
        resourceType: 'Patient',
        active: true,
        meta: p.restricted ? { security: [{ system: SECURITY.confidentialitySystem, code: SECURITY.restricted, display: 'restricted' }] } : undefined,
        identifier: [{ system: MRN_SYSTEM, value: `TM-${String(1000 + i + 1)}` }],
        name: [{ given: [p.given], family: p.family }],
        birthDate: p.dob,
        gender: p.gender,
        telecom: [
          { system: 'phone', value: `425-555-01${digits}`, use: 'mobile' },
          { system: 'email', value: `${p.given.toLowerCase()}.${p.family.toLowerCase()}@example.com` },
        ],
        address: [{ city: p.city, state: p.state, country: 'US' }],
        communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en', display: 'English' }] }, preferred: true }],
        generalPractitioner: [createReference(provider)],
        contact: isMinor(p.dob) ? [guardianContact({ given: 'Emma', family: 'Bennett', relationship: 'Mother', phone: '425-555-0194', authority: true })] : undefined,
        extension,
      })
    );
  }
  const pt = (key: string): Patient => patients.get(key) as Patient;

  // Guardian for the minor.
  const guardian = await ensure<RelatedPerson>(medplum, 'rp-04-mother', {
    resourceType: 'RelatedPerson',
    active: true,
    patient: createReference(pt('pt-04')),
    relationship: [
      { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'MTH', display: 'mother' }] },
      { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'GUARD', display: 'guardian' }] },
    ],
    name: [{ given: ['Emily'], family: 'Bennett' }],
    telecom: [{ system: 'phone', value: '425-555-0144', use: 'mobile' }, { system: 'email', value: 'emily.bennett@example.com' }],
  });

  // Coverage (insured patients) — synthetic payer.
  for (const p of PATIENTS.filter((x) => !x.selfPay)) {
    await ensure<Coverage>(medplum, `cov-${p.key}`, {
      resourceType: 'Coverage',
      status: 'active',
      beneficiary: createReference(pt(p.key)),
      subscriber: p.key === 'pt-04' ? createReference(guardian) : createReference(pt(p.key)),
      identifier: [memberId(`XEH${p.key.slice(-2)}48213`)],
      subscriberId: `XEH${p.key.slice(-2)}48213`,
      relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: p.key === 'pt-04' ? 'child' : 'self' }] },
      payor: [{ display: 'Example Health Plan (synthetic)', identifier: { system: PAYER_IDENTIFIER_SYSTEM, value: 'payer:synthetic-commercial' } }],
      class: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] }, value: 'GRP-2201', name: 'Synthetic PPO' }],
      period: { start: '2026-01-01' },
      order: 1,
    });
  }

  // Backfill: coverages seeded before member IDs were searchable, or before payers were configured (Phase 8).
  for (const cov of await medplum.searchResources('Coverage', { _count: '100' })) {
    if (cov.identifier?.some((i) => i.system === SEED_IDENTIFIER_SYSTEM) && !payerIdOf(cov) && cov.payor?.[0]?.display === 'Example Health Plan (synthetic)') {
      Object.assign(cov, await medplum.updateResource({ ...cov, payor: [{ ...cov.payor[0], identifier: { system: PAYER_IDENTIFIER_SYSTEM, value: 'payer:synthetic-commercial' } }] }));
    }
    if (cov.subscriberId && !cov.identifier?.some((i) => i.value === cov.subscriberId)) {
      await medplum.updateResource({ ...cov, identifier: [...(cov.identifier ?? []), memberId(cov.subscriberId)] });
    }
  }

  // Problems, medications and allergies.
  for (const [key, chart] of Object.entries(CHART)) {
    const patient = pt(key);
    for (const code of chart.diagnoses) {
      const dx = findDiagnosis(code);
      await ensure<Condition>(medplum, `dx-${key}-${code}`, {
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        code: { coding: [{ system: ICD10CM_SYSTEM, code, display: dx?.display }], text: dx?.display },
        subject: createReference(patient),
        onsetDateTime: isoDate(-400),
        recordedDate: isoDate(-150),
        recorder: createReference(provider),
      });
    }
    for (const med of chart.meds) {
      const entry = findMedication(med.name);
      await ensure<MedicationStatement>(medplum, `med-${key}-${med.name}`, {
        resourceType: 'MedicationStatement',
        status: 'active',
        medicationCodeableConcept: { text: med.name },
        subject: createReference(patient),
        effectivePeriod: { start: isoDate(-140) },
        dateAsserted: isoDate(-14),
        informationSource: createReference(provider),
        dosage: [{ text: med.dose }],
        extension: entry?.schedule ? [{ url: EXT.controlledSchedule, valueCode: entry.schedule }] : undefined,
      });
    }
    if (chart.allergies === 'nka') {
      await ensure<AllergyIntolerance>(medplum, `alg-${key}-nka`, {
        resourceType: 'AllergyIntolerance',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
        code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergies' },
        patient: createReference(patient),
        recordedDate: isoDate(-150),
      });
    } else {
      for (const a of chart.allergies) {
        await ensure<AllergyIntolerance>(medplum, `alg-${key}-${a.text}`, {
          resourceType: 'AllergyIntolerance',
          clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
          verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
          category: ['medication'],
          code: { text: a.text },
          patient: createReference(patient),
          reaction: [{ manifestation: [{ text: a.reaction }], severity: a.severity }],
          recordedDate: isoDate(-150),
        });
      }
    }
  }

  // Consents. pt-03 has no recording consent; the minor's are signed by the guardian;
  // pt-01 (on a stimulant) has a controlled-substance agreement.
  for (const p of PATIENTS) {
    const types = CONSENT_TYPES.filter((t) => ['treatment', 'telehealth', 'recording', 'financial', 'privacy-notice'].includes(t.code))
      .filter((t) => !(p.key === 'pt-03' && t.code === 'recording'))
      .concat(p.key === 'pt-01' ? CONSENT_TYPES.filter((t) => t.code === 'controlled-substance') : []);
    if (p.key === 'pt-06') continue; // New patient: intake not yet completed.
    for (const t of types) {
      await ensure<Consent>(medplum, `consent-${p.key}-${t.code}`, {
        resourceType: 'Consent',
        status: 'active',
        scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: t.code === 'privacy-notice' ? 'patient-privacy' : 'treatment' }] },
        category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: t.code, display: t.display }] }],
        patient: createReference(pt(p.key)),
        dateTime: isoAt(-150),
        performer: [p.key === 'pt-04' ? createReference(guardian) : createReference(pt(p.key))],
        organization: [createReference(org)],
        policyRule: { text: `Teleemon ${t.display}, version 2026.1` },
        provision: { type: 'permit', period: { start: isoDate(-150), end: t.code === 'controlled-substance' ? isoDate(215) : undefined } },
        extension: [{ url: EXT.consentMethod, valueCode: 'portal-esignature' }],
      });
    }
  }

  // Past visits for the overview timeline and encounters list.
  const pastVisits: [string, number, string][] = [
    ['pt-01', 120, 'New patient evaluation (90792)'], ['pt-01', 85, 'Medication management (99214)'], ['pt-01', 50, 'Medication management (99214)'], ['pt-01', 14, 'Medication management (99213)'],
    ['pt-03', 75, 'New patient evaluation (90792)'], ['pt-03', 40, 'Med management + psychotherapy (99214 + 90836)'], ['pt-03', 2, 'Med management + psychotherapy (99214 + 90836)'],
    ['pt-05', 60, 'Medication management (99214)'], ['pt-05', 20, 'Brief check-in'],
    ['pt-09', 90, 'New patient evaluation (90792)'], ['pt-09', 30, 'Medication management (99214)'],
  ];
  for (const [key, daysAgo, type] of pastVisits) {
    const start = isoAt(-daysAgo, 11);
    const homeState = PATIENTS.find((p) => p.key === key)?.state as string;
    await ensure<Encounter>(medplum, `enc-${key}-${daysAgo}`, {
      resourceType: 'Encounter',
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR', display: 'virtual' },
      type: [{ text: type }],
      subject: createReference(pt(key)),
      participant: [{ individual: createReference(provider) }],
      period: { start, end: new Date(new Date(start).getTime() + 30 * 60000).toISOString() },
      serviceProvider: createReference(org),
      extension: [
        { url: EXT.modality, valueCode: 'video' },
        { url: EXT.patientLocationState, valueCode: homeState },
      ],
    });
  }

  // Measure history. The measure-scoring Bot turns each into a score Observation, and pt-03's
  // most recent PHQ-9 (item 9 = 1) into a safety Flag and an urgent Task.
  for (const [key, entries] of Object.entries(MEASURE_HISTORY)) {
    for (const [measure, total, daysAgo, item9] of entries) {
      const def = MEASURES[measure];
      const values = distribute(def, total, item9);
      await ensure<QuestionnaireResponse>(medplum, `qr-${key}-${measure}-${daysAgo}`, {
        resourceType: 'QuestionnaireResponse',
        questionnaire: questionnaireUrl(def.key),
        status: 'completed',
        subject: createReference(pt(key)),
        authored: isoAt(-daysAgo, 9),
        source: createReference(pt(key)),
        item: def.items.map((item, i) => ({
          linkId: item.linkId,
          text: item.text,
          answer: [{ valueCoding: { code: String(values[i]), display: item.options.find((o) => o.value === values[i])?.label } }],
        })),
      });
    }
  }

  // Today's schedule, blocked time and the next few days.
  const ymd = zonedDate(new Date());
  const now = Date.now();
  const appointment = (start: Date, code: string, patientKey: string, status: Appointment['status'], locatedIn?: string): Appointment => {
    const vt = findVisitType(code) as VisitType;
    const homeState = PATIENTS.find((p) => p.key === patientKey)?.state as string;
    return {
      resourceType: 'Appointment',
      status,
      start: start.toISOString(),
      end: new Date(start.getTime() + vt.minutes * 60000).toISOString(),
      minutesDuration: vt.minutes,
      appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: vt.code, display: vt.label }], text: vt.label },
      extension: [
        { url: EXT.modality, valueCode: vt.modality },
        { url: EXT.patientLocationState, valueCode: locatedIn ?? homeState },
      ],
      participant: [
        { actor: createReference(pt(patientKey)), status: 'accepted' },
        { actor: createReference(provider), status: 'accepted' },
        ...(vt.modality === 'office' ? [{ actor: createReference(office), status: 'accepted' as const }] : []),
      ],
    };
  };
  for (const [i, v] of VISITS.entries()) {
    const start = zonedTime(ymd, v.hour, v.minute, PRACTICE_TIME_ZONE);
    const end = start.getTime() + (findVisitType(v.code)?.minutes ?? 30) * 60000;
    let status: Appointment['status'];
    if (end < now) status = i === 1 ? 'noshow' : 'fulfilled';
    else status = 'booked';
    await ensure<Appointment>(medplum, `appt-${ymd}-${i}`, appointment(start, v.code, v.patient, status, v.locatedIn));
  }
  await ensure<Slot>(medplum, `block-${ymd}`, {
    resourceType: 'Slot',
    schedule: createReference(schedule),
    status: 'busy-unavailable',
    start: zonedTime(ymd, 13, 0, PRACTICE_TIME_ZONE).toISOString(),
    end: zonedTime(ymd, 14, 0, PRACTICE_TIME_ZONE).toISOString(),
    comment: 'Lunch and admin time',
  });
  for (const u of UPCOMING) {
    let day = new Date(Date.parse(`${ymd}T12:00:00Z`) + u.days * 86400000).toISOString().slice(0, 10);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === 0) day = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    await ensure<Appointment>(medplum, `appt-${day}-${u.patient}`, appointment(zonedTime(day, u.hour, u.minute, PRACTICE_TIME_ZONE), u.code, u.patient, 'booked'));
  }

  const tasks: { key: string; text: string; patient: string; hoursAgo: number; priority: Task['priority']; owner: Reference<Practitioner> }[] = [
    { key: 'task-01', text: 'Call patient back about sleep side effects', patient: 'pt-03', hoursAgo: 30, priority: 'urgent', owner: createReference(provider) },
    { key: 'task-02', text: 'Request outside records from previous psychiatrist', patient: 'pt-06', hoursAgo: 52, priority: 'routine', owner: users.frontdesk },
    { key: 'task-03', text: 'Confirm guardian consent form is on file', patient: 'pt-04', hoursAgo: 3, priority: 'routine', owner: users.frontdesk },
    { key: 'task-04', text: 'Review lithium level due this month', patient: 'pt-05', hoursAgo: 20, priority: 'routine', owner: createReference(provider) },
  ];
  for (const t of tasks) {
    await ensure<Task>(medplum, t.key, {
      resourceType: 'Task',
      status: 'requested',
      intent: 'order',
      priority: t.priority,
      code: { text: 'Follow-up' },
      description: t.text,
      for: createReference(pt(t.patient)),
      owner: t.owner,
      authoredOn: new Date(now - t.hoursAgo * 3600000).toISOString(),
    });
  }

  const messages: { key: string; patient: string; text: string; hoursAgo: number }[] = [
    { key: 'msg-01', patient: 'pt-02', text: 'Can I move my next appointment to an evening slot?', hoursAgo: 5 },
    { key: 'msg-02', patient: 'pt-09', text: 'The pharmacy says my prescription needs prior authorization.', hoursAgo: 26 },
  ];
  for (const m of messages) {
    const patient = pt(m.patient);
    await ensure<Communication>(medplum, m.key, {
      resourceType: 'Communication',
      status: 'in-progress',
      subject: createReference(patient),
      sender: createReference(patient),
      recipient: [createReference(provider)],
      sent: new Date(now - m.hoursAgo * 3600000).toISOString(),
      payload: [{ contentString: m.text }],
    });
  }

  console.log(`✓ Done: ${created} created, ${existing} already present`);
  console.log(`  Provider: ${getReferenceString(provider)} · ${PATIENTS.length} patients · ${VISITS.length} visits on ${ymd}`);
  console.log(`\nRole logins (password ${TEST_PASSWORD}):`);
  console.log('  admin@teleemon.test      Administrator');
  console.log('  provider@teleemon.test   Provider (Jordan Ellis)');
  console.log('  frontdesk@teleemon.test  Front desk');
  console.log('  biller@teleemon.test     Biller');
}

/** Spreads a total over a measure's items, respecting each item's maximum; PHQ-9 item 9 is set explicitly. */
function distribute(def: MeasureDef, total: number, item9 = 0): number[] {
  const values = def.items.map(() => 0);
  const fixed = def.key === 'phq9' ? 8 : -1;
  if (fixed >= 0) values[fixed] = item9;
  let remaining = total - (fixed >= 0 ? item9 : 0);
  for (let round = 0; remaining > 0 && round < 10; round++) {
    for (let i = 0; i < values.length && remaining > 0; i++) {
      const max = Math.max(...def.items[i].options.map((o) => o.value));
      if (i !== fixed && values[i] < max) {
        values[i]++;
        remaining--;
      }
    }
  }
  return values;
}

async function ensureRoleUsers(medplum: MedplumClient, provider: Practitioner): Promise<{ frontdesk: Reference<Practitioner> }> {
  const projectId = process.env.TELEEMON_PROJECT_ID as string;
  const policy = async (name: string): Promise<Reference> => {
    const p = await medplum.searchOne('AccessPolicy', { 'name:exact': name });
    if (!p) throw new Error(`AccessPolicy "${name}" not found. Run \`npm run setup\` first.`);
    return { reference: getReferenceString(p), display: name };
  };

  const invite = async (email: string, firstName: string, lastName: string, policyName: string, profile?: Practitioner): Promise<Reference<Practitioner>> => {
    const target = profile ?? (await medplum.searchOne('Practitioner', { email }));
    const already = target ? await medplum.searchOne('ProjectMembership', { profile: getReferenceString(target) }) : undefined;
    if (already?.profile) {
      return already.profile as Reference<Practitioner>;
    }
    const membership = await medplum.post<{ profile: Reference }>(`admin/projects/${projectId}/invite`, {
      resourceType: 'Practitioner',
      firstName,
      lastName,
      email,
      password: TEST_PASSWORD,
      sendEmail: false,
      scope: 'server',
      membership: { accessPolicy: await policy(policyName), ...(profile ? { profile: createReference(profile) } : {}) },
    });
    created++;
    return membership.profile as Reference<Practitioner>;
  };

  await invite('provider@teleemon.test', 'Jordan', 'Ellis', POLICY_NAMES.provider, provider);
  const frontdesk = await invite('frontdesk@teleemon.test', 'Riley', 'Chen', POLICY_NAMES.frontdesk);
  await invite('biller@teleemon.test', 'Sam', 'Okonkwo', POLICY_NAMES.biller);
  return { frontdesk };
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : JSON.stringify(err)}`);
  process.exit(1);
});
