import { Checkbox, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { EMPLOYMENT_STATUSES, ETHNICITIES, GENDER_IDENTITIES, LICENSED_STATES, PRONOUNS, RACES, REFERRAL_SOURCES, SEXUAL_ORIENTATIONS, US_STATES } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import type { PatientFormValues } from '../fhir/patientForm';
import { MARITAL } from '../fhir/patientForm';

const STATE_OPTIONS = US_STATES.map((s) => ({
  value: s.code,
  label: `${s.name}${(LICENSED_STATES as readonly string[]).includes(s.code) ? ' · licensed' : ''}`,
}));

export function FormSection({ title, description, children }: { readonly title: string; readonly description?: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <Stack gap="sm">
      <div>
        <Text fw={650}>{title}</Text>
        {description && (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
      </div>
      {children}
    </Stack>
  );
}

/** Identity, contact, emergency contact, optional demographics and referral fields (P08, P10). */
export function PatientFields<T extends PatientFormValues>({ form, showPreferences }: { readonly form: UseFormReturnType<T>; readonly showPreferences?: boolean }): JSX.Element {
  const state = form.values.state;
  const unlicensed = !!state && !(LICENSED_STATES as readonly string[]).includes(state);
  return (
    <Stack gap="xl">
      <FormSection title="Identity" description="Legal name as on ID and insurance. Preferred name and pronouns are shown on every screen.">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="Legal first name" required {...form.getInputProps('given')} autoComplete="off" />
          <TextInput label="Middle name" {...form.getInputProps('middle')} autoComplete="off" />
          <TextInput label="Legal last name" required {...form.getInputProps('family')} autoComplete="off" />
          <TextInput label="Preferred name" {...form.getInputProps('preferred')} autoComplete="off" />
          <TextInput label="Date of birth" type="date" required max={new Date().toISOString().slice(0, 10)} {...form.getInputProps('birthDate')} />
          <Select
            label="Sex assigned at birth"
            required
            data={[
              { value: 'female', label: 'Female' },
              { value: 'male', label: 'Male' },
              { value: 'unknown', label: 'Intersex / not listed' },
            ]}
            {...form.getInputProps('sexAtBirth')}
          />
          <Select label="Gender identity" data={[...GENDER_IDENTITIES]} clearable {...form.getInputProps('genderIdentity')} />
          <Select label="Pronouns" data={[...PRONOUNS]} clearable searchable {...form.getInputProps('pronouns')} />
        </SimpleGrid>
      </FormSection>

      <FormSection title="Contact" description="Home state is checked against the provider's licences. Location is confirmed again at every visit.">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Mobile phone" required placeholder="425-555-0123" {...form.getInputProps('phone')} autoComplete="off" />
          <TextInput label="Email" required type="email" {...form.getInputProps('email')} autoComplete="off" />
        </SimpleGrid>
        <TextInput label="Street address" {...form.getInputProps('line')} autoComplete="off" />
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="City" {...form.getInputProps('city')} autoComplete="off" />
          <Select
            label="Home state"
            required
            searchable
            data={STATE_OPTIONS}
            {...form.getInputProps('state')}
            error={form.errors.state ?? (unlicensed ? 'The provider is not licensed here. The patient can be registered, but visits must take place while they are in WA, CA, CO or RI.' : undefined)}
          />
          <TextInput label="ZIP code" {...form.getInputProps('postalCode')} autoComplete="off" />
        </SimpleGrid>
        <Group gap="xl" align="flex-end">
          <div>
            <Text size="sm" fw={500} mb={4}>
              Preferred contact
            </Text>
            <SegmentedControl
              data={[
                { value: 'sms', label: 'Text' },
                { value: 'email', label: 'Email' },
                { value: 'phone', label: 'Phone call' },
              ]}
              {...form.getInputProps('preferredContact')}
            />
          </div>
          <Select label="Preferred language" data={['English', 'Spanish', 'Other']} w={180} {...form.getInputProps('language')} />
        </Group>
        {showPreferences && (
          <Group gap="lg">
            <Text size="sm" fw={500}>
              Opted out of:
            </Text>
            <Checkbox label="Text messages" {...form.getInputProps('optOutSms', { type: 'checkbox' })} />
            <Checkbox label="Email" {...form.getInputProps('optOutEmail', { type: 'checkbox' })} />
            <Checkbox label="Voice calls" {...form.getInputProps('optOutVoice', { type: 'checkbox' })} />
          </Group>
        )}
      </FormSection>

      <FormSection title="Emergency contact">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="Name" required {...form.getInputProps('emergencyName')} autoComplete="off" />
          <TextInput label="Relationship" placeholder="e.g. Partner" {...form.getInputProps('emergencyRelationship')} autoComplete="off" />
          <TextInput label="Phone" required {...form.getInputProps('emergencyPhone')} autoComplete="off" />
        </SimpleGrid>
      </FormSection>

      <FormSection title="Additional demographics" description="Optional. Every question offers “Prefer not to say”.">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label="Race" data={[...RACES]} clearable {...form.getInputProps('race')} />
          <Select label="Ethnicity" data={[...ETHNICITIES]} clearable {...form.getInputProps('ethnicity')} />
          <Select label="Sexual orientation" data={[...SEXUAL_ORIENTATIONS]} clearable {...form.getInputProps('sexualOrientation')} />
          <Select label="Marital status" data={MARITAL.map((m) => ({ value: m.code, label: m.label }))} clearable {...form.getInputProps('maritalStatus')} />
          <Select label="Employment" data={[...EMPLOYMENT_STATUSES]} clearable {...form.getInputProps('employment')} />
        </SimpleGrid>
      </FormSection>

      <FormSection title="Referral">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label="How did they hear about us?" data={[...REFERRAL_SOURCES]} clearable {...form.getInputProps('referralSource')} />
          <TextInput label="Referring clinician" {...form.getInputProps('referringName')} autoComplete="off" />
          <TextInput label="Referring clinician NPI" description="Checks the NPI check digit. Directory lookup is not connected yet." placeholder="10 digits" maxLength={10} {...form.getInputProps('referringNpi')} autoComplete="off" />
        </SimpleGrid>
      </FormSection>
    </Stack>
  );
}
