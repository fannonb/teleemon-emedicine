import { Alert, Anchor, Button, Card, Checkbox, FileInput, Grid, Group, List, Radio, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Bundle, BundleEntry, Coverage, Patient, RelatedPerson } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconUserPlus } from '@tabler/icons-react';
import { EXT, findDuplicates, guardianContact, isMinor, normalizePhone } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { FormSection, PatientFields } from '../../components/PatientFields';
import { uploadDocument } from '../../fhir/documents';
import { patientName } from '../../fhir/patient';
import type { PatientFormValues } from '../../fhir/patientForm';
import { EMPTY_PATIENT_FORM, toPatient, validatePatient } from '../../fhir/patientForm';
import { formatDate } from '../../utils/format';
import classes from './RegistrationPage.module.css';

interface RegistrationValues extends PatientFormValues {
  guardianGiven: string;
  guardianFamily: string;
  guardianRelationship: string;
  guardianPhone: string;
  guardianEmail: string;
  guardianAuthority: boolean;
  payment: 'insurance' | 'self-pay';
  payer: string;
  memberId: string;
  groupNumber: string;
  subscriberRelationship: string;
}

const RELATIONSHIP_CODES: Record<string, { code: string; display: string }> = {
  Mother: { code: 'MTH', display: 'mother' },
  Father: { code: 'FTH', display: 'father' },
  'Legal guardian': { code: 'GUARD', display: 'guardian' },
  Grandparent: { code: 'GRPRN', display: 'grandparent' },
  Other: { code: 'O', display: 'other' },
};

// P08 New patient registration.
export function RegistrationPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [cardFront, setCardFront] = useState<File | null>(null);
  const [cardBack, setCardBack] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string>();

  const form = useForm<RegistrationValues>({
    initialValues: {
      ...EMPTY_PATIENT_FORM,
      guardianGiven: '', guardianFamily: '', guardianRelationship: '', guardianPhone: '', guardianEmail: '', guardianAuthority: false,
      payment: 'insurance', payer: '', memberId: '', groupNumber: '', subscriberRelationship: 'self',
    },
    validate: (v) => {
      const errors: Record<string, string> = { ...(validatePatient(v) as Record<string, string>) };
      if (isMinor(v.birthDate)) {
        if (!v.guardianGiven.trim()) errors.guardianGiven = 'Required for patients under 18';
        if (!v.guardianFamily.trim()) errors.guardianFamily = 'Required for patients under 18';
        if (!v.guardianRelationship) errors.guardianRelationship = 'Required for patients under 18';
        if (!normalizePhone(v.guardianPhone)) errors.guardianPhone = 'Enter a 10-digit phone number';
        if (!v.guardianAuthority) errors.guardianAuthority = 'Confirm the guardian has legal authority to consent';
      }
      if (v.payment === 'insurance') {
        if (!v.payer.trim()) errors.payer = 'Insurance company is required (or choose self-pay)';
        if (!v.memberId.trim()) errors.memberId = 'Member ID is required';
      }
      return errors;
    },
  });

  const v = form.values;
  const minor = isMinor(v.birthDate);

  // Early duplicate warning. The server repeats this check authoritatively on save.
  const [dupKey] = useDebouncedValue(`${v.given}|${v.family}|${v.birthDate}|${v.phone}|${v.email}`, 400);
  const [matches, setMatches] = useState<{ patient: Patient; reasons: string[] }[]>([]);
  useEffect(() => {
    if (!v.birthDate || (!v.family.trim() && !v.phone && !v.email)) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    medplum
      .searchResources('Patient', { birthdate: v.birthDate, _count: '50' })
      .then((same) => !cancelled && setMatches(findDuplicates(toPatient(v), same)))
      .catch(() => !cancelled && setMatches([]));
    return () => {
      cancelled = true;
    };
  }, [dupKey, medplum]);

  const fieldErrors = validatePatient(v);
  const checklist = [
    { label: 'Identity', done: !fieldErrors.given && !fieldErrors.family && !fieldErrors.birthDate && !fieldErrors.sexAtBirth },
    { label: 'Contact and home state', done: !fieldErrors.phone && !fieldErrors.email && !fieldErrors.state },
    { label: 'Emergency contact', done: !fieldErrors.emergencyName && !fieldErrors.emergencyPhone },
    ...(minor ? [{ label: 'Guardian (under 18)', done: !!(v.guardianGiven.trim() && v.guardianFamily.trim() && v.guardianRelationship && normalizePhone(v.guardianPhone) && v.guardianAuthority) }] : []),
    { label: v.payment === 'insurance' ? 'Insurance' : 'Self-pay selected', done: v.payment === 'self-pay' || !!(v.payer.trim() && v.memberId.trim()) },
  ];

  const handleSubmit = async (values: RegistrationValues): Promise<void> => {
    setSaving(true);
    setServerError(undefined);
    try {
      const patient = toPatient(values);
      if (isMinor(values.birthDate)) {
        patient.contact = [...(patient.contact ?? []), guardianContact({
          given: values.guardianGiven, family: values.guardianFamily, relationship: values.guardianRelationship,
          phone: values.guardianPhone, email: values.guardianEmail, authority: values.guardianAuthority,
        })];
      }
      if (values.payment === 'self-pay') {
        patient.extension = [...(patient.extension ?? []), { url: EXT.selfPay, valueBoolean: true }];
      }
      const patientUrl = `urn:uuid:${crypto.randomUUID()}`;
      const guardianUrl = `urn:uuid:${crypto.randomUUID()}`;
      const entries: BundleEntry[] = [{ fullUrl: patientUrl, resource: patient, request: { method: 'POST', url: 'Patient' } }];
      if (isMinor(values.birthDate)) {
        const rel = RELATIONSHIP_CODES[values.guardianRelationship] ?? RELATIONSHIP_CODES.Other;
        entries.push({
          fullUrl: guardianUrl,
          request: { method: 'POST', url: 'RelatedPerson' },
          resource: {
            resourceType: 'RelatedPerson',
            active: true,
            patient: { reference: patientUrl },
            relationship: [
              { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: rel.code, display: rel.display }] },
              { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'GUARD', display: 'guardian' }] },
            ],
            name: [{ given: [values.guardianGiven.trim()], family: values.guardianFamily.trim() }],
            telecom: [
              { system: 'phone', value: normalizePhone(values.guardianPhone) ?? values.guardianPhone },
              ...(values.guardianEmail ? [{ system: 'email' as const, value: values.guardianEmail.trim() }] : []),
            ],
          } satisfies RelatedPerson,
        });
      }
      if (values.payment === 'insurance') {
        entries.push({
          request: { method: 'POST', url: 'Coverage' },
          resource: {
            resourceType: 'Coverage',
            status: 'active',
            beneficiary: { reference: patientUrl },
            subscriber: { reference: values.subscriberRelationship === 'self' || !isMinor(values.birthDate) ? patientUrl : guardianUrl },
            subscriberId: values.memberId.trim().toUpperCase(),
            identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] }, value: values.memberId.trim().toUpperCase() }],
            relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: values.subscriberRelationship }] },
            payor: [{ display: values.payer.trim() }],
            class: values.groupNumber ? [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] }, value: values.groupNumber.trim() }] : undefined,
            order: 1,
          } satisfies Coverage,
        });
      }

      const result = await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries } satisfies Bundle);
      const location = result.entry?.[0]?.response?.location ?? '';
      const id = /Patient\/([^/]+)/.exec(location)?.[1] ?? (result.entry?.[0]?.resource as Patient | undefined)?.id;
      if (!id) throw new Error('The patient was saved but the server did not return its ID.');

      const created = await medplum.readResource('Patient', id);
      const failedUploads: string[] = [];
      for (const [file, label] of [[cardFront, 'Insurance card (front)'], [cardBack, 'Insurance card (back)']] as const) {
        if (file) {
          try { await uploadDocument(medplum, { patient: created, file, category: 'id-insurance', title: label }); }
          catch { failedUploads.push(label); }
        }
      }
      notifications.show({ color: 'brand', title: 'Patient registered', message: `${patientName(created)} · chart number ${created.identifier?.[0]?.value ?? ''}` });
      if (failedUploads.length) notifications.show({ color: 'orange', title: 'Patient saved; card upload needs attention', message: `Upload these again from Documents: ${failedUploads.join(', ')}. Do not register the patient again.`, autoClose: false });
      navigate(`/patients/${id}`);
    } catch (err) {
      setServerError(normalizeErrorString(err));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageBody>
      <PageHeader eyebrow="Patients" title="New patient" subtitle="Required fields are marked *. Complete identity, contacts and payment details to open a chart." />
      <form className={classes.form} onSubmit={form.onSubmit(handleSubmit, () => setServerError('Some fields need attention. They are highlighted below.'))} noValidate>
        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            {serverError && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Not saved" mb="lg">
                {serverError}
              </Alert>
            )}
            <Card>
              <Stack gap="xl">
                <PatientFields form={form} />

                {minor && (
                  <FormSection title="Parent or guardian" description="Required for patients under 18. Minor-privacy rules for each state decide what the guardian can see (Phase 7).">
                    <SimpleGrid cols={{ base: 1, sm: 3 }}>
                      <TextInput label="First name" required {...form.getInputProps('guardianGiven')} />
                      <TextInput label="Last name" required {...form.getInputProps('guardianFamily')} />
                      <Select label="Relationship" required data={Object.keys(RELATIONSHIP_CODES)} {...form.getInputProps('guardianRelationship')} />
                      <TextInput label="Phone" required {...form.getInputProps('guardianPhone')} />
                      <TextInput label="Email" {...form.getInputProps('guardianEmail')} />
                    </SimpleGrid>
                    <Checkbox label="I have confirmed this person has legal authority to consent to the patient's treatment" {...form.getInputProps('guardianAuthority', { type: 'checkbox' })} />
                  </FormSection>
                )}

                <FormSection title="Payment" description="Eligibility is checked automatically the day before each visit, or on demand from the Insurance tab. Card photos are stored as ID and insurance documents.">
                  <Radio.Group {...form.getInputProps('payment')}>
                    <Group>
                      <Radio value="insurance" label="Insurance" />
                      <Radio value="self-pay" label="Self-pay" />
                    </Group>
                  </Radio.Group>
                  {v.payment === 'insurance' ? (
                    <>
                      <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <TextInput label="Insurance company" required {...form.getInputProps('payer')} />
                        <TextInput label="Member ID" required {...form.getInputProps('memberId')} />
                        <TextInput label="Group number" {...form.getInputProps('groupNumber')} />
                        <Select
                          label="Patient is the"
                          data={[
                            { value: 'self', label: 'Subscriber (self)' },
                            { value: 'child', label: 'Child of the subscriber' },
                            { value: 'spouse', label: 'Spouse of the subscriber' },
                            { value: 'other', label: 'Other dependent' },
                          ]}
                          {...form.getInputProps('subscriberRelationship')}
                        />
                      </SimpleGrid>
                      <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <FileInput label="Card photo (front)" accept="image/*,application/pdf" clearable value={cardFront} onChange={setCardFront} placeholder="Choose file" />
                        <FileInput label="Card photo (back)" accept="image/*,application/pdf" clearable value={cardBack} onChange={setCardBack} placeholder="Choose file" />
                      </SimpleGrid>
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Self-pay patients receive a good-faith estimate before their first visit (No Surprises Act). Card on file is collected through Stripe (Phase 8).
                    </Text>
                  )}
                </FormSection>

                <Text size="sm" c="dimmed">
                  Preferred pharmacy is chosen from the national directory once an e-prescribing vendor is connected.
                </Text>
              </Stack>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack gap="lg" style={{ position: 'sticky', top: 76 }}>
              {matches.length > 0 && (
                <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="This may be an existing patient">
                  <Stack gap={8}>
                    {matches.map((m) => (
                      <div key={m.patient.id}>
                        <Anchor component={Link} to={`/patients/${m.patient.id}`} fw={600} size="sm">
                          {patientName(m.patient)}
                        </Anchor>
                        <Text size="xs">
                          DOB {formatDate(m.patient.birthDate)} · {m.reasons.join('; ')}
                        </Text>
                      </div>
                    ))}
                    <Text size="xs">Open the existing record instead. The server will refuse a duplicate unless an administrator overrides it.</Text>
                  </Stack>
                </Alert>
              )}
              <Card>
                <Text fw={650} mb="sm">
                  Before you save
                </Text>
                <List spacing={8} size="sm" icon={null}>
                  {checklist.map((c) => (
                    <List.Item
                      key={c.label}
                      icon={
                        <ThemeIcon size={20} radius="xl" color={c.done ? 'brand' : 'gray'} variant={c.done ? 'filled' : 'light'}>
                          {c.done ? <IconCircleCheck size={13} /> : <IconCircleDashed size={13} />}
                        </ThemeIcon>
                      }
                    >
                      <Text size="sm" c={c.done ? undefined : 'dimmed'}>
                        {c.label}
                      </Text>
                    </List.Item>
                  ))}
                </List>
                <Button visibleFrom="lg" type="submit" fullWidth mt="lg" loading={saving} leftSection={<IconUserPlus size={16} />}>
                  Register patient
                </Button>
                <Button visibleFrom="lg" variant="subtle" color="gray" fullWidth mt={6} component={Link} to="/patients">
                  Cancel
                </Button>
              </Card>
            </Stack>
          </Grid.Col>
        </Grid>
        <div className={classes.actions}>
          <Text size="sm" c="dimmed" className={classes.progress} aria-live="polite">{checklist.filter((c) => c.done).length} of {checklist.length} sections complete</Text>
          <Button variant="default" component={Link} to="/patients">Cancel</Button>
          <Button type="submit" loading={saving} leftSection={<IconUserPlus size={16} />}>Register patient</Button>
        </div>
      </form>
    </PageBody>
  );
}
