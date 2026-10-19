import { Accordion, Alert, Button, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Patient, PatientContact } from '@medplum/fhirtypes';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  EMPLOYMENT_STATUSES, ETHNICITIES, EXT, GENDER_IDENTITIES, MARITAL_STATUSES, MARITAL_SYSTEM, PRONOUNS, RACES, SEXUAL_ORIENTATIONS, US_CORE_ETHNICITY, US_CORE_RACE, US_STATES,
  genderForSex, normalizePhone, sexAtBirth,
} from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useSession } from '../../session';
import type { StepProps } from '../IntakePage';

const EMERGENCY = { system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'C', display: 'Emergency Contact' };
const isEmergency = (c: PatientContact): boolean => !!c.relationship?.some((r) => r.coding?.some((x) => x.code === 'C'));
const SEX_OPTIONS = [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'unknown', label: 'Intersex or not listed' }];
const LANGUAGES = ['English', 'Spanish', 'Other'];

const textExt = (p: Patient, url: string): string => {
  const e = p.extension?.find((x) => x.url === url);
  return e?.valueString ?? e?.valueCodeableConcept?.text ?? e?.extension?.find((x) => x.url === 'text')?.valueString ?? '';
};

/** The details a patient may change themselves (the Patient Bot refuses anything else). */
export function editableContact(p: Patient) {
  const address = p.address?.find((a) => a.use === 'home') ?? p.address?.[0];
  const emergency = p.contact?.find(isEmergency);
  const firstRank = p.telecom?.find((t) => t.rank === 1)?.system;
  return {
    sexAtBirth: sexAtBirth(p) ?? '',
    preferred: p.name?.find((n) => n.use === 'nickname')?.given?.[0] ?? '',
    genderIdentity: textExt(p, EXT.genderIdentity),
    phone: p.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    preferredContact: firstRank === 'email' ? 'email' : 'sms',
    language: p.communication?.find((c) => c.preferred)?.language.coding?.[0]?.display ?? 'English',
    line: address?.line?.[0] ?? '',
    line2: address?.line?.[1] ?? '',
    city: address?.city ?? '',
    state: address?.state ?? '',
    postalCode: address?.postalCode ?? '',
    pronouns: p.extension?.find((e) => e.url === EXT.pronouns)?.valueString ?? '',
    pharmacy: p.extension?.find((e) => e.url === EXT.preferredPharmacy)?.valueString ?? '',
    ecName: emergency ? emergency.name?.text ?? [emergency.name?.given?.[0], emergency.name?.family].filter(Boolean).join(' ') : '',
    ecRelationship: emergency?.relationship?.find((r) => r.text)?.text ?? '',
    ecPhone: emergency?.telecom?.find((t) => t.system === 'phone')?.value ?? '',
    race: textExt(p, US_CORE_RACE),
    ethnicity: textExt(p, US_CORE_ETHNICITY),
    sexualOrientation: textExt(p, EXT.sexualOrientation),
    maritalStatus: p.maritalStatus?.coding?.[0]?.code ?? '',
    employment: textExt(p, EXT.employmentStatus),
  };
}

export type ContactForm = ReturnType<typeof editableContact>;

/** Same storage as staff registration (apps/staff/src/fhir/patientForm.ts), so both screens agree. */
export function applyContact(p: Patient, v: ContactForm): Patient {
  const phone = normalizePhone(v.phone) ?? v.phone.trim();
  const email = p.telecom?.find((t) => t.system === 'email');
  const telecom = [
    ...(p.telecom ?? []).filter((t) => t.system !== 'phone' && t.system !== 'email'),
    ...(phone ? [{ system: 'phone' as const, value: phone, use: 'mobile' as const, rank: v.preferredContact === 'email' ? 2 : 1 }] : []),
    ...(email ? [{ ...email, rank: v.preferredContact === 'email' ? 1 : 2 }] : []),
  ];
  const otherAddresses = (p.address ?? []).filter((a) => a.use && a.use !== 'home');
  const address = v.line.trim() ? [{ use: 'home' as const, line: [v.line.trim(), v.line2.trim()].filter(Boolean), city: v.city.trim(), state: v.state, postalCode: v.postalCode.trim(), country: 'US' }, ...otherAddresses] : p.address;
  const managed = [EXT.pronouns, EXT.preferredPharmacy, EXT.genderIdentity, EXT.sexualOrientation, EXT.employmentStatus, US_CORE_RACE, US_CORE_ETHNICITY];
  const newSex = !sexAtBirth(p) && v.sexAtBirth ? v.sexAtBirth : undefined;
  const extension = [
    ...(p.extension ?? []).filter((e) => !managed.includes(e.url)),
    ...(newSex ? [{ url: EXT.sexAssignedAtBirth, valueCode: newSex }] : []),
    ...(v.pronouns ? [{ url: EXT.pronouns, valueString: v.pronouns }] : []),
    ...(v.pharmacy.trim() ? [{ url: EXT.preferredPharmacy, valueString: v.pharmacy.trim().slice(0, 300) }] : []),
    ...(v.genderIdentity ? [{ url: EXT.genderIdentity, valueCodeableConcept: { text: v.genderIdentity } }] : []),
    ...(v.sexualOrientation ? [{ url: EXT.sexualOrientation, valueCodeableConcept: { text: v.sexualOrientation } }] : []),
    ...(v.employment ? [{ url: EXT.employmentStatus, valueString: v.employment }] : []),
    ...(v.race ? [{ url: US_CORE_RACE, extension: [{ url: 'text', valueString: v.race }] }] : []),
    ...(v.ethnicity ? [{ url: US_CORE_ETHNICITY, extension: [{ url: 'text', valueString: v.ethnicity }] }] : []),
  ];
  const [given, ...rest] = v.ecName.trim().split(/\s+/);
  const contact = [
    ...(p.contact ?? []).filter((c) => !isEmergency(c)),
    ...(v.ecName.trim() && v.ecPhone.trim() ? [{
      relationship: [{ coding: [EMERGENCY], text: v.ecRelationship.trim() || 'Emergency contact' }],
      name: { given: given ? [given] : undefined, family: rest.join(' ') || undefined },
      telecom: [{ system: 'phone' as const, value: normalizePhone(v.ecPhone) ?? v.ecPhone.trim() }],
    }] : []),
  ];
  const marital = MARITAL_STATUSES.find((m) => m.code === v.maritalStatus);
  return {
    ...p,
    // Only the preferred name is the patient's to change; legal names stay as registered.
    name: [...(p.name ?? []).filter((n) => n.use !== 'nickname'), ...(v.preferred.trim() ? [{ use: 'nickname' as const, given: [v.preferred.trim()] }] : [])],
    ...(newSex ? { gender: genderForSex(newSex) } : {}),
    telecom,
    address,
    communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: v.language === 'Spanish' ? 'es' : 'en', display: v.language }] }, preferred: true }],
    maritalStatus: marital ? { coding: [{ system: MARITAL_SYSTEM, code: marital.code, display: marital.label }] } : undefined,
    extension: extension.length ? extension : undefined,
    contact: contact.length ? contact : undefined,
  };
}

export function ContactFields({ value, onChange, sexLocked }: { readonly value: ContactForm; readonly onChange: (v: ContactForm) => void; readonly sexLocked: boolean }): JSX.Element {
  const set = (k: keyof ContactForm) => (e: { currentTarget: { value: string } }) => onChange({ ...value, [k]: e.currentTarget.value });
  const pick = (k: keyof ContactForm) => (v: string | null) => onChange({ ...value, [k]: v ?? '' });
  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <TextInput label="Preferred name (optional)" description="What you would like us to call you." value={value.preferred} onChange={set('preferred')} maxLength={60} />
        {sexLocked ? (
          <TextInput label="Sex assigned at birth" value={SEX_OPTIONS.find((o) => o.value === value.sexAtBirth)?.label ?? ''} readOnly description="To correct this, send us a message." />
        ) : (
          <Select label="Sex assigned at birth" required data={SEX_OPTIONS} value={value.sexAtBirth || null} onChange={pick('sexAtBirth')} description="Used for some questionnaire scoring and insurance claims." />
        )}
        <Select label="Gender identity (optional)" data={[...GENDER_IDENTITIES]} clearable value={value.genderIdentity || null} onChange={pick('genderIdentity')} />
        <Select label="Pronouns (optional)" data={[...PRONOUNS]} clearable value={value.pronouns || null} onChange={pick('pronouns')} />
      </SimpleGrid>
      <Title order={3} mt="sm">Contact</Title>
      <TextInput label="Mobile phone" type="tel" autoComplete="tel-national" value={value.phone} onChange={set('phone')} error={value.phone && !normalizePhone(value.phone) ? 'Enter a 10-digit number' : undefined} />
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <div>
          <Text size="sm" fw={500} mb={4}>How should we contact you?</Text>
          <SegmentedControl fullWidth value={value.preferredContact} onChange={(v) => onChange({ ...value, preferredContact: v })} data={[{ value: 'sms', label: 'Phone or text' }, { value: 'email', label: 'Email' }]} />
        </div>
        <Select label="Preferred language" data={LANGUAGES} value={value.language} onChange={(v) => onChange({ ...value, language: v ?? 'English' })} />
      </SimpleGrid>
      <TextInput label="Home address" autoComplete="address-line1" value={value.line} onChange={set('line')} />
      <TextInput label="Apartment, suite (optional)" autoComplete="address-line2" value={value.line2} onChange={set('line2')} />
      <SimpleGrid cols={{ base: 1, xs: 3 }}>
        <TextInput label="City" autoComplete="address-level2" value={value.city} onChange={set('city')} />
        <Select label="State" data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} searchable value={value.state || null} onChange={pick('state')} />
        <TextInput label="ZIP code" autoComplete="postal-code" inputMode="numeric" value={value.postalCode} onChange={set('postalCode')} />
      </SimpleGrid>
      <TextInput label="Preferred pharmacy (name and address)" value={value.pharmacy} onChange={set('pharmacy')} />
      <Title order={3} mt="sm">Emergency contact</Title>
      <SimpleGrid cols={{ base: 1, xs: 3 }}>
        <TextInput label="Name" value={value.ecName} onChange={set('ecName')} />
        <TextInput label="Relationship" value={value.ecRelationship} onChange={set('ecRelationship')} />
        <TextInput label="Phone" type="tel" value={value.ecPhone} onChange={set('ecPhone')} />
      </SimpleGrid>
      <Accordion variant="contained" radius="md">
        <Accordion.Item value="more">
          <Accordion.Control>More about you (optional)</Accordion.Control>
          <Accordion.Panel>
            <Text size="sm" c="dimmed" mb="sm">These help us understand who we serve. Every question has "Prefer not to say", and skipping them does not affect your care.</Text>
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <Select label="Race" data={[...RACES]} clearable value={value.race || null} onChange={pick('race')} />
              <Select label="Ethnicity" data={[...ETHNICITIES]} clearable value={value.ethnicity || null} onChange={pick('ethnicity')} />
              <Select label="Sexual orientation" data={[...SEXUAL_ORIENTATIONS]} clearable value={value.sexualOrientation || null} onChange={pick('sexualOrientation')} />
              <Select label="Marital status" data={MARITAL_STATUSES.map((m) => ({ value: m.code, label: m.label }))} clearable value={value.maritalStatus || null} onChange={pick('maritalStatus')} />
              <Select label="Work" data={[...EMPLOYMENT_STATUSES]} clearable value={value.employment || null} onChange={pick('employment')} />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

export const contactComplete = (v: ContactForm): boolean =>
  !!v.sexAtBirth && !!normalizePhone(v.phone) && !!v.line.trim() && !!v.city.trim() && !!v.state && /^\d{5}(-\d{4})?$/.test(v.postalCode.trim()) && !!v.ecName.trim() && !!normalizePhone(v.ecPhone);

export function AboutStep({ overview, saved }: StepProps): JSX.Element {
  const { medplum } = useSession();
  const [value, setValue] = useState(() => editableContact(overview.patient));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const current = await medplum.readResource('Patient', overview.patient.id as string, { cache: 'no-cache' });
      await medplum.updateResource(applyContact(current, value));
      saved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Text size="sm" c="dimmed">Legal name and date of birth: {overview.patient.name?.find((n) => n.use !== 'nickname')?.given?.join(' ')} {overview.patient.name?.find((n) => n.use !== 'nickname')?.family}, {overview.patient.birthDate}. To correct these, send us a message.</Text>
      <ContactFields value={value} onChange={setValue} sexLocked={!!sexAtBirth(overview.patient)} />
      {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      <Group justify="flex-end"><Button loading={busy} disabled={!contactComplete(value)} onClick={() => void save()}>Save and continue</Button></Group>
    </Stack>
  );
}
