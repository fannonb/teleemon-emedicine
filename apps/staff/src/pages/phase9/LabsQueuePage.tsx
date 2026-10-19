import { Alert, Button, Card, Grid, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconExternalLink, IconFlask, IconSearch } from '@tabler/icons-react';
import type { DocumentReference, ServiceRequest, Task } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { patientName } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatDate } from '../../utils/format';
import { loadLabQueue } from '../../operations/labs';
import type { LabQueue, LabQueueOrder, LabQueueResult } from '../../operations/labs';
import { StatusBadge } from './phase9Format';

type LabFilter = 'all' | 'awaiting' | 'review' | 'abnormal';

function patientLabel(patient: LabQueueOrder['patient'] | LabQueueResult['patient'] | undefined, reference?: string): string {
  return patient ? patientName(patient) : reference ?? 'Patient not linked';
}

function isAwaitingResult(order: ServiceRequest): boolean {
  return order.status === 'active' || order.status === 'draft' || order.status === 'on-hold';
}

function resultRows(queue: LabQueue): LabQueueResult[] {
  const linked = queue.orders.flatMap((row) => row.results);
  const linkedIds = new Set(linked.map((result) => result.document.id).filter(Boolean));
  return [...linked, ...queue.unlinkedResults.filter((document) => !linkedIds.has(document.id)).map((document) => ({ document, reviewed: false }))];
}

function orderTest(order: ServiceRequest): string {
  return order.code?.text ?? order.code?.coding?.find((coding) => coding.display)?.display ?? 'Lab order';
}

function resultTitle(document: DocumentReference): string {
  return document.description ?? document.content?.[0]?.attachment?.title ?? 'Lab result';
}

function monitoringDue(task: Task): string {
  return task.executionPeriod?.end ?? task.restriction?.period?.end ?? task.authoredOn ?? '';
}

export function LabsQueuePage(): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const allowed = roles.includes('provider') || roles.includes('admin');
  const queue = useLoader(() => allowed ? loadLabQueue(medplum) : Promise.resolve({ orders: [], unlinkedResults: [], monitoring: [] }), [medplum, allowed], 60000);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LabFilter>('all');

  const results = useMemo(() => queue.data ? resultRows(queue.data) : [], [queue.data]);
  const orders = useMemo(() => (queue.data?.orders ?? []).filter((row) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || `${patientLabel(row.patient, row.order.subject?.reference)} ${orderTest(row.order)} ${row.order.performer?.map((x) => x.display).join(' ')}`.toLowerCase().includes(query);
    const matchesFilter = filter === 'all' || (filter === 'awaiting' && isAwaitingResult(row.order)) || (filter === 'review' && row.results.some((result) => !result.reviewed)) || (filter === 'abnormal' && row.results.some((result) => result.abnormal));
    return matchesSearch && matchesFilter;
  }), [queue.data, search, filter]);
  const filteredResults = useMemo(() => results.filter((result) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || `${patientLabel(result.patient, result.document.subject?.reference)} ${resultTitle(result.document)} ${result.review?.comment ?? ''}`.toLowerCase().includes(query);
    const matchesFilter = filter === 'all' || (filter === 'review' && !result.reviewed) || (filter === 'abnormal' && !!result.abnormal) || (filter === 'awaiting' && false);
    return matchesSearch && matchesFilter;
  }), [results, search, filter]);
  const reviewCount = results.filter((result) => !result.reviewed).length;
  const abnormalCount = results.filter((result) => result.abnormal).length;
  const awaitingCount = (queue.data?.orders ?? []).filter((row) => isAwaitingResult(row.order)).length;

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="P27 · Clinical work"
        title="Lab orders & results"
        subtitle="Track outstanding orders, filed results and monitoring follow-up across the practice."
      />
      <Stack gap="lg">
        {!allowed ? <Alert color="red" variant="light" title="Provider access required">Lab orders and results are limited to providers and administrators.</Alert> : <>
        <Alert color="blue" variant="light" icon={<IconFlask size={17} />} title="Records in Teleemon">
          This queue reflects lab orders and results stored in the chart. A displayed order does not indicate that an electronic lab interface is connected.
        </Alert>
        <Grid gutter="md">
          {[
            { label: 'Awaiting results', value: awaitingCount, color: 'blue' },
            { label: 'Results to review', value: reviewCount, color: 'orange' },
            { label: 'Reviewed abnormal', value: abnormalCount, color: abnormalCount ? 'red' : 'green' },
            { label: 'Monitoring tasks', value: queue.data?.monitoring.length ?? 0, color: 'navy' },
          ].map((item) => (
            <Grid.Col key={item.label} span={{ base: 6, sm: 3 }}>
              <Card padding="md">
                <Text size="xs" c="dimmed">{item.label}</Text>
                <Text size="xl" fw={700} className="tm-num" c={`${item.color}.7`}>{queue.loading && !queue.data ? '—' : item.value}</Text>
              </Card>
            </Grid.Col>
          ))}
        </Grid>
        <Card>
          <Stack gap="md">
            <Group justify="space-between" align="flex-end" wrap="wrap">
              <div>
                <Title order={2}>Practice lab queue</Title>
                <Text size="sm" c="dimmed" mt={3}>Open the patient chart to review or file details.</Text>
              </div>
              <Group gap="sm" align="flex-end">
                <TextInput
                  label="Search"
                  placeholder="Patient or test"
                  leftSection={<IconSearch size={15} />}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                />
                <Select
                  label="Show"
                  data={[
                    { value: 'all', label: 'All orders and results' },
                    { value: 'awaiting', label: 'Awaiting result' },
                    { value: 'review', label: 'Needs review' },
                    { value: 'abnormal', label: 'Reviewed abnormal' },
                  ]}
                  value={filter}
                  onChange={(value) => setFilter((value as LabFilter | null) ?? 'all')}
                  allowDeselect={false}
                  w={190}
                />
              </Group>
            </Group>
            {queue.error ? <ErrorState error={queue.error} onRetry={queue.reload} /> : queue.loading && !queue.data ? <RowsSkeleton rows={7} /> : (
              <>
                {(filter === 'all' || filter === 'awaiting') && (
                  <div>
                    <Title order={3} mb="sm">Orders</Title>
                    {orders.length === 0 ? (
                      <EmptyState icon={<IconFlask size={20} />} title="No matching lab orders">Orders will appear here when they are written in a patient chart.</EmptyState>
                    ) : (
                      <Table.ScrollContainer minWidth={690}>
                        <Table striped highlightOnHover verticalSpacing="sm">
                          <Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Test</Table.Th><Table.Th>Lab</Table.Th><Table.Th>Ordered</Table.Th><Table.Th>Status</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                          <Table.Tbody>
                            {orders.map(({ order, patient, results: linkedResults }) => (
                              <Table.Tr key={order.id}>
                                <Table.Td>{patient?.id ? <Link to={`/patients/${patient.id}/labs`}>{patientLabel(patient)}</Link> : patientLabel(undefined, order.subject?.reference)}</Table.Td>
                                <Table.Td><Text size="sm" fw={600}>{orderTest(order)}</Text>{linkedResults.length > 0 && <Text size="xs" c="dimmed">{linkedResults.length} result{linkedResults.length === 1 ? '' : 's'} linked</Text>}</Table.Td>
                                <Table.Td>{order.performer?.map((item) => item.display).filter(Boolean).join(', ') || 'Not specified'}</Table.Td>
                                <Table.Td className="tm-num">{formatDate(order.authoredOn?.slice(0, 10))}</Table.Td>
                                <Table.Td><StatusBadge status={order.status} label={isAwaitingResult(order) ? 'Awaiting result' : order.status} /></Table.Td>
                                <Table.Td ta="right">{patient?.id && <Button component={Link} to={`/patients/${patient.id}/labs`} size="xs" variant="subtle" rightSection={<IconExternalLink size={13} />}>Open chart</Button>}</Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Table.ScrollContainer>
                    )}
                  </div>
                )}
                {(filter === 'all' || filter === 'review' || filter === 'abnormal') && (
                  <div>
                    <Title order={3} mb="sm">Results</Title>
                    {filteredResults.length === 0 ? (
                      <EmptyState icon={<IconFlask size={20} />} title="No matching lab results">Filed results and their review status will appear here.</EmptyState>
                    ) : (
                      <Table.ScrollContainer minWidth={650}>
                        <Table striped highlightOnHover verticalSpacing="sm">
                          <Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Result</Table.Th><Table.Th>Received</Table.Th><Table.Th>Review</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                          <Table.Tbody>
                            {filteredResults.map((result, index) => (
                              <Table.Tr key={result.document.id ?? index}>
                                <Table.Td>{patientLabel(result.patient, result.document.subject?.reference)}</Table.Td>
                                <Table.Td><Text size="sm" fw={600}>{resultTitle(result.document)}</Text>{result.review?.comment && <Text size="xs" c="dimmed">{result.review.comment}</Text>}</Table.Td>
                                <Table.Td className="tm-num">{formatDate(result.document.date?.slice(0, 10))}</Table.Td>
                                <Table.Td>{result.reviewed ? <StatusBadge status={result.abnormal ? 'abnormal' : 'complete'} label={result.abnormal ? 'Abnormal · reviewed' : 'Reviewed'} /> : <StatusBadge status="pending" label="Needs review" />}</Table.Td>
                                <Table.Td ta="right">{result.patient?.id && <Button component={Link} to={`/patients/${result.patient.id}/labs`} size="xs" variant="subtle" rightSection={<IconExternalLink size={13} />}>Open chart</Button>}</Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Table.ScrollContainer>
                    )}
                  </div>
                )}
                {queue.data?.unlinkedResults.length ? (
                  <Alert color="orange" variant="light" title="Results without an order link">
                    {queue.data.unlinkedResults.length} result record{queue.data.unlinkedResults.length === 1 ? ' is' : 's are'} not linked to a lab order. Open its patient chart to review the record.
                  </Alert>
                ) : null}
                <div>
                  <Title order={3} mb="sm">Monitoring follow-up</Title>
                  {queue.data?.monitoring.length ? (
                    <Table.ScrollContainer minWidth={550}>
                      <Table verticalSpacing="sm">
                        <Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Follow-up</Table.Th><Table.Th>Due / created</Table.Th><Table.Th>Status</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                        <Table.Tbody>
                          {queue.data.monitoring.map(({ task, patient }) => (
                            <Table.Tr key={task.id}>
                              <Table.Td>{patientLabel(patient, task.for?.reference)}</Table.Td>
                              <Table.Td>{task.description ?? task.code?.text ?? 'Lab monitoring'}</Table.Td>
                              <Table.Td className="tm-num">{formatDate(monitoringDue(task).slice(0, 10))}</Table.Td>
                              <Table.Td><StatusBadge status={task.status} /></Table.Td>
                              <Table.Td ta="right">{patient?.id && <Button component={Link} to={`/patients/${patient.id}/labs`} size="xs" variant="subtle">Open chart</Button>}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  ) : <Text size="sm" c="dimmed">No active lab-monitoring tasks are recorded.</Text>}
                </div>
              </>
            )}
            {roles.includes('provider') && <Text size="xs" c="dimmed">Result review and new orders remain in the patient chart so the clinical context stays with the record.</Text>}
          </Stack>
        </Card>
        </>}
      </Stack>
    </PageBody>
  );
}
