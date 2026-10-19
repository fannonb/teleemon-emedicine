import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconDownload, IconRefresh, IconSearch } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatDate } from '../../utils/format';
import { REPORT_CATALOG } from '../../reports/catalog';
import type { ReportDefinition, ReportRole } from '../../reports/catalog';
import { createAuditedCsvExport } from '../../reports/csv';
import type { CsvValue } from '../../reports/csv';
import type { FinancialReportResult, OperationalReportResult } from '../../reports/query';
import { queryFinancialReport, queryOperationalReport } from '../../reports/query';
import { dateInputDaysAgo, downloadTextFile, formatTimestamp } from './phase9Format';

type ReportResult = FinancialReportResult | OperationalReportResult;
type ReportRow = Record<string, CsvValue>;
type ReportCategoryFilter = 'all' | 'operations' | 'financial';

const ROLE_PRIORITY: ReportRole[] = ['admin', 'biller', 'provider', 'frontdesk'];

function roleForReport(roles: readonly ReportRole[], definition: ReportDefinition): ReportRole | undefined {
  return ROLE_PRIORITY.find((role) => roles.includes(role) && definition.roles.includes(role));
}

function toRows(result: ReportResult): ReportRow[] {
  if (result.source === 'ledger') return result.rows;
  return result.rows.map((row) => ({
    date: row.date ?? row.lastUpdated ?? '',
    item: row.title ?? row.code ?? row.resourceType,
    resourceType: row.resourceType,
    status: row.status ?? '',
    patient: row.subjectDisplay ?? row.subjectRef ?? '',
    provider: row.providerDisplay ?? row.providerRef ?? '',
    id: row.id,
  }));
}

function columnName(key: string): string {
  const currencyLabels: Record<string, string> = {
    insuranceCents: 'Insurance A/R',
    patientCents: 'Patient A/R',
  };
  if (currencyLabels[key]) return currencyLabels[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\s+cents$/i, '')
    .replace(/\bref\b/gi, 'reference')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cellText(key: string, value: CsvValue): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && /cents$/i.test(key)) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return formatTimestamp(value);
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)) return formatDate(value);
  return String(value);
}

export function ReportsPage(): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const roleValues = roles as ReportRole[];
  const visibleReports = useMemo(
    () => REPORT_CATALOG.filter((report) => roleForReport(roleValues, report)),
    [roleValues.join('|')]
  );
  const [selectedId, setSelectedId] = useState<string>('appointment-volume');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ReportCategoryFilter>('all');
  const [from, setFrom] = useState(() => dateInputDaysAgo(30));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [applied, setApplied] = useState(() => ({ from: dateInputDaysAgo(30), to: new Date().toISOString().slice(0, 10) }));
  const [filterError, setFilterError] = useState<string>();
  const [extraRows, setExtraRows] = useState<ReportRow[]>([]);
  const [pageMeta, setPageMeta] = useState<OperationalReportResult>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string>();
  const [exporting, setExporting] = useState(false);

  const selected = visibleReports.find((report) => report.id === selectedId) ?? visibleReports[0];
  const selectedRole = selected ? roleForReport(roleValues, selected) : undefined;
  const isLedgerSnapshot = selected?.id === 'ledger-reconciliation';
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const filteredReports = visibleReports.filter((report) => {
    const categoryMatches = category === 'all' || report.category === category;
    const query = search.trim().toLowerCase();
    const textMatches = !query || `${report.title} ${report.description} ${report.dataSources.join(' ')}`.toLowerCase().includes(query);
    return categoryMatches && textMatches;
  });

  useEffect(() => {
    if (!visibleReports.some((report) => report.id === selectedId) && visibleReports[0]) {
      setSelectedId(visibleReports[0].id);
    }
  }, [selectedId, visibleReports]);

  const report = useLoader<ReportResult>(
    () => {
      if (!selected || !selectedRole) return Promise.reject(new Error('No reports are available for your role.'));
      return selected.source === 'ledger'
        ? queryFinancialReport(medplum, selected.id, isLedgerSnapshot ? { asOf: snapshotDate } : { from: applied.from, to: applied.to, asOf: applied.to }, selectedRole)
        : queryOperationalReport(medplum, selected.id, { from: applied.from, to: applied.to, limit: 100 }, selectedRole);
    },
    [medplum, selected?.id, selectedRole, applied.from, applied.to, isLedgerSnapshot, snapshotDate]
  );

  const current = report.data?.reportId === selected?.id &&
    (isLedgerSnapshot
      ? report.data.source === 'ledger' && report.data.filters.asOf === snapshotDate
      : report.data.filters.from === applied.from && report.data.filters.to === applied.to)
    ? report.data
    : undefined;

  useEffect(() => {
    setExtraRows([]);
    setPageMeta(undefined);
    setMoreError(undefined);
  }, [selected?.id, applied.from, applied.to]);

  useEffect(() => {
    if (current?.source === 'fhir') setPageMeta(current);
  }, [current]);

  const currentResult: ReportResult | undefined = current?.source === 'fhir' && pageMeta
    ? { ...current, asOf: pageMeta.asOf, complete: pageMeta.complete, nextCursor: pageMeta.nextCursor, total: pageMeta.total ?? current.total }
    : current;

  const visibleRows = useMemo(() => {
    const base = currentResult ? toRows(currentResult) : [];
    return currentResult?.source === 'fhir' ? [...base, ...extraRows] : base;
  }, [currentResult, extraRows]);
  const columns = useMemo(() => Object.keys(visibleRows[0] ?? {}).slice(0, 8), [visibleRows]);

  const applyFilters = (): void => {
    if (from && !/^\d{4}-\d\d-\d\d$/.test(from)) return setFilterError('Enter a valid start date.');
    if (to && !/^\d{4}-\d\d-\d\d$/.test(to)) return setFilterError('Enter a valid end date.');
    if (from && to && from > to) return setFilterError('The start date must be on or before the end date.');
    setFilterError(undefined);
    setExtraRows([]);
    setPageMeta(undefined);
    setApplied({ from, to });
  };

  const loadNextPage = async (): Promise<void> => {
    if (!selected || !selectedRole || pageMeta?.source !== 'fhir' || !pageMeta.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const next = await queryOperationalReport(
        medplum,
        selected.id,
        { from: applied.from, to: applied.to, cursor: pageMeta.nextCursor, limit: 100 },
        selectedRole
      );
      setExtraRows((rows) => [...rows, ...toRows(next)]);
      setPageMeta(next);
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : 'The next report page could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const exportReport = async (): Promise<void> => {
    if (!selected || !currentResult || !currentResult.complete || visibleRows.length === 0 || exporting) return;
    setExporting(true);
    try {
      const csv = await createAuditedCsvExport(medplum, selected.id, visibleRows, {
        columns,
        ...(isLedgerSnapshot ? { asOf: snapshotDate } : { from: applied.from, to: applied.to, asOf: currentResult.asOf }),
      });
      downloadTextFile(`${selected.id}-${isLedgerSnapshot ? snapshotDate : `${applied.from}-${applied.to}`}.csv`, csv, 'text/csv;charset=utf-8');
      notifications.show({ color: 'brand', title: 'Report exported', message: 'The metadata-only export event was added to the audit log.' });
    } catch (error) {
      notifications.show({ color: 'red', title: 'Export not completed', message: error instanceof Error ? error.message : 'The export could not be recorded.' });
    } finally {
      setExporting(false);
    }
  };

  const summary = currentResult?.source === 'ledger'
    ? Object.entries(currentResult.totals).slice(0, 4)
    : currentResult?.source === 'fhir'
      ? [['records', currentResult.total ?? visibleRows.length] as [string, number]]
      : [];

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="Phase 9 · Insight & admin"
        title="Reports"
        subtitle="Run operational and financial reports from the records available to your role."
        actions={
          <Button variant="default" leftSection={<IconRefresh size={15} />} onClick={report.reload} loading={report.loading}>
            Refresh
          </Button>
        }
      />

      <Grid gutter="lg" align="flex-start">
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Card>
            <Stack gap="md">
              <Group justify="space-between" align="center">
                <Title order={2}>Report catalogue</Title>
                <Badge variant="light" color="navy">{visibleReports.length} available</Badge>
              </Group>
              <TextInput
                aria-label="Search reports"
                placeholder="Search reports or data sources"
                leftSection={<IconSearch size={15} />}
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
              <Select
                label="Category"
                data={[
                  { value: 'all', label: 'All reports' },
                  { value: 'operations', label: 'Operations' },
                  { value: 'financial', label: 'Financial' },
                ]}
                value={category}
                onChange={(value) => setCategory((value as ReportCategoryFilter | null) ?? 'all')}
                allowDeselect={false}
              />
              {filteredReports.length === 0 ? (
                <EmptyState icon={<IconSearch size={20} />} title="No matching reports">Try another search or category.</EmptyState>
              ) : (
                <Stack gap={4}>
                  {filteredReports.map((item) => (
                    <Button
                      key={item.id}
                      variant={item.id === selected?.id ? 'light' : 'subtle'}
                      color={item.id === selected?.id ? 'brand' : 'gray'}
                      justify="space-between"
                      fullWidth
                      onClick={() => setSelectedId(item.id)}
                      styles={{ inner: { justifyContent: 'space-between' }, label: { whiteSpace: 'normal', textAlign: 'left' } }}
                    >
                      <span>{item.title}</span>
                      <Badge size="xs" variant="light" color={item.category === 'financial' ? 'navy' : 'teal'}>
                        {item.category}
                      </Badge>
                    </Button>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Stack gap="lg">
            <Card>
              <Stack gap="md">
                <Group justify="space-between" align="flex-start" wrap="wrap">
                  <div>
                    <Title order={2}>{selected?.title ?? 'No reports available'}</Title>
                    <Text size="sm" c="dimmed" mt={4}>{selected?.description ?? 'Your role does not have access to a report.'}</Text>
                  </div>
                  {selected && <Badge variant="light" color={selected.source === 'ledger' ? 'navy' : 'teal'}>{selected.source === 'ledger' ? 'Ledger source' : 'FHIR source'}</Badge>}
                </Group>
                <Group align="flex-end" gap="sm" wrap="wrap">
                  {isLedgerSnapshot ? <Text size="sm" c="dimmed" pb={8}>Current ledger snapshot · {formatDate(snapshotDate)}</Text> : <>
                    <TextInput type="date" label="From" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
                    <TextInput type="date" label="To / as of" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
                    <Button onClick={applyFilters} disabled={report.loading}>Apply filters</Button>
                  </>}
                  <Button
                    variant="default"
                    leftSection={<IconDownload size={15} />}
                    onClick={() => void exportReport()}
                    loading={exporting}
                    disabled={!currentResult?.complete || visibleRows.length === 0}
                  >
                    Export CSV
                  </Button>
                </Group>
                {filterError && <Alert color="red" variant="light" title="Check the date range">{filterError}</Alert>}
                <Text size="xs" c="dimmed">Export is enabled only when all report rows are loaded. The export event records report metadata, not the exported row contents.</Text>
              </Stack>
            </Card>

            {report.error && <ErrorState error={report.error} onRetry={report.reload} />}
            {report.loading && !currentResult && <Card><RowsSkeleton rows={5} /></Card>}
            {!report.loading && !report.error && currentResult && (
              <>
                {!currentResult.complete && (
                  <Alert color="orange" variant="light" title="Partial result">
                    {currentResult.source === 'ledger'
                      ? 'The ledger returned a capped result. Totals and exports are incomplete until the report query is narrowed.'
                      : 'More matching FHIR records are available. Load every page before exporting.'}
                  </Alert>
                )}
                {currentResult.source === 'ledger' && currentResult.reconciliation && (
                  <Alert color={currentResult.reconciliation.ok && currentResult.complete ? 'green' : 'orange'} variant="light" title={currentResult.reconciliation.ok && currentResult.complete ? 'Ledger checks passed' : 'Ledger checks need review'}>
                    {currentResult.reconciliation.checks.map((check) => (
                      <Text key={check.label} size="sm">{check.ok ? '✓' : '•'} {check.label}{check.expectedCents !== undefined && check.actualCents !== undefined ? ` · expected ${cellText('expectedCents', check.expectedCents)}, actual ${cellText('actualCents', check.actualCents)}` : ''}</Text>
                    ))}
                  </Alert>
                )}
                {summary.length > 0 && (
                  <Grid gutter="sm">
                    {summary.map(([key, value]) => (
                      <Grid.Col key={key} span={{ base: 6, sm: 3 }}>
                        <Card padding="md">
                          <Text size="xs" c="dimmed">{columnName(key)}</Text>
                          <Text fw={700} size="lg" className="tm-num">{cellText(key, value)}</Text>
                        </Card>
                      </Grid.Col>
                    ))}
                  </Grid>
                )}
                <Card padding="md">
                  <Group justify="space-between" mb="md" wrap="wrap">
                    <div>
                      <Title order={3}>Results</Title>
                      <Text size="xs" c="dimmed" mt={2}>As of {formatTimestamp(currentResult.asOf)} · {visibleRows.length} row{visibleRows.length === 1 ? '' : 's'} loaded</Text>
                    </div>
                    {currentResult.source === 'fhir' && currentResult.total !== undefined && <Badge variant="light">{currentResult.total} matching</Badge>}
                  </Group>
                  {visibleRows.length === 0 ? (
                    <EmptyState icon={<IconSearch size={20} />} title="No records in this range">Change the date range or choose another report.</EmptyState>
                  ) : (
                    <Table.ScrollContainer minWidth={720}>
                      <Table striped highlightOnHover verticalSpacing="sm">
                        <Table.Thead>
                          <Table.Tr>{columns.map((key) => <Table.Th key={key}>{columnName(key)}</Table.Th>)}</Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {visibleRows.map((row, index) => (
                            <Table.Tr key={String(row.id ?? row.journalId ?? index)}>
                              {columns.map((key) => <Table.Td key={key} className={/cents|count|amount/i.test(key) ? 'tm-num' : undefined}>{cellText(key, row[key])}</Table.Td>)}
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </Table.ScrollContainer>
                  )}
                  {currentResult.source === 'fhir' && currentResult.nextCursor && (
                    <Group justify="flex-end" mt="md">
                      {moreError && <Text size="sm" c="red">{moreError}</Text>}
                      <Button variant="default" onClick={() => void loadNextPage()} loading={loadingMore}>Load next page</Button>
                    </Group>
                  )}
                  {!currentResult.complete && currentResult.source === 'ledger' && <Text size="xs" c="dimmed" mt="md">Narrow the date range to bring this report within the ledger result limit.</Text>}
                </Card>
              </>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </PageBody>
  );
}
