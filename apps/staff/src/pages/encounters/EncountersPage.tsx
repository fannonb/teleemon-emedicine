import { Badge, Button, Card, Group, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Appointment, Encounter, Patient, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconPlayerPlay, IconStethoscope } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CardHeader } from '../../components/CardHeader';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { StateBadge } from '../../components/PatientBadges';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { loadSchedule } from '../../fhir/appointments';
import { patientName } from '../../fhir/patient';
import { noteStatuses, startVisit, visitState } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { formatAge, formatDate, formatTime, practiceDayBounds } from '../../utils/format';

const NOTE_BADGE = {
  draft: { label: 'Draft', color: 'orange' },
  signed: { label: 'Signed', color: 'green' },
  amended: { label: 'Signed · amended', color: 'blue' },
} as const;

// P21 entry point: who is ready to be seen, which visits are open, what was signed recently.
export function EncountersPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string>();
  const data = useLoader(async () => {
    const { start, end } = practiceDayBounds();
    const [schedule, open, recent] = await Promise.all([
      loadSchedule(medplum, start, end),
      medplum.search('Encounter', { status: 'in-progress', _include: 'Encounter:subject', _sort: '-date', _count: '50' }, { cache: 'no-cache' }),
      medplum.search('Encounter', { status: 'finished', _include: 'Encounter:subject', _sort: '-date', _count: '15' }, { cache: 'no-cache' }),
    ]);
    const split = (b: typeof open): { encounters: Encounter[]; patients: Map<string, Patient> } => {
      const patients = new Map<string, Patient>();
      const encounters: Encounter[] = [];
      for (const e of b.entry ?? []) {
        const r = e.resource as Resource | undefined;
        if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
        if (r?.resourceType === 'Encounter') encounters.push(r);
      }
      return { encounters, patients };
    };
    const openSplit = split(open);
    const recentSplit = split(recent);
    const started = new Set(openSplit.encounters.concat(recentSplit.encounters).flatMap((e) => e.appointment?.map((a) => a.reference) ?? []));
    const ready = schedule.filter((r) => ['arrived', 'checked-in'].includes(r.appointment.status) && !started.has(`Appointment/${r.appointment.id}`));
    const statuses = await noteStatuses(medplum, [...openSplit.encounters, ...recentSplit.encounters].map((e) => e.id as string));
    return { ready, open: openSplit, recent: recentSplit, statuses };
  }, [medplum], 60000);

  const start = async (appointment: Appointment): Promise<void> => {
    setStarting(appointment.id);
    try {
      const encounter = await startVisit(medplum, appointment);
      navigate(`/encounters/${encounter.id}`);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Visit not started', message: normalizeErrorString(err), autoClose: 10000 });
    } finally {
      setStarting(undefined);
    }
  };

  return (
    <PageBody>
      <PageHeader eyebrow="P21 · Clinical work" title="Encounters" subtitle="Start a visit once the patient has checked in and confirmed where they are. Notes autosave as you write." />
      {data.error ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <Card>
          <RowsSkeleton rows={6} />
        </Card>
      ) : (
        <Stack gap="lg">
          <Card padding={0}>
            <div style={{ padding: 'var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0' }}>
              <CardHeader title="Ready to start" count={data.data.ready.length} />
            </div>
            {data.data.ready.length === 0 ? (
              <EmptyState icon={<IconPlayerPlay size={22} />} title="Nobody checked in right now">
                Patients appear here after check-in (Calendar → open the visit → Check in).
              </EmptyState>
            ) : (
              <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
                <Table.Tbody>
                  {data.data.ready.map((r) => (
                    <Table.Tr key={r.appointment.id}>
                      <Table.Td w={90} className="tm-num" fw={650}>
                        {formatTime(r.appointment.start)}
                      </Table.Td>
                      <Table.Td>
                        <Text fw={600} size="sm">
                          {patientName(r.patient)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {r.visitType}
                        </Text>
                      </Table.Td>
                      <Table.Td w={140}>
                        <StateBadge state={r.locationState} />
                      </Table.Td>
                      <Table.Td w={150} ta="right">
                        <Button size="xs" leftSection={<IconPlayerPlay size={14} />} loading={starting === r.appointment.id} onClick={() => start(r.appointment)}>
                          Start visit
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Card>

          {(['open', 'recent'] as const).map((which) => {
            const { encounters, patients } = data.data?.[which] ?? { encounters: [], patients: new Map() };
            return (
              <Card padding={0} key={which}>
                <div style={{ padding: 'var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0' }}>
                  <CardHeader title={which === 'open' ? 'In progress' : 'Recently finished'} count={encounters.length} />
                </div>
                {encounters.length === 0 ? (
                  <EmptyState icon={<IconStethoscope size={22} />} title={which === 'open' ? 'No open visits' : 'No finished visits yet'} />
                ) : (
                  <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
                    <Table.Tbody>
                      {encounters.map((e) => {
                        const st = data.data?.statuses.get(e.id as string);
                        return (
                          <Table.Tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => navigate(st?.status === 'signed' || st?.status === 'amended' ? `/encounters/${e.id}/note` : `/encounters/${e.id}`)}>
                            <Table.Td w={120} className="tm-num">
                              <Text size="sm" fw={600}>
                                {formatDate(e.period?.start?.slice(0, 10))}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {which === 'open' ? `open ${formatAge(e.period?.start)}` : formatTime(e.period?.start)}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text fw={600} size="sm">
                                {patientName(patients.get(e.subject?.reference ?? ''))}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {e.type?.[0]?.text}
                              </Text>
                            </Table.Td>
                            <Table.Td w={140}>
                              <StateBadge state={visitState(e)} />
                            </Table.Td>
                            <Table.Td w={200} ta="right">
                              <Group gap={6} justify="flex-end">
                                {st?.late && (
                                  <Badge size="sm" color="orange" variant="light">
                                    Late entry
                                  </Badge>
                                )}
                                <Badge size="sm" variant="light" color={st ? NOTE_BADGE[st.status].color : 'gray'}>
                                  {st ? NOTE_BADGE[st.status].label : 'No note yet'}
                                </Badge>
                              </Group>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>
            );
          })}
        </Stack>
      )}
    </PageBody>
  );
}
