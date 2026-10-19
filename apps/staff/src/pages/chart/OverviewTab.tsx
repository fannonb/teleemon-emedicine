import { Anchor, Badge, Grid, Group, SegmentedControl, Stack, Table, Text, ThemeIcon, Timeline } from '@mantine/core';
import type { Communication, DocumentReference, Encounter, QuestionnaireResponse, Task } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import {
  IconAlertTriangle,
  IconCalendarEvent,
  IconCircleCheck,
  IconClipboardList,
  IconFileText,
  IconListCheck,
  IconMessage,
  IconStethoscope,
} from '@tabler/icons-react';
import { SCHEDULE_LABEL, measureFromQuestionnaireUrl } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ScoreChange, Sparkline } from '../../components/charts';
import { RoleRestricted, Section } from '../../components/Section';
import { consentStatus, loadConditions, loadMeds, loadScores, medName, medSchedule, ref } from '../../fhir/clinical';
import { isForbidden } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

type TimelineKind = 'visit' | 'measure' | 'document' | 'message';
interface TimelineItem {
  readonly kind: TimelineKind;
  readonly date: string;
  readonly title: string;
  readonly detail?: string;
  readonly link: string;
}

const KIND_ICON: Record<TimelineKind, ReactNode> = {
  visit: <IconStethoscope size={12} />,
  measure: <IconClipboardList size={12} />,
  document: <IconFileText size={12} />,
  message: <IconMessage size={12} />,
};

// P09 Chart overview.
export function OverviewTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const base = `/patients/${patient.id}`;
  const conditions = useLoader(() => loadConditions(medplum, patient), [patient.id]);
  const meds = useLoader(() => loadMeds(medplum, patient), [patient.id]);
  const scores = useLoader(() => loadScores(medplum, patient), [patient.id]);

  const compliance = useLoader(async () => {
    const [consents, tasks] = await Promise.all([
      medplum.searchResources('Consent', { patient: ref(patient), _count: '100' }, { cache: 'no-cache' }),
      medplum.searchResources('Task', { subject: ref(patient), status: 'requested,ready,received,accepted,in-progress', _sort: '-authored-on', _count: '20' }, { cache: 'no-cache' }),
    ]);
    return { consents, tasks };
  }, [patient.id]);

  const onControlled = meds.data?.some((m) => medSchedule(m)) ?? false;

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <Stack gap="lg">
          <Section title="Clinical summary" loaded={conditions}>
            {(list) => {
              const active = list.filter((c) => (c.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active');
              return (
                <Stack gap="md">
                  <div>
                    <Group justify="space-between" mb={6}>
                      <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em">
                        Active diagnoses
                      </Text>
                      <Anchor component={Link} to={`${base}/problems`} size="xs">
                        All problems
                      </Anchor>
                    </Group>
                    {active.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        None recorded yet.
                      </Text>
                    ) : (
                      <Stack gap={4}>
                        {active.map((c) => (
                          <Group key={c.id} gap="xs" wrap="nowrap">
                            <Badge variant="outline" color="gray" className="tm-num" miw={64}>
                              {c.code?.coding?.[0]?.code}
                            </Badge>
                            <Text size="sm">{c.code?.text ?? c.code?.coding?.[0]?.display}</Text>
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </div>
                  <div>
                    <Group justify="space-between" mb={6}>
                      <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em">
                        Current medications
                      </Text>
                      <Anchor component={Link} to={`${base}/medications`} size="xs">
                        Meds & allergies
                      </Anchor>
                    </Group>
                    {meds.error && isForbidden(meds.error) ? (
                      <RoleRestricted what="Medications" />
                    ) : (meds.data ?? []).length === 0 ? (
                      <Text size="sm" c="dimmed">
                        No active medications recorded.
                      </Text>
                    ) : (
                      <Stack gap={4}>
                        {meds.data?.map((m) => {
                          const schedule = medSchedule(m);
                          return (
                            <Group key={m.id} gap="xs" wrap="nowrap">
                              {schedule ? (
                                <Badge color="red" variant="light" miw={64}>
                                  {SCHEDULE_LABEL[schedule]}
                                </Badge>
                              ) : (
                                <Badge color="gray" variant="transparent" miw={64}>
                                  Rx
                                </Badge>
                              )}
                              <Text size="sm" fw={schedule ? 600 : 400}>
                                {medName(m)}
                              </Text>
                              <Text size="sm" c="dimmed" truncate>
                                {m.dosage?.[0]?.text}
                              </Text>
                            </Group>
                          );
                        })}
                      </Stack>
                    )}
                  </div>
                </Stack>
              );
            }}
          </Section>
          <TimelineCard />
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="lg">
          <Section
            title="Measures"
            loaded={scores}
            actions={
              <Anchor component={Link} to={`${base}/measures`} size="sm">
                Trends and new entry
              </Anchor>
            }
            isEmpty={(s) => s.length === 0}
            empty={{ icon: <IconClipboardList size={22} />, title: 'No measures yet', text: 'PHQ-9, GAD-7, ASRS and AUDIT-C scores will trend here.' }}
          >
            {(series) => (
              <Table verticalSpacing={6}>
                <Table.Tbody>
                  {series.map((s) => {
                    const last = s.points[s.points.length - 1];
                    const prev = s.points[s.points.length - 2];
                    return (
                      <Table.Tr key={s.def.key}>
                        <Table.Td>
                          <Text size="sm" fw={600}>
                            {s.def.shortTitle}
                          </Text>
                          <Text size="xs" c="dimmed" className="tm-num">
                            {formatDate(last.date.slice(0, 10))}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Sparkline points={s.points} max={s.def.maxScore} />
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text fw={700} className="tm-num">
                            {last.value}
                          </Text>
                          <ScoreChange current={last.value} previous={prev?.value} />
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {last.observation.interpretation?.[0]?.text}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
          </Section>

          <Section title="Open items and compliance" loaded={compliance}>
            {({ consents, tasks }) => {
              const status = consentStatus(consents, onControlled).filter((s) => s.required);
              const missing = status.filter((s) => !s.current);
              return (
                <Stack gap="md">
                  <div>
                    <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em" mb={6}>
                      Consents
                    </Text>
                    {missing.length === 0 ? (
                      <Group gap="xs">
                        <ThemeIcon size={20} radius="xl" color="green" variant="light">
                          <IconCircleCheck size={13} />
                        </ThemeIcon>
                        <Text size="sm">All required consents on file</Text>
                      </Group>
                    ) : (
                      <Stack gap={4}>
                        {missing.map((m) => (
                          <Group key={m.code} gap="xs" wrap="nowrap">
                            <ThemeIcon size={20} radius="xl" color={m.code === 'recording' ? 'red' : 'orange'} variant="light">
                              <IconAlertTriangle size={12} />
                            </ThemeIcon>
                            <Text size="sm">
                              {m.label} {m.expired ? 'expired' : 'missing'}
                              {m.code === 'recording' && <Text span size="xs" c="dimmed"> · sessions can't be recorded</Text>}
                            </Text>
                          </Group>
                        ))}
                        <Anchor component={Link} to={`${base}/consents`} size="xs">
                          Record consents
                        </Anchor>
                      </Stack>
                    )}
                  </div>
                  <div>
                    <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em" mb={6}>
                      Controlled substances
                    </Text>
                    <Text size="sm">
                      {onControlled ? (
                        <>
                          Agreement: {status.find((s) => s.code === 'controlled-substance')?.current ? `signed ${formatDate(status.find((s) => s.code === 'controlled-substance')?.current?.dateTime?.slice(0, 10))}` : 'not on file'} ·{' '}
                          <Text span c="dimmed">
                            Review and record the PDMP check in the prescribing form before sending.
                          </Text>
                        </>
                      ) : (
                        <Text span c="dimmed">
                          No active controlled medication
                        </Text>
                      )}
                    </Text>
                  </div>
                  <div>
                    <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em" mb={6}>
                      Open tasks
                    </Text>
                    {tasks.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        No open tasks.
                      </Text>
                    ) : (
                      <Stack gap={6}>
                        {tasks.map((t: Task) => (
                          <Group key={t.id} gap="xs" wrap="nowrap" align="flex-start">
                            <IconListCheck size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                            <div>
                              <Text size="sm">{t.description ?? t.code?.text}</Text>
                              <Group gap={6}>
                                {(t.priority === 'urgent' || t.priority === 'stat') && (
                                  <Badge size="xs" color="red">
                                    {t.priority}
                                  </Badge>
                                )}
                                <Text size="xs" c="dimmed">
                                  {t.owner?.display ?? 'Unassigned'} · {formatDate(t.authoredOn?.slice(0, 10))}
                                </Text>
                              </Group>
                            </div>
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </div>
                </Stack>
              );
            }}
          </Section>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

function TimelineCard(): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const base = `/patients/${patient.id}`;
  const [filter, setFilter] = useState<'all' | TimelineKind>('all');
  const timeline = useLoader(async () => {
    const r = ref(patient);
    const opt = { cache: 'no-cache' as const };
    const safe = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);
    const [encounters, qrs, docs, msgs] = await Promise.all([
      safe(medplum.searchResources('Encounter', { subject: r, _sort: '-date', _count: '30' }, opt)),
      safe(medplum.searchResources('QuestionnaireResponse', { subject: r, _sort: '-authored', _count: '30' }, opt)),
      safe(medplum.searchResources('DocumentReference', { subject: r, _sort: '-date', _count: '30' }, opt)),
      safe(medplum.searchResources('Communication', { subject: r, _sort: '-sent', _count: '30' }, opt)),
    ]);
    const items: TimelineItem[] = [
      ...encounters.map((e: Encounter) => ({ kind: 'visit' as const, date: e.period?.start ?? '', title: e.type?.[0]?.text ?? 'Visit', detail: e.status, link: `${base}/encounters` })),
      ...qrs.map((q: QuestionnaireResponse) => ({ kind: 'measure' as const, date: q.authored ?? '', title: `${measureFromQuestionnaireUrl(q.questionnaire)?.shortTitle ?? 'Questionnaire'} completed`, link: `${base}/measures` })),
      ...docs.map((d: DocumentReference) => ({ kind: 'document' as const, date: d.date ?? '', title: d.description ?? d.content?.[0]?.attachment?.title ?? 'Document', detail: d.category?.[0]?.coding?.[0]?.display, link: `${base}/documents` })),
      ...msgs.map((m: Communication) => ({ kind: 'message' as const, date: m.sent ?? '', title: m.payload?.[0]?.contentString?.slice(0, 80) ?? 'Message', detail: m.sender?.reference?.startsWith('Patient/') ? 'From patient' : 'From practice', link: `${base}/communications` })),
    ];
    return items.filter((i) => i.date).sort((a, b) => b.date.localeCompare(a.date));
  }, [patient.id]);

  return (
    <Section
      title="Timeline"
      loaded={timeline}
      actions={
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          data={[
            { value: 'all', label: 'All' },
            { value: 'visit', label: 'Visits' },
            { value: 'measure', label: 'Measures' },
            { value: 'document', label: 'Documents' },
            { value: 'message', label: 'Messages' },
          ]}
        />
      }
      isEmpty={(items) => items.length === 0}
      empty={{ icon: <IconCalendarEvent size={22} />, title: 'Nothing yet', text: 'Visits, measures, documents and messages appear here in date order.' }}
    >
      {(items) => {
        const shown = items.filter((i) => filter === 'all' || i.kind === filter).slice(0, 25);
        return shown.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing of this type yet.
          </Text>
        ) : (
          <Timeline bulletSize={22} lineWidth={2} color="navy">
            {shown.map((i, idx) => (
              <Timeline.Item key={`${i.kind}-${i.date}-${idx}`} bullet={KIND_ICON[i.kind]} title={<Anchor component={Link} to={i.link} size="sm" fw={600} c="inherit">{i.title}</Anchor>}>
                <Text size="xs" c="dimmed" className="tm-num">
                  {formatDate(i.date.slice(0, 10))}
                  {i.detail ? ` · ${i.detail}` : ''}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        );
      }}
    </Section>
  );
}
