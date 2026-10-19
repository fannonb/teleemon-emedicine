import { Alert, Badge, Button, Card, Grid, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconRefresh, IconShieldCheck } from '@tabler/icons-react';
import type { AuditEvent } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { loadAuditEvents } from '../../operations/audit';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatTimestamp, StatusBadge } from './phase9Format';

const ACTIONS = [
  { value: '', label: 'Any action' },
  { value: 'C', label: 'Create' },
  { value: 'R', label: 'Read' },
  { value: 'U', label: 'Update' },
  { value: 'D', label: 'Delete' },
  { value: 'E', label: 'Execute / export' },
];

const OUTCOMES = [
  { value: '', label: 'Any outcome' },
  { value: '0', label: 'Success' },
  { value: '4', label: 'Minor failure' },
  { value: '8', label: 'Serious failure' },
  { value: '12', label: 'Major failure' },
];

function actorLabel(event: AuditEvent): string {
  return event.agent?.map((agent) => agent.who?.display ?? agent.who?.reference).filter(Boolean).join(', ') || 'Unattributed';
}

function eventSummary(event: AuditEvent): string {
  const type = event.type?.display ?? event.type?.code ?? 'Audit event';
  const description = event.outcome === '0' ? event.subtype?.map((item) => item.display ?? item.code).filter(Boolean).join(', ') : 'Operation did not succeed';
  return description ? `${type} · ${description}` : type;
}

function entityLabel(event: AuditEvent): string {
  const entities = event.entity ?? [];
  if (!entities.length) return '—';
  return entities.map((entity) => entity.what?.display ?? entity.what?.reference ?? entity.type?.display ?? entity.type?.code ?? 'Record').join(', ');
}

export function AuditPage(): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const allowed = roles.includes('admin');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [outcome, setOutcome] = useState('');
  const [action, setAction] = useState('');
  const [agent, setAgent] = useState('');
  const [entity, setEntity] = useState('');
  const [applied, setApplied] = useState({ since: '', until: '', outcome: '', action: '', agent: '', entity: '' });
  const [filterError, setFilterError] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const result = useLoader(
    () => allowed ? loadAuditEvents(medplum, { ...applied, limit: 200, cursor }) : Promise.reject(new Error('Audit review is limited to administrators.')),
    [medplum, allowed, applied.since, applied.until, applied.outcome, applied.action, applied.agent, applied.entity, cursor]
  );

  const apply = (): void => {
    if (since && until && since > until) {
      setFilterError('The start date must be on or before the end date.');
      return;
    }
    setFilterError('');
    setCursors([undefined]);
    setApplied({ since, until, outcome, action, agent: agent.trim(), entity: entity.trim() });
  };

  const alertCount = result.data?.alerts.length ?? 0;

  return (
    <PageBody wide>
      <PageHeader eyebrow="P45 · Insight & admin" title="Audit events" subtitle="Review recorded access, changes and restricted-chart activity." actions={<><Button component={Link} to="/settings/integrations" variant="default">Compliance & agreements</Button><Button variant="default" leftSection={<IconRefresh size={15} />} onClick={() => { setCursors([undefined]); result.reload(); }} loading={result.loading}>Refresh</Button></>} />
      {!allowed ? <Alert color="red" variant="light" title="Administrator access required">This screen contains sensitive access records. Ask an administrator to review the audit trail.</Alert> : (
        <Stack gap="lg">
          <Alert color="blue" variant="light" icon={<IconShieldCheck size={17} />} title="Bounded audit search">
            Each page shows up to 200 matching events, newest first. Use Older events or narrow the filters to review more activity. Alerts identify failed operations and restricted-chart access; successful restricted access still requires review.
          </Alert>
          <Grid gutter="md">
            <Grid.Col span={{ base: 12, sm: 4 }}><Card padding="md"><Text size="xs" c="dimmed">Events loaded</Text><Text size="xl" fw={700} className="tm-num">{result.loading && !result.data ? '—' : result.data?.events.length ?? 0}</Text></Card></Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}><Card padding="md"><Text size="xs" c="dimmed">Events needing review on this page</Text><Text size="xl" fw={700} c={alertCount ? 'red.7' : 'green.7'} className="tm-num">{result.loading && !result.data ? '—' : alertCount}</Text></Card></Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}><Card padding="md"><Text size="xs" c="dimmed">Current filter</Text><Text size="sm" fw={600} mt={6}>{applied.since || applied.until ? `${applied.since || 'Any date'} – ${applied.until || 'Today'}` : 'All available dates'}</Text></Card></Grid.Col>
          </Grid>
          <Card>
            <Stack gap="md">
              <div><Title order={2}>Filter activity</Title><Text size="sm" c="dimmed" mt={3}>Search by date, result, action, actor or affected record reference.</Text></div>
              <Grid gutter="sm" align="flex-end">
                <Grid.Col span={{ base: 6, sm: 2 }}><TextInput type="date" label="From" value={since} onChange={(event) => setSince(event.currentTarget.value)} /></Grid.Col>
                <Grid.Col span={{ base: 6, sm: 2 }}><TextInput type="date" label="To" value={until} onChange={(event) => setUntil(event.currentTarget.value)} /></Grid.Col>
                <Grid.Col span={{ base: 6, sm: 2 }}><Select label="Outcome" data={OUTCOMES} value={outcome} onChange={(value) => setOutcome(value ?? '')} allowDeselect={false} /></Grid.Col>
                <Grid.Col span={{ base: 6, sm: 2 }}><Select label="Action" data={ACTIONS} value={action} onChange={(value) => setAction(value ?? '')} allowDeselect={false} /></Grid.Col>
                <Grid.Col span={{ base: 12, sm: 2 }}><TextInput label="Actor" placeholder="Name or reference" value={agent} onChange={(event) => setAgent(event.currentTarget.value)} /></Grid.Col>
                <Grid.Col span={{ base: 12, sm: 2 }}><TextInput label="Record" placeholder="Resource reference" value={entity} onChange={(event) => setEntity(event.currentTarget.value)} /></Grid.Col>
              </Grid>
              <Group justify="space-between" wrap="wrap">
                {filterError ? <Text size="sm" c="red">{filterError}</Text> : <Text size="xs" c="dimmed">Filters are applied to the server query.</Text>}
                <Button onClick={apply} loading={result.loading}>Apply filters</Button>
              </Group>
            </Stack>
          </Card>

          {result.error ? <ErrorState error={result.error} onRetry={result.reload} /> : result.loading && !result.data ? <Card><RowsSkeleton rows={7} /></Card> : (
            <>
              {!!result.data?.alerts.length && (
                <Card>
                  <Group justify="space-between" mb="sm"><div><Title order={2}>Review needed</Title><Text size="sm" c="dimmed" mt={3}>Failed operations and restricted-chart access on this page.</Text></div><Badge color="red" variant="light">{result.data.alerts.length}</Badge></Group>
                  <Stack gap="xs">
                    {result.data.alerts.slice(0, 8).map((alert) => <Alert key={alert.id} color={alert.severity === 'critical' || alert.severity === 'high' ? 'red' : 'orange'} variant="light" icon={<IconAlertTriangle size={16} />} title={alert.breakGlass ? 'Restricted chart access · break-glass' : `${alert.severity.toUpperCase()} · ${alert.outcome}`}>{formatTimestamp(alert.occurredAt)} · {alert.actor ?? 'Unattributed'} · {alert.summary}{alert.detail ? <Text size="sm" mt={4}><b>Recorded reason:</b> {alert.detail}</Text> : null}</Alert>)}
                    {result.data.alerts.length > 8 && <Text size="xs" c="dimmed">Showing the 8 most recent alerts. All matching events appear below.</Text>}
                  </Stack>
                </Card>
              )}
              <Card>
                <Group justify="space-between" mb="md" wrap="wrap"><div><Title order={2}>Activity</Title><Text size="sm" c="dimmed" mt={3}>{result.data?.events.length ?? 0} events loaded</Text></div></Group>
                {!result.data?.events.length ? <EmptyState icon={<IconShieldCheck size={20} />} title="No matching audit events">Try a wider date range or remove a filter.</EmptyState> : (
                  <Table.ScrollContainer minWidth={900}>
                    <Table striped highlightOnHover verticalSpacing="sm">
                      <Table.Thead><Table.Tr><Table.Th>When</Table.Th><Table.Th>Actor</Table.Th><Table.Th>Event</Table.Th><Table.Th>Action</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>Affected record</Table.Th></Table.Tr></Table.Thead>
                      <Table.Tbody>{result.data.events.map((event, index) => <Table.Tr key={event.id ?? `${event.recorded}-${index}`}>
                        <Table.Td className="tm-num">{formatTimestamp(event.recorded)}</Table.Td>
                        <Table.Td>{actorLabel(event)}</Table.Td>
                        <Table.Td>{eventSummary(event)}</Table.Td>
                        <Table.Td>{({ C: 'Create', R: 'Read', U: 'Update', D: 'Delete', E: 'Execute' } as Record<string, string>)[event.action ?? ''] ?? event.action ?? '—'}</Table.Td>
                        <Table.Td><StatusBadge status={event.outcome === '0' ? 'complete' : 'failed'} label={event.outcome === '0' ? 'Success' : `Failure · ${event.outcome ?? 'unknown'}`} /></Table.Td>
                        <Table.Td><Text size="sm" lineClamp={2}>{entityLabel(event)}</Text></Table.Td>
                      </Table.Tr>)}</Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
                <Group justify="space-between" mt="md"><Text size="sm" c="dimmed">Page {cursors.length}{result.data?.complete ? ' · Last page' : ' · More events available'}</Text><Group><Button variant="default" disabled={cursors.length === 1 || result.loading} onClick={() => setCursors(values => values.slice(0, -1))}>Newer events</Button><Button variant="default" disabled={!result.data?.nextCursor || result.loading} onClick={() => setCursors(values => [...values, result.data?.nextCursor])}>Older events</Button></Group></Group>
              </Card>
            </>
          )}
        </Stack>
      )}
    </PageBody>
  );
}
