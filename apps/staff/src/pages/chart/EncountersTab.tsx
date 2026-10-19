import { Alert, Badge, Button, Group, Modal, SegmentedControl, Select, Stack, Table, Text, Tooltip } from '@mantine/core';
import { getExtensionValue, normalizeErrorString } from '@medplum/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconPlus, IconStethoscope } from '@tabler/icons-react';
import type { Modality } from '@teleemon/core';
import { EXT, US_STATES } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { StateBadge } from '../../components/PatientBadges';
import { Section } from '../../components/Section';
import { patientState } from '../../fhir/patient';
import { noteStatuses, startAdHocVisit } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { canSee, getPage } from '../../navigation';
import { useRoles } from '../../session/roles';
import { formatDate, formatTime } from '../../utils/format';
import { useChart } from './ChartContext';

const NOTE_BADGE = {
  draft: { label: 'Draft', color: 'orange' },
  signed: { label: 'Signed', color: 'green' },
  amended: { label: 'Signed · amended', color: 'blue' },
} as const;

function Later({ phase, what }: { readonly phase: number; readonly what: string }): JSX.Element {
  return (
    <Tooltip label={`${what} arrives in Phase ${phase}`}>
      <Text size="sm" c="dimmed">
        —
      </Text>
    </Tooltip>
  );
}

// P18 Encounters.
export function EncountersTab(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { roles } = useRoles();
  const { patient } = useChart();
  const [year, setYear] = useState('all');
  const [adHoc, setAdHoc] = useState(false);
  const canDocument = canSee(getPage('P21'), roles);
  const data = useLoader(async () => {
    const encounters = await medplum.searchResources('Encounter', { subject: `Patient/${patient.id}`, _sort: '-date', _count: '200' }, { cache: 'no-cache' });
    // Roles that can't read notes get "restricted" rather than a misleading "no note".
    const statuses = await medplum
      .search('Composition', { _count: '0' })
      .then(() => noteStatuses(medplum, encounters.map((e) => e.id as string)))
      .catch(() => undefined);
    return { encounters, statuses };
  }, [patient.id]);
  const years = [...new Set((data.data?.encounters ?? []).map((e) => e.period?.start?.slice(0, 4)).filter(Boolean))] as string[];

  return (
    <>
      <Section
        title="Encounters"
        loaded={data}
        actions={
          <Group gap="xs">
            {years.length > 1 && <SegmentedControl size="xs" value={year} onChange={setYear} data={[{ value: 'all', label: 'All' }, ...years.map((y) => ({ value: y, label: y }))]} />}
            {canDocument && (
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdHoc(true)}>
                New note
              </Button>
            )}
          </Group>
        }
        isEmpty={(d) => d.encounters.length === 0}
        empty={{ icon: <IconStethoscope size={22} />, title: 'No visits yet', text: 'Each visit started from the calendar creates an encounter with its note.' }}
      >
        {({ encounters, statuses }) => (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Visit type</Table.Th>
                  <Table.Th>Modality</Table.Th>
                  <Table.Th>Patient located in</Table.Th>
                  <Table.Th>Note</Table.Th>
                  <Table.Th>Recording consent</Table.Th>
                  <Table.Th>Charge / claim</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {encounters
                  .filter((e) => year === 'all' || e.period?.start?.startsWith(year))
                  .map((e) => {
                    const st = statuses?.get(e.id as string);
                    const target = st?.status === 'signed' || st?.status === 'amended' ? `/encounters/${e.id}/note` : `/encounters/${e.id}`;
                    const clickable = canDocument && (st || e.status === 'in-progress');
                    return (
                      <Table.Tr key={e.id} style={{ cursor: clickable ? 'pointer' : undefined }} onClick={() => clickable && navigate(target)}>
                        <Table.Td className="tm-num">
                          <Text size="sm">{formatDate(e.period?.start?.slice(0, 10))}</Text>
                          <Text size="xs" c="dimmed">
                            {formatTime(e.period?.start)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{e.type?.[0]?.text ?? e.class.display}</Text>
                          <Badge size="xs" variant="dot" color={e.status === 'finished' ? 'green' : e.status === 'in-progress' ? 'brand' : 'gray'}>
                            {e.status === 'in-progress' ? 'in progress' : e.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" tt="capitalize">
                            {(getExtensionValue(e, EXT.modality) as string | undefined) ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <StateBadge state={getExtensionValue(e, EXT.patientLocationState) as string | undefined} />
                        </Table.Td>
                        <Table.Td>
                          {st ? (
                            <Group gap={4}>
                              <Badge size="sm" variant="light" color={NOTE_BADGE[st.status as keyof typeof NOTE_BADGE].color}>
                                {NOTE_BADGE[st.status as keyof typeof NOTE_BADGE].label}
                              </Badge>
                              {st.late && (
                                <Badge size="sm" variant="light" color="orange">
                                  Late
                                </Badge>
                              )}
                            </Group>
                          ) : !statuses ? (
                            <Tooltip label="Clinical notes aren't available for your role">
                              <Text size="sm" c="dimmed">
                                Restricted
                              </Text>
                            </Tooltip>
                          ) : (
                            <Text size="sm" c="dimmed">
                              {e.status === 'finished' ? 'Before this system' : 'Not started'}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Later phase={4} what="Per-session recording consent" />
                        </Table.Td>
                        <Table.Td>
                          <Later phase={8} what="Charge and claim status" />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Section>
      {adHoc && <AdHocModal onClose={() => setAdHoc(false)} />}
    </>
  );
}

/** Unscheduled telephone or crisis note: needs the patient's current location like any visit. */
function AdHocModal({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { patient } = useChart();
  const [template, setTemplate] = useState<'telephone' | 'crisis'>('telephone');
  const [modality, setModality] = useState<Modality>('phone');
  const [state, setState] = useState<string | null>(patientState(patient) ?? null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const start = async (): Promise<void> => {
    if (!profile || !state) return;
    setSaving(true);
    try {
      const encounter = await startAdHocVisit(medplum, patient, profile, { template, modality, state });
      navigate(`/encounters/${encounter.id}`);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="New note" centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <SegmentedControl value={template} onChange={(v) => setTemplate(v as typeof template)} data={[{ value: 'telephone', label: 'Telephone note' }, { value: 'crisis', label: 'Crisis note' }]} />
        <SegmentedControl value={modality} onChange={(v) => setModality(v as Modality)} data={[{ value: 'phone', label: 'Phone' }, { value: 'video', label: 'Video' }]} />
        <Select label="Where is the patient right now?" data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} value={state} onChange={setState} searchable required />
        <Text size="xs" c="dimmed">
          The provider must be licensed where the patient is; the server checks this when the note starts.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} disabled={!state} onClick={start}>
            Start note
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
