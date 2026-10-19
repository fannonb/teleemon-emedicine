import { ActionIcon, Badge, Button, Card, Grid, Group, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Location, Organization } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import type { Hours, PracticeSettings } from '@teleemon/core';
import { NPI_SYSTEM, PRACTICE_ORG_TYPE, isValidNpi, readSettings, writeSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TAX_ID_SYSTEM = 'urn:oid:2.16.840.1.113883.4.4';

// P38 Practice and locations.
export function PracticePage(): JSX.Element {
  const medplum = useMedplum();
  const data = useLoader(async () => {
    const [orgs, locations, settings] = await Promise.all([
      // The practice is the Organization typed as a provider; claims bill under it (fetchClaimSources).
      medplum.searchResources('Organization', { type: PRACTICE_ORG_TYPE, _count: '5' }, { cache: 'no-cache' }),
      medplum.searchResources('Location', { _count: '20' }, { cache: 'no-cache' }),
      readSettings(medplum, 'practice'),
    ]);
    return { org: orgs[0], locations, settings };
  }, [medplum]);

  return (
    <PageBody>
      <PageHeader eyebrow="P38 · Settings" title="Practice and locations" subtitle="Claims bill under the practice name, NPI and tax ID shown here. Hours and closures drive the calendar and online booking." />
      <Section loaded={data}>
        {({ org, locations, settings }) => (
          <Grid gutter="lg">
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Stack gap="lg">
                {org && <OrganizationCard org={org} onSaved={data.reload} />}
                <Card>
                  <Title order={2} mb="sm">
                    Locations
                  </Title>
                  <Table verticalSpacing="sm">
                    <Table.Tbody>
                      {locations.map((l: Location) => (
                        <Table.Tr key={l.id}>
                          <Table.Td fw={600}>{l.name}</Table.Td>
                          <Table.Td>
                            <Badge variant="light" color="navy">
                              POS {l.type?.[0]?.coding?.[0]?.code}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" c="dimmed">
                              {l.address ? [l.address.line?.join(', '), l.address.city, l.address.state].filter(Boolean).join(', ') : 'Telehealth: POS 10 when the patient is at home, 02 otherwise'}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Card>
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <HoursCard settings={settings} onSaved={data.reload} />
            </Grid.Col>
          </Grid>
        )}
      </Section>
    </PageBody>
  );
}

function OrganizationCard({ org, onSaved }: { readonly org: Organization; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const ident = (system: string): string => org.identifier?.find((i) => i.system === system)?.value ?? '';
  const [name, setName] = useState(org.name ?? '');
  const [npi, setNpi] = useState(ident(NPI_SYSTEM));
  const [taxId, setTaxId] = useState(ident(TAX_ID_SYSTEM));
  const [phone, setPhone] = useState(org.telecom?.find((t) => t.system === 'phone')?.value ?? '');
  const [fax, setFax] = useState(org.telecom?.find((t) => t.system === 'fax')?.value ?? '');
  const npiError = npi && !isValidNpi(npi) ? 'Fails the NPI check digit' : undefined;
  const taxError = taxId && !/^\d{2}-?\d{7}$/.test(taxId) ? 'Use the format 12-3456789' : undefined;
  const save = async (): Promise<void> => {
    if (npiError || taxError) return;
    const identifier = (org.identifier ?? []).filter((i) => i.system !== NPI_SYSTEM && i.system !== TAX_ID_SYSTEM);
    if (npi) identifier.push({ system: NPI_SYSTEM, value: npi });
    if (taxId) identifier.push({ system: TAX_ID_SYSTEM, value: taxId });
    try {
      await medplum.updateResource<Organization>({
        ...org,
        name: name.trim(),
        identifier,
        telecom: [...(phone ? [{ system: 'phone' as const, value: phone }] : []), ...(fax ? [{ system: 'fax' as const, value: fax }] : [])],
      });
      notifications.show({ color: 'brand', message: 'Practice details saved.' });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={2}>Practice identity</Title>
        <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} onClick={save} disabled={!!npiError || !!taxError}>
          Save
        </Button>
      </Group>
      <Stack gap="sm">
        <TextInput label="Legal name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Group grow>
          <TextInput label="Group NPI" value={npi} onChange={(e) => setNpi(e.currentTarget.value.replace(/\D/g, '').slice(0, 10))} error={npiError} />
          <TextInput label="Tax ID (EIN)" value={taxId} onChange={(e) => setTaxId(e.currentTarget.value)} error={taxError} />
        </Group>
        <Group grow>
          <TextInput label="Phone" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
          <TextInput label="Fax" value={fax} onChange={(e) => setFax(e.currentTarget.value)} />
        </Group>
        <Text size="xs" c="dimmed">
          Address: {org.address?.[0] ? [org.address[0].line?.join(', '), org.address[0].city, org.address[0].state, org.address[0].postalCode].filter(Boolean).join(', ') : '—'}.
        </Text>
      </Stack>
    </Card>
  );
}

function HoursCard({ settings, onSaved }: { readonly settings: PracticeSettings; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [hours, setHours] = useState<Hours>(settings.hours);
  const [closures, setClosures] = useState(settings.closures);
  const [newDate, setNewDate] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setHours(settings.hours);
    setClosures(settings.closures);
  }, [settings]);

  const setDay = (d: number, value: { open: string; close: string } | undefined): void => setHours({ ...hours, [d]: value });
  const invalid = Object.values(hours).some((h) => h && h.close <= h.open);
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await writeSettings(medplum, 'practice', { hours, closures: [...closures].sort((a, b) => a.date.localeCompare(b.date)) });
      notifications.show({ color: 'brand', message: 'Hours and closures saved. The calendar uses them immediately.' });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Title order={2}>Hours (Pacific)</Title>
        <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} disabled={invalid} onClick={save}>
          Save
        </Button>
      </Group>
      <Stack gap={6}>
        {DAYS.map((label, d) => {
          const h = hours[d];
          return (
            <Group key={label} gap="sm" wrap="nowrap">
              <Switch checked={!!h} onChange={(e) => setDay(d, e.currentTarget.checked ? { open: '09:00', close: '21:00' } : undefined)} aria-label={`Open on ${label}`} />
              <Text size="sm" w={96}>
                {label}
              </Text>
              {h ? (
                <Group gap={6} wrap="nowrap">
                  <TextInput size="xs" type="time" step={900} value={h.open} onChange={(e) => setDay(d, { ...h, open: e.currentTarget.value })} aria-label={`${label} opens`} />
                  <Text size="xs" c="dimmed">
                    to
                  </Text>
                  <TextInput size="xs" type="time" step={900} value={h.close} onChange={(e) => setDay(d, { ...h, close: e.currentTarget.value })} error={h.close <= h.open} aria-label={`${label} closes`} />
                </Group>
              ) : (
                <Text size="sm" c="dimmed">
                  Closed
                </Text>
              )}
            </Group>
          );
        })}
      </Stack>
      <Text fw={650} mt="lg" mb="xs">
        Closures and holidays
      </Text>
      <Stack gap={6}>
        {closures.length === 0 && (
          <Text size="sm" c="dimmed">
            None planned.
          </Text>
        )}
        {closures.map((c) => (
          <Group key={c.date} justify="space-between">
            <Text size="sm" className="tm-num">
              {formatDate(c.date)} · {c.label}
            </Text>
            <ActionIcon variant="subtle" color="red" onClick={() => setClosures(closures.filter((x) => x.date !== c.date))} aria-label={`Remove ${c.label}`}>
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Group gap={6} wrap="nowrap" mt={4}>
          <TextInput size="xs" type="date" value={newDate} onChange={(e) => setNewDate(e.currentTarget.value)} aria-label="Closure date" />
          <TextInput size="xs" placeholder="e.g. Thanksgiving" value={newLabel} onChange={(e) => setNewLabel(e.currentTarget.value)} style={{ flex: 1 }} aria-label="Closure label" />
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={12} />}
            disabled={!newDate || !newLabel.trim() || closures.some((c) => c.date === newDate)}
            onClick={() => {
              setClosures([...closures, { date: newDate, label: newLabel.trim() }]);
              setNewDate('');
              setNewLabel('');
            }}
          >
            Add
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Remember to save. Existing appointments on a new closure day are not moved automatically.
        </Text>
      </Stack>
    </Card>
  );
}
