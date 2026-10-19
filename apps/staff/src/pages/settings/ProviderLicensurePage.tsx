import { Alert, Badge, Button, Card, Checkbox, Group, Modal, MultiSelect, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Practitioner } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconCertificate, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import type { Credential, CredentialKind, CredentialStatus } from '@teleemon/core';
import { US_STATES, credentialStatus, licensedStates, readCredentials, toQualification } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { loadProviders } from '../../fhir/scheduling';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';

const STATUS: Record<CredentialStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'green' },
  expiring: { label: 'Expiring', color: 'orange' },
  expired: { label: 'Expired', color: 'red' },
  'not-yet-valid': { label: 'Not yet valid', color: 'gray' },
};

const SCHEDULES = ['2', '2N', '3', '3N', '4', '5'];

// P39 Provider profile and licensure.
export function ProviderLicensurePage(): JSX.Element {
  const medplum = useMedplum();
  const providers = useLoader(() => loadProviders(medplum), [medplum]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ credential?: Credential; kind: CredentialKind }>();

  const provider = providers.data?.find((p) => p.practitioner.id === selected) ?? providers.data?.[0];
  const practitioner = provider?.practitioner;
  const creds = readCredentials(practitioner);

  const saveQualifications = async (next: Practitioner['qualification'], message: string): Promise<void> => {
    if (!practitioner) return;
    try {
      await medplum.updateResource<Practitioner>({ ...practitioner, qualification: next });
      notifications.show({ color: 'brand', message });
      providers.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };

  const remove = (c: Credential): Promise<void> =>
    saveQualifications(
      (practitioner?.qualification ?? []).filter((_, i) => i !== c.index),
      `${c.state} ${c.kind === 'state-license' ? 'licence' : 'DEA registration'} removed. ${c.kind === 'state-license' ? `New ${c.state} bookings are now refused.` : ''}`
    );

  return (
    <PageBody>
      <PageHeader eyebrow="P39 · Settings" title="Provider and licensure" subtitle="Licences decide where patients can be seen; DEA registrations decide where controlled substances can be prescribed (Phase 5)." />
      <Section loaded={providers} isEmpty={(l) => l.length === 0} empty={{ icon: <IconCertificate size={22} />, title: 'No providers with a schedule yet' }}>
        {(list) => (
          <Stack gap="lg">
            <Group justify="space-between" align="flex-end">
              <div>
                {list.length > 1 ? (
                  <Select label="Provider" data={list.map((p) => ({ value: p.practitioner.id as string, label: [p.practitioner.name?.[0]?.given?.[0], p.practitioner.name?.[0]?.family].join(' ') }))} value={provider?.practitioner.id ?? null} onChange={setSelected} />
                ) : (
                  <Title order={2}>{[practitioner?.name?.[0]?.given?.[0], practitioner?.name?.[0]?.family, practitioner?.name?.[0]?.suffix?.join(' ')].filter(Boolean).join(' ')}</Title>
                )}
                <Group gap={6} mt={6}>
                  <Text size="sm" c="dimmed">
                    Can see patients located in:
                  </Text>
                  {licensedStates(practitioner).map((s) => (
                    <Badge key={s} color="navy" variant="light">
                      {s}
                    </Badge>
                  ))}
                  {licensedStates(practitioner).length === 0 && <Badge color="red">No active licence</Badge>}
                </Group>
              </div>
              <Group gap="xs">
                <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setEditing({ kind: 'dea-registration' })}>
                  DEA registration
                </Button>
                <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ kind: 'state-license' })}>
                  State licence
                </Button>
              </Group>
            </Group>
            {(['state-license', 'dea-registration'] as CredentialKind[]).map((kind) => {
              const rows = creds.filter((c) => c.kind === kind).sort((a, b) => a.state.localeCompare(b.state));
              return (
                <Card key={kind} withBorder padding={0}>
                  <Text fw={650} px="lg" pt="md" pb="xs">
                    {kind === 'state-license' ? 'State licences' : 'DEA registrations'}
                  </Text>
                  {rows.length === 0 ? (
                    <Text size="sm" c="dimmed" px="lg" pb="md">
                      None recorded.
                    </Text>
                  ) : (
                    <Table.ScrollContainer minWidth={640}>
                      <Table verticalSpacing="sm" horizontalSpacing="lg">
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>State</Table.Th>
                            <Table.Th>Number</Table.Th>
                            <Table.Th>Valid</Table.Th>
                            <Table.Th>{kind === 'state-license' ? 'Prescriptive authority' : 'Schedules'}</Table.Th>
                            <Table.Th>Status</Table.Th>
                            <Table.Th />
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {rows.map((c) => {
                            const st = STATUS[credentialStatus(c)];
                            return (
                              <Table.Tr key={c.index}>
                                <Table.Td fw={650}>{c.state}</Table.Td>
                                <Table.Td className="tm-num">{c.number}</Table.Td>
                                <Table.Td className="tm-num">
                                  {formatDate(c.start?.slice(0, 10))} – {c.end ? formatDate(c.end.slice(0, 10)) : 'no end date'}
                                </Table.Td>
                                <Table.Td>{kind === 'state-license' ? (c.prescriptiveAuthority === false ? 'No' : c.prescriptiveAuthority ? 'Yes' : '—') : (c.schedules ?? []).map((s) => `C-${s}`).join(', ') || '—'}</Table.Td>
                                <Table.Td>
                                  <Badge color={st.color} variant="light">
                                    {st.label}
                                  </Badge>
                                </Table.Td>
                                <Table.Td ta="right">
                                  <Group gap={4} justify="flex-end" wrap="nowrap">
                                    <Button size="xs" variant="subtle" leftSection={<IconPencil size={13} />} onClick={() => setEditing({ credential: c, kind })}>
                                      Edit
                                    </Button>
                                    <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={13} />} onClick={() => remove(c)}>
                                      Remove
                                    </Button>
                                  </Group>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                </Card>
              );
            })}
            <Text size="xs" c="dimmed">
              Expiry reminders appear on Today 90, 60 and 30 days ahead. EPCS enrolment is tracked with e-prescribing; payer enrolment per state with the clearinghouse. NP practice authority and supervision rules differ by state: confirm with counsel (scope §18).
            </Text>
          </Stack>
        )}
      </Section>
      {editing && practitioner && (
        <CredentialModal
          kind={editing.kind}
          credential={editing.credential}
          onClose={() => setEditing(undefined)}
          onSave={async (c) => {
            const quals = [...(practitioner.qualification ?? [])];
            if (editing.credential) quals[editing.credential.index] = toQualification(c);
            else quals.push(toQualification(c));
            await saveQualifications(quals, `${c.state} ${c.kind === 'state-license' ? 'licence' : 'DEA registration'} saved.`);
            setEditing(undefined);
          }}
        />
      )}
    </PageBody>
  );
}

function CredentialModal({ kind, credential, onClose, onSave }: { readonly kind: CredentialKind; readonly credential?: Credential; readonly onClose: () => void; readonly onSave: (c: Omit<Credential, 'index'>) => Promise<void> }): JSX.Element {
  const [state, setState] = useState<string | null>(credential?.state ?? null);
  const [number, setNumber] = useState(credential?.number ?? '');
  const [start, setStart] = useState(credential?.start?.slice(0, 10) ?? '');
  const [end, setEnd] = useState(credential?.end?.slice(0, 10) ?? '');
  const [issuer, setIssuer] = useState(credential?.issuer ?? '');
  const [prescriptive, setPrescriptive] = useState(credential?.prescriptiveAuthority ?? true);
  const [schedules, setSchedules] = useState<string[]>(credential?.schedules ?? ['2', '2N', '3', '3N', '4', '5']);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = async (): Promise<void> => {
    if (!state || !number.trim()) return setError('State and number are required.');
    if (end && start && end < start) return setError('The end date is before the start date.');
    if (kind === 'dea-registration' && !/^[A-Z]{2}\d{7}$/i.test(number.trim())) return setError('A DEA number is 2 letters followed by 7 digits.');
    setSaving(true);
    await onSave({ kind, state, number: number.trim().toUpperCase(), start: start || undefined, end: end || undefined, issuer: issuer.trim() || undefined, prescriptiveAuthority: kind === 'state-license' ? prescriptive : undefined, schedules: kind === 'dea-registration' ? schedules : undefined });
    setSaving(false);
  };
  return (
    <Modal opened onClose={onClose} title={`${credential ? 'Edit' : 'Add'} ${kind === 'state-license' ? 'state licence' : 'DEA registration'}`} centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <SimpleGrid cols={2}>
          <Select label="State" data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} value={state} onChange={setState} searchable required />
          <TextInput label={kind === 'state-license' ? 'Licence number' : 'DEA number'} value={number} onChange={(e) => setNumber(e.currentTarget.value)} required />
          <TextInput label="Valid from" type="date" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
          <TextInput label="Expires" type="date" value={end} onChange={(e) => setEnd(e.currentTarget.value)} />
        </SimpleGrid>
        {kind === 'state-license' ? (
          <>
            <TextInput label="Issuing board" placeholder="e.g. Washington State Nursing Commission" value={issuer} onChange={(e) => setIssuer(e.currentTarget.value)} />
            <Switch label="Includes prescriptive authority" checked={prescriptive} onChange={(e) => setPrescriptive(e.currentTarget.checked)} />
          </>
        ) : (
          <MultiSelect label="Schedules covered" data={SCHEDULES.map((s) => ({ value: s, label: `C-${s}` }))} value={schedules} onChange={setSchedules} />
        )}
        <Checkbox label="I have verified this against the issuing board or DEA lookup" required />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
