import { Alert, Badge, Button, Card, Grid, Group, Stack, Table, Text, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Bundle, Patient, RelatedPerson } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconDeviceFloppy, IconHistory, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { PatientFields } from '../../components/PatientFields';
import { Section } from '../../components/Section';
import type { PatientFormValues } from '../../fhir/patientForm';
import { fromPatient, toPatient, validatePatient } from '../../fhir/patientForm';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';
import { useChart } from './ChartContext';
import { OnboardingCard } from './OnboardingCard';
import { PortalAccessCard } from './PortalAccessCard';

const TRACKED: { key: keyof Patient; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'birthDate', label: 'Date of birth' },
  { key: 'gender', label: 'Sex' },
  { key: 'telecom', label: 'Phone or email' },
  { key: 'address', label: 'Address' },
  { key: 'contact', label: 'Emergency contact' },
  { key: 'communication', label: 'Language' },
  { key: 'maritalStatus', label: 'Marital status' },
  { key: 'extension', label: 'Pronouns, identity, preferences or referral' },
  { key: 'identifier', label: 'Identifiers' },
  { key: 'active', label: 'Active status' },
];

function changedFields(before: Patient | undefined, after: Patient): string[] {
  if (!before) return ['Record created'];
  return TRACKED.filter((f) => JSON.stringify(before[f.key] ?? null) !== JSON.stringify(after[f.key] ?? null)).map((f) => f.label);
}

// P10 Demographics and contacts.
export function DemographicsTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient, refresh } = useChart();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const form = useForm<PatientFormValues>({ initialValues: fromPatient(patient), validate: validatePatient });

  const history = useLoader(async () => {
    const bundle = await medplum.get<Bundle<Patient>>(medplum.fhirUrl('Patient', patient.id as string, '_history'), { cache: 'no-cache' });
    const versions = (bundle.entry ?? []).map((e) => e.resource as Patient).filter(Boolean);
    // History is newest first; compare each version with the one before it.
    return versions.map((v, i) => ({ version: v, changes: changedFields(versions[i + 1], v) })).filter((x) => x.changes.length > 0);
  }, [patient.id, patient.meta?.versionId]);

  const related = useLoader(() => medplum.searchResources('RelatedPerson', { patient: `Patient/${patient.id}`, _count: '20' }, { cache: 'no-cache' }), [patient.id]);

  const save = async (values: PatientFormValues): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await medplum.updateResource(toPatient(values, patient));
      notifications.show({ color: 'brand', title: 'Saved', message: 'Demographics updated. The change is in the history below.' });
      form.resetDirty();
      refresh();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <form onSubmit={form.onSubmit(save)} noValidate>
          <Card>
            <Group justify="space-between" mb="lg">
              <Title order={2}>Demographics and contact</Title>
              <Group gap="xs">
                {form.isDirty() && (
                  <Button variant="default" onClick={() => form.reset()}>
                    Discard changes
                  </Button>
                )}
                <Button type="submit" loading={saving} disabled={!form.isDirty()} leftSection={<IconDeviceFloppy size={16} />}>
                  Save
                </Button>
              </Group>
            </Group>
            {error && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} mb="lg" title="Not saved">
                {error}
              </Alert>
            )}
            <PatientFields form={form} showPreferences />
          </Card>
        </form>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Stack gap="lg">
          <OnboardingCard patient={patient} />
          {related.data && <PortalAccessCard patient={patient} related={related.data} />}
          <Section
            title="Related people"
            loaded={related}
            isEmpty={(l) => l.length === 0}
            empty={{ icon: <IconUsers size={22} />, title: 'None recorded', text: 'Guardians and authorized representatives appear here.' }}
          >
            {(list: RelatedPerson[]) => (
              <Stack gap="sm">
                {list.map((r) => (
                  <div key={r.id}>
                    <Group gap={6}>
                      <Text size="sm" fw={600}>
                        {[r.name?.[0]?.given?.join(' '), r.name?.[0]?.family].filter(Boolean).join(' ')}
                      </Text>
                      {r.relationship?.flatMap((x) => x.coding ?? []).map((c) => (
                        <Badge key={c.code} size="xs" variant="light" color={c.code === 'GUARD' ? 'grape' : 'gray'}>
                          {c.display}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {r.telecom?.map((t) => t.value).join(' · ')}
                    </Text>
                  </div>
                ))}
                <Text size="xs" c="dimmed">
                  Parents and guardians of minors can be invited to the portal below. Per-person disclosure permissions for adults are not offered yet.
                </Text>
              </Stack>
            )}
          </Section>
          <Section title={<Group gap={6}><IconHistory size={18} /><Title order={2}>Change history</Title></Group>} loaded={history} isEmpty={(h) => h.length === 0} empty={{ icon: <IconHistory size={22} />, title: 'No changes yet' }}>
            {(items) => (
              <Table verticalSpacing={6}>
                <Table.Tbody>
                  {items.map(({ version, changes }) => (
                    <Table.Tr key={version.meta?.versionId}>
                      <Table.Td>
                        <Text size="xs" className="tm-num" c="dimmed">
                          {formatDate(version.meta?.lastUpdated?.slice(0, 10))} {formatTime(version.meta?.lastUpdated)}
                        </Text>
                        <Text size="sm">{changes.join(', ')}</Text>
                        <Text size="xs" c="dimmed">
                          by {version.meta?.author?.display ?? version.meta?.author?.reference ?? 'system'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Section>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
