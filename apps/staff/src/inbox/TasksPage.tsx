import { Badge, Button, Card, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { Patient, Resource, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconListCheck, IconPlus, IconRepeat } from '@tabler/icons-react';
import { OPEN_TASK_STATUS_PARAM, RECURRENCES, TEAMS, isOverdue, taskRecurrence, taskTeam } from '@teleemon/core';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { useRoles } from '../session/roles';
import { formatDate } from '../utils/format';
import { QUEUES, loadStaff, staffName, teamsForRoles } from './inbox';
import { TaskDrawer } from './TaskDrawer';

type View = 'mine' | 'team' | 'overdue' | 'done';

// P29 Tasks: internal to-dos, optionally linked to a patient, with due dates, teams and repeats.
// "Assigned to me" uses the same query as the Today "My tasks" tile.
export function TasksPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { roles } = useRoles();
  const me = (profile && getReferenceString(profile)) ?? '';
  const myTeams = teamsForRoles(roles);
  const [view, setView] = useState<View>('mine');
  const [open, setOpen] = useState<{ task?: Task; patient?: Patient }>();
  const staff = useLoader(() => loadStaff(medplum), [medplum]);
  const staffById = useMemo(() => new Map((staff.data ?? []).map((p) => [`Practitioner/${p.id}`, p])), [staff.data]);

  const tasks = useLoader(async () => {
    const params: [string, string][] =
      view === 'mine' ? Object.entries(QUEUES.myTasks.params(me))
      : view === 'done' ? [['status', 'completed,cancelled,rejected,failed'], ['_lastUpdated', `ge${new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)}`]]
      : [['status', OPEN_TASK_STATUS_PARAM]];
    const bundle = await medplum.search('Task', new URLSearchParams([...params, ['_count', '500'], ['_sort', view === 'done' ? '-_lastUpdated' : 'authored-on'], ['_include', 'Task:patient']]), { cache: 'no-cache' });
    const patients = new Map<string, Resource>();
    for (const e of bundle.entry ?? []) if (e.search?.mode === 'include' && e.resource) patients.set(`Patient/${e.resource.id}`, e.resource);
    return (bundle.entry ?? [])
      .filter((e) => e.search?.mode !== 'include' && e.resource?.resourceType === 'Task')
      .map((e) => e.resource as Task)
      .filter((t) => !t.code?.coding?.some((c) => c.code === 'pdmp-check'))
      .filter((t) => view !== 'team' || (!t.owner && myTeams.includes(taskTeam(t))))
      .filter((t) => view !== 'overdue' || isOverdue(t))
      .map((t) => ({ task: t, patient: patients.get(t.for?.reference ?? '') as Patient | undefined }));
  }, [view, me, myTeams.join()], 30000);

  return (
    <PageBody>
      <PageHeader
        eyebrow="P29 · Clinical work"
        title="Tasks"
        subtitle="To-dos for you and your team. Overdue tasks show on Today and in the morning summary email."
        actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setOpen({})}>New task</Button>}
      />
      <Stack gap="md">
        <SegmentedControl
          style={{ alignSelf: 'flex-start' }}
          value={view}
          onChange={(v) => setView(v as View)}
          data={[{ value: 'mine', label: 'Assigned to me' }, { value: 'team', label: 'Team queue (unassigned)' }, { value: 'overdue', label: 'Overdue' }, { value: 'done', label: 'Done (14 days)' }]}
        />
        <Section loaded={tasks} padding="md" isEmpty={(l) => l.length === 0} empty={{ icon: <IconListCheck size={22} />, title: view === 'overdue' ? 'Nothing overdue' : 'No tasks here', text: 'Create a task with New task, or pick one up from the team queue.' }}>
          {(list) => (
            <Card padding={0} withBorder={false}>
              <Table.ScrollContainer minWidth={760}>
                <Table verticalSpacing="sm" highlightOnHover>
                  <Table.Thead><Table.Tr><Table.Th>Task</Table.Th><Table.Th>Patient</Table.Th><Table.Th>Assigned</Table.Th><Table.Th>Due</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {list.map(({ task: t, patient }) => {
                      const late = isOverdue(t);
                      const rule = taskRecurrence(t);
                      return (
                        <Table.Tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setOpen({ task: t, patient })}>
                          <Table.Td>
                            <Group gap={6} wrap="nowrap">
                              <Text size="sm" fw={600} lineClamp={1}>{t.description}</Text>
                              {rule && <Badge size="xs" variant="light" leftSection={<IconRepeat size={10} />}>{RECURRENCES.find((r) => r.value === rule)?.label}</Badge>}
                              {t.priority && t.priority !== 'routine' && <Badge size="xs" color="red" variant="light">{t.priority}</Badge>}
                            </Group>
                            <Text size="xs" c="dimmed">{t.code?.text ?? 'Task'}</Text>
                          </Table.Td>
                          <Table.Td><Text size="sm">{patient ? patientName(patient) : '—'}</Text></Table.Td>
                          <Table.Td><Text size="sm">{t.owner ? (t.owner.reference === me ? 'Me' : staffName(staffById.get(t.owner.reference ?? ''))) : `${TEAMS.find((x) => x.value === taskTeam(t))?.label} queue`}</Text></Table.Td>
                          <Table.Td><Text size="sm" c={late ? 'red' : undefined} className="tm-num">{t.restriction?.period?.end ? formatDate(t.restriction.period.end.slice(0, 10)) : '—'}</Text></Table.Td>
                          <Table.Td>
                            <Badge variant="light" color={late ? 'red' : t.status === 'completed' ? 'green' : ['cancelled', 'rejected', 'failed'].includes(t.status) ? 'gray' : 'blue'}>{late ? 'Overdue' : t.status}</Badge>
                            {t.statusReason?.text && <Text size="xs" c="dimmed" lineClamp={1}>{t.statusReason.text}</Text>}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          )}
        </Section>
      </Stack>
      <TaskDrawer opened={!!open} task={open?.task} patient={open?.patient} staff={staff.data ?? []} onClose={() => setOpen(undefined)} onSaved={() => { setOpen(undefined); tasks.reload(); }} />
    </PageBody>
  );
}
