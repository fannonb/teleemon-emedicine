import { Alert, Badge, Button, Card, Checkbox, Drawer, Group, Menu, SegmentedControl, Stack, Table, Tabs, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Communication, Patient, Task } from '@medplum/fhirtypes';
import { ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconDots, IconFileText, IconFlask, IconInbox, IconListCheck, IconMessage, IconPill, IconPlus, IconUrgent } from '@tabler/icons-react';
import type { InboxKind, Team } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, INBOX_KINDS, MIN_REASON, PORTAL_MESSAGE, PORTAL_REPLY, TEAMS, communicationCategory, confirmMatchExtension, isOverdue, teamCoding } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { useRoles } from '../session/roles';
import { formatAge, formatDate } from '../utils/format';
import type { InboxRow } from './inbox';
import { loadInbox, loadStaff, staffName, teamsForRoles } from './inbox';
import { CloseReasonModal, TaskDrawer } from './TaskDrawer';

type Scope = 'mine' | 'team' | 'all';
const ICONS: Record<InboxKind, ReactNode> = {
  message: <IconMessage size={16} />, fax: <IconFileText size={16} />, result: <IconFlask size={16} />, refill: <IconPill size={16} />, safety: <IconUrgent size={16} />, task: <IconListCheck size={16} />,
};

// P03 Inbox: everything that arrives or is assigned, in one place. Each item ends assigned,
// filed, completed or closed with a reason; the server refuses anything else.
export function InboxPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const { roles } = useRoles();
  const me = (profile && getReferenceString(profile)) ?? '';
  const myTeams = teamsForRoles(roles);
  const [scope, setScope] = useState<Scope>('team');
  const [tab, setTab] = useState<InboxKind | 'all'>('all');
  const [taskOpen, setTaskOpen] = useState<{ task?: Task; patient?: Patient }>();
  const [message, setMessage] = useState<InboxRow>();
  const [closing, setClosing] = useState<Task>();
  const inbox = useLoader(() => loadInbox(medplum), [medplum], 30000);
  const staff = useLoader(() => loadStaff(medplum), [medplum]);
  const staffById = useMemo(() => new Map((staff.data ?? []).map((p) => [`Practitioner/${p.id}`, p])), [staff.data]);

  const scoped = (inbox.data ?? []).filter((r) => scope === 'all' || (scope === 'mine' ? r.owner === me : r.owner === me || (!r.owner && myTeams.includes(r.team))));
  const counts = Object.fromEntries(INBOX_KINDS.map((k) => [k.value, scoped.filter((r) => r.kind === k.value).length]));
  const rows = tab === 'all' ? scoped : scoped.filter((r) => r.kind === tab);

  const updateTask = async (task: Task, change: Partial<Task>, done: string): Promise<void> => {
    try {
      await medplum.updateResource<Task>({ ...task, ...change, lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: done });
      inbox.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not changed', message: normalizeErrorString(err) });
    }
  };

  const openRow = (r: InboxRow): void => {
    if (r.kind === 'message') return setMessage(r);
    if (r.kind === 'fax') return void navigate(`/documents?fax=${r.task?.focus?.reference?.split('/')[1] ?? ''}`);
    if (r.kind === 'refill') return void navigate('/refills');
    if (r.kind === 'result' && r.patient) return void navigate(`/patients/${r.patient.id}/labs`);
    if (r.kind === 'safety' && r.patient) return void navigate(`/patients/${r.patient.id}/measures`);
    if (r.task?.code?.coding?.some((c) => c.code === 'onboarding-review') && r.patient) return void navigate(`/patients/${r.patient.id}/demographics`);
    setTaskOpen({ task: r.task, patient: r.patient });
  };

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="P03 · Daily work"
        title="Inbox"
        subtitle="Messages, faxes, results, refills and tasks. Nothing leaves the inbox until it is completed, filed, or closed with a reason."
        actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setTaskOpen({})}>New task</Button>}
      />
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <SegmentedControl value={scope} onChange={(v) => setScope(v as Scope)} data={[{ value: 'mine', label: 'Assigned to me' }, { value: 'team', label: 'Me and my team' }, { value: 'all', label: 'Everything' }]} />
          <Text size="xs" c="dimmed">{scoped.length} open · {scoped.filter((r) => r.task && isOverdue(r.task)).length} overdue · refreshes every 30 s</Text>
        </Group>
        <Tabs value={tab} onChange={(v) => setTab((v as InboxKind | 'all') ?? 'all')}>
          <Tabs.List>
            <Tabs.Tab value="all">All <Badge size="xs" variant="light" ml={4}>{scoped.length}</Badge></Tabs.Tab>
            {INBOX_KINDS.map((k) => (
              <Tabs.Tab key={k.value} value={k.value} leftSection={ICONS[k.value]}>
                {k.label} {counts[k.value] > 0 && <Badge size="xs" variant="light" ml={4}>{counts[k.value]}</Badge>}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
        <Section loaded={inbox} padding="md" isEmpty={() => rows.length === 0} empty={{ icon: <IconInbox size={22} />, title: 'Nothing waiting', text: scope === 'mine' ? 'Nothing is assigned to you. Switch to “Me and my team” to pick up shared work.' : 'New messages, faxes, results and tasks appear here.' }}>
          {() => (
            <Card padding={0} withBorder={false}>
              <Table.ScrollContainer minWidth={820}>
                <Table verticalSpacing="sm" highlightOnHover>
                  <Table.Thead>
                    <Table.Tr><Table.Th>Item</Table.Th><Table.Th>Patient</Table.Th><Table.Th>Assigned</Table.Th><Table.Th>Arrived</Table.Th><Table.Th>Due</Table.Th><Table.Th /></Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((r) => {
                      const late = r.task ? isOverdue(r.task) : false;
                      const unmatched = r.kind === 'message' && !r.message?.subject;
                      return (
                        <Table.Tr key={r.key} style={{ cursor: 'pointer' }} onClick={() => openRow(r)}>
                          <Table.Td>
                            <Group gap={8} wrap="nowrap">
                              <span style={{ color: 'var(--mantine-color-dimmed)' }}>{ICONS[r.kind]}</span>
                              <div>
                                <Text size="sm" fw={600} lineClamp={1}>{r.task?.description ?? r.message?.payload?.[0]?.contentString ?? 'Message'}</Text>
                                <Text size="xs" c="dimmed">{r.task?.code?.text ?? (r.message && communicationCategory(r.message) === PORTAL_MESSAGE ? 'Portal message' : 'Patient text message')}{r.task?.priority && r.task.priority !== 'routine' ? ` · ${r.task.priority}` : ''}</Text>
                                {r.message?.priority === 'urgent' && <Badge color="red" size="xs" leftSection={<IconUrgent size={10} />}>Possible crisis language</Badge>}
                              </div>
                            </Group>
                          </Table.Td>
                          <Table.Td>{unmatched ? <Badge color="orange" variant="light">Unmatched</Badge> : <Text size="sm">{r.patient ? patientName(r.patient) : '—'}</Text>}</Table.Td>
                          <Table.Td><Text size="sm">{r.owner ? (r.owner === me ? 'Me' : staffName(staffById.get(r.owner))) : `${TEAMS.find((t) => t.value === r.team)?.label} queue`}</Text></Table.Td>
                          <Table.Td className="tm-num"><Text size="sm">{formatAge(r.arrived)} ago</Text></Table.Td>
                          <Table.Td>{r.due ? <Group gap={4}><Text size="sm" c={late ? 'red' : undefined} className="tm-num">{formatDate(r.due.slice(0, 10))}</Text>{late && <Badge color="red" variant="light" size="xs">Overdue</Badge>}</Group> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
                          <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                            {r.task && (
                              <Menu position="bottom-end" withinPortal>
                                <Menu.Target><Button size="xs" variant="subtle" color="gray" px={6} aria-label="Actions"><IconDots size={14} /></Button></Menu.Target>
                                <Menu.Dropdown>
                                  {r.owner !== me && <Menu.Item onClick={() => updateTask(r.task as Task, { owner: { reference: me }, status: r.task?.status === 'requested' ? 'accepted' : r.task?.status }, 'Assigned to you')}>Assign to me</Menu.Item>}
                                  {r.owner && <Menu.Item onClick={() => updateTask(r.task as Task, { owner: undefined }, 'Returned to the team queue')}>Return to team queue</Menu.Item>}
                                  <Menu.Label>Move to team</Menu.Label>
                                  {TEAMS.filter((t) => t.value !== r.team).map((t) => (
                                    <Menu.Item key={t.value} onClick={() => updateTask(r.task as Task, { performerType: teamCoding(t.value as Team), owner: undefined }, `Moved to ${t.label}`)}>{t.label}</Menu.Item>
                                  ))}
                                  <Menu.Divider />
                                  <Menu.Item color="red" onClick={() => setClosing(r.task)}>Close with reason…</Menu.Item>
                                </Menu.Dropdown>
                              </Menu>
                            )}
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

      <TaskDrawer opened={!!taskOpen} task={taskOpen?.task} patient={taskOpen?.patient} staff={staff.data ?? []} onClose={() => setTaskOpen(undefined)} onSaved={() => { setTaskOpen(undefined); inbox.reload(); }} />
      <MessageDrawer key={message?.key ?? 'closed'} row={message} onClose={() => setMessage(undefined)} onDone={() => { setMessage(undefined); inbox.reload(); }} onFollowUp={(p) => { setMessage(undefined); setTaskOpen({ patient: p }); }} />
      <CloseReasonModal opened={!!closing} title="Close without completing" onClose={() => setClosing(undefined)} onConfirm={(reason) => { const t = closing as Task; setClosing(undefined); void updateTask(t, { status: 'cancelled', statusReason: { text: reason } }, 'Closed'); }} />
    </PageBody>
  );
}

/** A patient text or portal message: match it to a patient if needed, reply in the portal, or close it with how it was handled. */
function MessageDrawer({ row, onClose, onDone, onFollowUp }: { readonly row?: InboxRow; readonly onClose: () => void; readonly onDone: () => void; readonly onFollowUp: (p?: Patient) => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [match, setMatch] = useState<Patient>();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const [reply, setReply] = useState('');
  const msg = row?.message;
  const from = msg?.extension?.find((e) => e.url === EXT.inboundFrom)?.valueString;
  const portal = !!msg && communicationCategory(msg) === PORTAL_MESSAGE;

  /** Reply in the portal and close the message in one transaction: the patient is emailed that a reply is waiting. */
  const sendReply = async (): Promise<void> => {
    if (!msg || !profile || !msg.subject) return;
    setError(undefined);
    try {
      const now = new Date().toISOString();
      await medplum.executeBatch({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          {
            request: { method: 'POST', url: 'Communication' },
            resource: {
              resourceType: 'Communication', status: 'completed', sent: now,
              category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_REPLY, display: 'Portal reply' }] }],
              subject: msg.subject, recipient: [msg.sender ?? msg.subject], sender: createReference(profile), inResponseTo: [createReference(msg)],
              payload: [{ contentString: reply.trim() }],
            },
          },
          {
            request: { method: 'PUT', url: `Communication/${msg.id}`, ifMatch: `W/"${msg.meta?.versionId}"` },
            resource: { ...msg, status: 'completed', note: [...(msg.note ?? []), { text: `Replied in the patient portal: ${reply.trim().slice(0, 120)}`, time: now }] },
          },
        ],
      });
      notifications.show({ color: 'brand', message: 'Reply sent. The patient is emailed that a reply is waiting (no content in the email).' });
      setReply('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  const save = async (change: Partial<Communication>, done: string): Promise<void> => {
    if (!msg) return;
    setError(undefined);
    try {
      await medplum.updateResource<Communication>({ ...msg, ...change }, { headers: { 'If-Match': `W/"${msg.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: done });
      setMatch(undefined); setConfirmed(false); setNote('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  return (
    <Drawer opened={!!row} onClose={onClose} position="right" size="md" title={<Text fw={650}>Patient message</Text>}>
      {msg && (
        <Stack>
          <Card withBorder padding="md"><Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{msg.payload?.[0]?.contentString}</Text></Card>
          <Text size="xs" c="dimmed">Received {formatAge(msg.sent)} ago{from ? ` from ${from}` : ''}{portal ? ` in the portal from ${msg.sender?.display ?? 'the patient'}` : ''}</Text>
          {msg.priority === 'urgent' && <Alert color="red" variant="light" title="Possible crisis language">Review now. Follow the safety protocol and call the patient if needed; the patient was shown 988 and 911 when sending.</Alert>}
          {portal && (
            <Stack gap="xs">
              <Textarea label="Reply in the portal" description="The patient reads this in the portal. Do not use portal replies for urgent clinical instructions." autosize minRows={3} maxLength={4000} value={reply} onChange={(e) => setReply(e.currentTarget.value)} />
              <Group justify="flex-end"><Button disabled={!reply.trim()} onClick={() => void sendReply()}>Send reply and close</Button></Group>
            </Stack>
          )}
          {!msg.subject ? (
            <Stack gap="xs">
              <Alert color="orange" variant="light" title="Unmatched number">Match this message to a patient only when you are sure, for example after calling the number back and confirming name and date of birth.</Alert>
              <ResourceInput<Patient> resourceType="Patient" name="match" label="Patient" onChange={(p) => { setMatch(p); setConfirmed(false); }} />
              <Checkbox label="I confirmed this patient’s name and date of birth with the sender" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />
              <Button variant="light" disabled={!match || !confirmed || !profile} onClick={() => save({ subject: createReference(match as Patient), sender: createReference(match as Patient), extension: [...(msg.extension ?? []).filter((e) => e.url !== EXT.matchConfirmed), confirmMatchExtension(getReferenceString(profile!) as string)] }, 'Message matched')}>
                Match to patient
              </Button>
            </Stack>
          ) : (
            <Text size="sm">Patient: <b>{patientName(row?.patient)}</b></Text>
          )}
          <Textarea label="How was it handled?" placeholder="e.g. Called patient back, rescheduled to Friday" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          {error && <Alert color="red" variant="light">{error}</Alert>}
          <Group justify="space-between">
            <Group gap="xs">
              <Button variant="subtle" color="red" onClick={() => setRemoving(true)}>Remove…</Button>
              <Button variant="subtle" onClick={() => onFollowUp(row?.patient)}>Follow-up task</Button>
            </Group>
            <Button disabled={note.trim().length < MIN_REASON} onClick={() => save({ status: 'completed', note: [...(msg.note ?? []), { text: note.trim(), time: new Date().toISOString() }] }, 'Message closed')}>Close as handled</Button>
          </Group>
          <CloseReasonModal opened={removing} title="Remove message" label="Why is it being removed?" onClose={() => setRemoving(false)} onConfirm={(reason) => { setRemoving(false); void save({ status: 'entered-in-error', extension: [...(msg.extension ?? []), { url: EXT.removalReason, valueString: reason }] }, 'Message removed'); }} />
        </Stack>
      )}
    </Drawer>
  );
}
