import { getExtensionValue } from '@medplum/core';
import type { Extension, Patient, PatientContact } from '@medplum/fhirtypes';
import { EXT, MARITAL_STATUSES, MARITAL_SYSTEM, US_CORE_ETHNICITY, US_CORE_RACE, isValidNpi, normalizePhone } from '@teleemon/core';

// Patient <-> form values for registration (P08) and demographics editing (P10).
// toPatient() merges into the existing record so fields this form doesn't manage are preserved.

const EMERGENCY_CONTACT = { system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'C', display: 'Emergency Contact' };

export const MARITAL = MARITAL_STATUSES;

export interface PatientFormValues {
  given: string;
  middle: string;
  family: string;
  preferred: string;
  birthDate: string;
  sexAtBirth: string;
  genderIdentity: string;
  pronouns: string;
  phone: string;
  email: string;
  line: string;
  city: string;
  state: string;
  postalCode: string;
  preferredContact: string;
  language: string;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyPhone: string;
  race: string;
  ethnicity: string;
  sexualOrientation: string;
  maritalStatus: string;
  employment: string;
  referralSource: string;
  referringName: string;
  referringNpi: string;
  optOutSms: boolean;
  optOutEmail: boolean;
  optOutVoice: boolean;
}

export const EMPTY_PATIENT_FORM: PatientFormValues = {
  given: '', middle: '', family: '', preferred: '', birthDate: '', sexAtBirth: '', genderIdentity: '', pronouns: '',
  phone: '', email: '', line: '', city: '', state: '', postalCode: '', preferredContact: 'sms', language: 'English',
  emergencyName: '', emergencyRelationship: '', emergencyPhone: '',
  race: '', ethnicity: '', sexualOrientation: '', maritalStatus: '', employment: '',
  referralSource: '', referringName: '', referringNpi: '',
  optOutSms: false, optOutEmail: false, optOutVoice: false,
};

const textExt = (url: string, p: Patient): string => {
  const ext = p.extension?.find((e) => e.url === url);
  return ext?.valueString ?? ext?.valueCodeableConcept?.text ?? ext?.extension?.find((x) => x.url === 'text')?.valueString ?? '';
};

export function fromPatient(p: Patient): PatientFormValues {
  const name = p.name?.find((n) => n.use !== 'nickname') ?? p.name?.[0];
  const nick = p.name?.find((n) => n.use === 'nickname');
  const addr = p.address?.[0];
  const emergency = p.contact?.find((c) => c.relationship?.some((r) => r.coding?.some((x) => x.code === 'C')));
  const optOut = (p.extension ?? []).filter((e) => e.url === EXT.contactOptOut).map((e) => e.valueCode);
  const referring = p.extension?.find((e) => e.url === EXT.referringClinician);
  return {
    ...EMPTY_PATIENT_FORM,
    given: name?.given?.[0] ?? '',
    middle: name?.given?.slice(1).join(' ') ?? '',
    family: name?.family ?? '',
    preferred: nick?.given?.[0] ?? '',
    birthDate: p.birthDate ?? '',
    sexAtBirth: (getExtensionValue(p, EXT.sexAssignedAtBirth) as string | undefined) ?? '',
    genderIdentity: textExt(EXT.genderIdentity, p),
    pronouns: (getExtensionValue(p, EXT.pronouns) as string | undefined) ?? '',
    phone: p.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    email: p.telecom?.find((t) => t.system === 'email')?.value ?? '',
    line: addr?.line?.join(', ') ?? '',
    city: addr?.city ?? '',
    state: addr?.state ?? '',
    postalCode: addr?.postalCode ?? '',
    preferredContact: p.telecom?.find((t) => t.rank === 1)?.system === 'email' ? 'email' : p.telecom?.find((t) => t.rank === 1)?.system === 'phone' ? 'phone' : 'sms',
    language: p.communication?.find((c) => c.preferred)?.language.coding?.[0]?.display ?? p.communication?.[0]?.language.text ?? 'English',
    emergencyName: emergency?.name?.text ?? [emergency?.name?.given?.join(' '), emergency?.name?.family].filter(Boolean).join(' '),
    emergencyRelationship: emergency?.relationship?.find((r) => r.text)?.text ?? '',
    emergencyPhone: emergency?.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    race: textExt(US_CORE_RACE, p),
    ethnicity: textExt(US_CORE_ETHNICITY, p),
    sexualOrientation: textExt(EXT.sexualOrientation, p),
    maritalStatus: p.maritalStatus?.coding?.[0]?.code ?? '',
    employment: textExt(EXT.employmentStatus, p),
    referralSource: textExt(EXT.referralSource, p),
    referringName: referring?.valueReference?.display ?? referring?.extension?.find((x) => x.url === 'name')?.valueString ?? '',
    referringNpi: referring?.extension?.find((x) => x.url === 'npi')?.valueString ?? '',
    optOutSms: optOut.includes('sms'),
    optOutEmail: optOut.includes('email'),
    optOutVoice: optOut.includes('voice'),
  };
}

const MANAGED_EXTENSIONS = [
  EXT.pronouns, EXT.sexAssignedAtBirth, EXT.genderIdentity, EXT.sexualOrientation, EXT.referralSource,
  EXT.referringClinician, EXT.contactOptOut, US_CORE_RACE, US_CORE_ETHNICITY,
  EXT.employmentStatus,
];

export function toPatient(v: PatientFormValues, existing?: Patient): Patient {
  const ext: Extension[] = (existing?.extension ?? []).filter((e) => !MANAGED_EXTENSIONS.includes(e.url));
  const push = (url: string, e: Omit<Extension, 'url'>): void => {
    ext.push({ url, ...e });
  };
  if (v.pronouns) push(EXT.pronouns, { valueString: v.pronouns });
  if (v.sexAtBirth) push(EXT.sexAssignedAtBirth, { valueCode: v.sexAtBirth });
  if (v.genderIdentity) push(EXT.genderIdentity, { valueCodeableConcept: { text: v.genderIdentity } });
  if (v.sexualOrientation) push(EXT.sexualOrientation, { valueCodeableConcept: { text: v.sexualOrientation } });
  if (v.race) push(US_CORE_RACE, { extension: [{ url: 'text', valueString: v.race }] });
  if (v.ethnicity) push(US_CORE_ETHNICITY, { extension: [{ url: 'text', valueString: v.ethnicity }] });
  if (v.employment) push(EXT.employmentStatus, { valueString: v.employment });
  if (v.referralSource) push(EXT.referralSource, { valueString: v.referralSource });
  if (v.referringName || v.referringNpi) {
    push(EXT.referringClinician, {
      extension: [
        ...(v.referringName ? [{ url: 'name', valueString: v.referringName }] : []),
        ...(v.referringNpi ? [{ url: 'npi', valueString: v.referringNpi }] : []),
      ],
    });
  }
  if (v.optOutSms) push(EXT.contactOptOut, { valueCode: 'sms' });
  if (v.optOutEmail) push(EXT.contactOptOut, { valueCode: 'email' });
  if (v.optOutVoice) push(EXT.contactOptOut, { valueCode: 'voice' });

  const phone = normalizePhone(v.phone) ?? v.phone.trim();
  const contact: PatientContact[] = (existing?.contact ?? []).filter((c) => !c.relationship?.some((r) => r.coding?.some((x) => x.code === 'C')));
  if (v.emergencyName.trim()) {
    contact.push({
      relationship: [{ coding: [EMERGENCY_CONTACT] }, ...(v.emergencyRelationship ? [{ text: v.emergencyRelationship }] : [])],
      name: { text: v.emergencyName.trim() },
      telecom: v.emergencyPhone ? [{ system: 'phone', value: normalizePhone(v.emergencyPhone) ?? v.emergencyPhone }] : undefined,
    });
  }

  return {
    ...existing,
    resourceType: 'Patient',
    active: existing?.active ?? true,
    name: [
      { use: 'official', given: [v.given.trim(), ...v.middle.split(/\s+/).filter(Boolean)], family: v.family.trim() },
      ...(v.preferred.trim() ? [{ use: 'nickname' as const, given: [v.preferred.trim()] }] : []),
    ],
    birthDate: v.birthDate,
    gender: v.sexAtBirth === 'female' ? 'female' : v.sexAtBirth === 'male' ? 'male' : 'unknown',
    telecom: [
      ...(phone ? [{ system: 'phone' as const, value: phone, use: 'mobile' as const, rank: v.preferredContact !== 'email' ? 1 : 2 }] : []),
      ...(v.email.trim() ? [{ system: 'email' as const, value: v.email.trim().toLowerCase(), rank: v.preferredContact === 'email' ? 1 : 2 }] : []),
    ],
    address: [{ line: v.line.trim() ? [v.line.trim()] : undefined, city: v.city.trim() || undefined, state: v.state, postalCode: v.postalCode.trim() || undefined, country: 'US' }],
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: v.language === 'Spanish' ? 'es' : 'en', display: v.language }] }, preferred: true }],
    maritalStatus: v.maritalStatus ? { coding: [{ system: MARITAL_SYSTEM, code: v.maritalStatus, display: MARITAL.find((m) => m.code === v.maritalStatus)?.label }] } : undefined,
    contact: contact.length ? contact : undefined,
    extension: ext,
  };
}

/** Field-level validation shared by registration and editing. */
export function validatePatient(v: PatientFormValues): Partial<Record<keyof PatientFormValues, string>> {
  const errors: Partial<Record<keyof PatientFormValues, string>> = {};
  if (!v.given.trim()) errors.given = 'First name is required';
  if (!v.family.trim()) errors.family = 'Last name is required';
  if (!v.birthDate) errors.birthDate = 'Date of birth is required';
  else if (v.birthDate > new Date().toISOString().slice(0, 10)) errors.birthDate = 'Date of birth cannot be in the future';
  else if (v.birthDate < '1900-01-01') errors.birthDate = 'Check the year';
  if (!v.sexAtBirth) errors.sexAtBirth = 'Required for clinical reference ranges and claims';
  if (!v.phone.trim()) errors.phone = 'A phone number is required for reminders and call-back';
  else if (!normalizePhone(v.phone)) errors.phone = 'Enter a 10-digit US phone number';
  if (!v.email.trim()) errors.email = 'Email is required for the patient portal';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) errors.email = 'Enter a valid email address';
  if (!v.state) errors.state = 'Home state is required';
  if (v.postalCode && !/^\d{5}(-\d{4})?$/.test(v.postalCode.trim())) errors.postalCode = 'Use a 5-digit ZIP code';
  if (!v.emergencyName.trim()) errors.emergencyName = 'An emergency contact is required';
  if (v.emergencyName.trim() && !normalizePhone(v.emergencyPhone)) errors.emergencyPhone = 'Enter a 10-digit phone number';
  if (v.referringNpi && !isValidNpi(v.referringNpi.trim())) errors.referringNpi = 'This NPI fails the check digit. Check for a typo.';
  return errors;
}

