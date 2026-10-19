import { Alert, Badge, Button, Group, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { MedplumClient } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconSortAscending, IconSortDescending } from '@tabler/icons-react';
import type { Patient } from '@medplum/fhirtypes';
import type { PayerConfig } from '@teleemon/core';
import { formatCents, readSettings, zonedDate } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { EmptyState } from '../components/states';
import { useLoader } from '../hooks/useLoader';
import { formatDate, formatTime } from '../utils/format';
import { patientsByRef } from './billingShared';
import { payerName } from './charges';
import type { AgingCounts, ArReport, ReconciliationReport } from './ledgerApi';
import { ledgerApi } from './ledgerApi';

// P36 A/R dashboard: what insurers and patients owe, by age. Every figure is the server's own number,
// shown exactly as returned. The only values computed here are bar widths and the order of the
// tables. The reconciliation panel lists every check the ledger ran on the same read.

type ArRow = ArReport['rows'][number];
type Bucket = keyof AgingCounts;

const BUCKETS: readonly Bucket[] = ['0-30', '31-60', '61-90', '91-120', '120+'];
const BUCKET_LABEL: Record<Bucket, string> = { '0-30': '0–30 days', '31-60': '31–60 days', '61-90': '61–90 days', '91-120': '91–120 days', '120+': 'Over 120 days' };
const BUCKET_COLOR: Record<Bucket, string> = {
  '0-30': 'var(--mantine-color-brand-6)',
  '31-60': 'var(--mantine-color-yellow-6)',
  '61-90': 'var(--mantine-color-orange-6)',
  '91-120': 'var(--mantine-color-red-5)',
  '120+': 'var(--mantine-color-red-8)',
};

type SortBy = 'total' | 'over90';
interface Sort {
  readonly by: SortBy;
  readonly dir: 'asc' | 'desc';
}

/** Ordering key only: the two buckets over 90 days added together. It is never displayed. */
const over90Key = (b: AgingCounts): number => b['91-120'] + b['120+'];

function sortedRows(rows: readonly ArRow[], sort: Sort): ArRow[] {
  const key = (r: ArRow): number => (sort.by === 'total' ? r.totalCents : over90Key(r.buckets));
  const sign = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => sign * (key(a) - key(b)));
}

interface ArData {
  readonly report: ArReport;
  readonly payers: readonly PayerConfig[];
  readonly patients: ReadonlyMap<string, Patient>;
}

async function loadAr(medplum: MedplumClient): Promise<ArData> {
  const [report, settings] = await Promise.all([ledgerApi.ar(medplum), readSettings(medplum, 'billing')]);
  const patients = await patientsByRef(medplum, report.rows.filter((r) => r.kind === 'patient').map((r) => r.ref));
  return { report, payers: settings.payers, patients };
}

export function ArPage(): JSX.Element {
  const medplum = useMedplum();
  const ar = useLoader(() => loadAr(medplum), [medplum]);
  const recon = useLoader(() => ledgerApi.reconciliation(medplum), [medplum]);

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="P36 · Billing"
        title="A/R dashboard"
        subtitle="What insurers and patients owe, by age. Every figure is read from the ledger and reconciled to it below."
        actions={recon.data ? <TieBadge recon={recon.data} /> : undefined}
      />
      <Stack gap="lg">
        <Section loaded={ar} padding="lg" rows={6}>
          {(d) => <ArContent data={d} />}
        </Section>
        <Section loaded={recon} title="Reconciliation" padding="lg" rows={6}>
          {(r) => <ReconContent recon={r} />}
        </Section>
      </Stack>
    </PageBody>
  );
}

/** The header status: only "Ties to the ledger" when every check passes. */
function TieBadge({ recon }: { readonly recon: ReconciliationReport }): JSX.Element {
  const failing = recon.checks.filter((c) => !c.ok).length;
  return (
    <span aria-live="polite">
      {recon.ok ? (
        <Badge color="green" variant="light" size="lg" leftSection={<IconCircleCheck size={14} />}>
          Ties to the ledger
        </Badge>
      ) : (
        <Badge color="red" variant="light" size="lg" leftSection={<IconCircleX size={14} />}>
          {failing} check{failing === 1 ? '' : 's'} failing
        </Badge>
      )}
    </span>
  );
}

function ArContent({ data }: { readonly data: ArData }): JSX.Element {
  const { report: r, payers, patients } = data;
  const [sort, setSort] = useState<Sort>({ by: 'total', dir: 'desc' });
  const insurance = sortedRows(
    r.rows.filter((x) => x.kind === 'insurance'),
    sort
  );
  const patientRows = sortedRows(
    r.rows.filter((x) => x.kind === 'patient'),
    sort
  );

  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        As of {formatDate(zonedDate(new Date(r.asOf)))}, {formatTime(r.asOf)}
      </Text>

      {r.complete === false && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Partial totals">
          The ledger holds more entries than this read returned, so the figures below are incomplete. Reconcile to the ledger before relying on them.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md" aria-live="polite">
        <Kpi value={formatCents(r.totals.totalCents)} label="Total A/R" />
        <Kpi value={formatCents(r.totals.insuranceCents)} label="Owed by insurers" />
        <Kpi value={formatCents(r.totals.patientCents)} label="Owed by patients" />
        <Kpi value={formatCents(r.totals.creditCents)} label="Credit held for patients" />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <AgingPanel title="Insurance receivable, by age" counts={r.totals.insurance} />
        <AgingPanel title="Patient receivable, by age" counts={r.totals.patient} />
      </SimpleGrid>

      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text fw={650}>Tables</Text>
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={sort.by}
            onChange={(v) => setSort((s) => ({ ...s, by: v as SortBy }))}
            data={[
              { value: 'total', label: 'Total' },
              { value: 'over90', label: 'Over 90 days' },
            ]}
            aria-label="Sort both tables by"
          />
          <Button size="xs" variant="default" onClick={() => setSort((s) => ({ ...s, dir: s.dir === 'desc' ? 'asc' : 'desc' }))} leftSection={sort.dir === 'desc' ? <IconSortDescending size={14} /> : <IconSortAscending size={14} />}>
            {sort.dir === 'desc' ? 'Largest first' : 'Smallest first'}
          </Button>
        </Group>
      </Group>

      <Stack gap="xs">
        <Text fw={600} size="sm">
          By payer
        </Text>
        {insurance.length === 0 ? (
          <EmptyState icon={<IconCircleCheck size={22} />} title="No insurance balances open">
            Claims billed to a payer appear here until the payer has paid them.
          </EmptyState>
        ) : (
          <AgingTable
            label="Payer"
            rows={insurance}
            name={(row) => payerName(row.ref, payers).text}
          />
        )}
      </Stack>

      <Stack gap="xs">
        <Text fw={600} size="sm">
          By patient
        </Text>
        {patientRows.length === 0 ? (
          <EmptyState icon={<IconCircleCheck size={22} />} title="No patient balances open">
            Patient balances appear here once a visit leaves an amount for the patient to pay.
          </EmptyState>
        ) : (
          <AgingTable
            label="Patient"
            rows={patientRows}
            name={(row) => {
              const p = patients.get(row.ref);
              return p ? patientName(p) : 'Unknown patient';
            }}
            idOf={(row) => row.ref.split('/')[1]?.slice(0, 8)}
          />
        )}
      </Stack>
    </Stack>
  );
}

function Kpi({ value, label }: { readonly value: string; readonly label: string }): JSX.Element {
  return (
    <Paper withBorder p="md" radius="md">
      <Text fz={24} fw={700} lh={1.2} className="tm-num">
        {value}
      </Text>
      <Text size="sm" c="dimmed" mt={4}>
        {label}
      </Text>
    </Paper>
  );
}

/** One bar per bucket, scaled to the largest bucket in the group. Each amount is written beside its bar. */
function AgingPanel({ title, counts }: { readonly title: string; readonly counts: AgingCounts }): JSX.Element {
  const largest = Math.max(0, ...BUCKETS.map((b) => counts[b]));
  return (
    <Paper withBorder p="md" radius="md">
      <Text fw={650} size="sm" mb="sm">
        {title}
      </Text>
      <Stack gap={8}>
        {BUCKETS.map((b) => {
          const value = counts[b];
          const width = largest > 0 && value > 0 ? (value / largest) * 100 : 0;
          return (
            <Group key={b} gap="sm" wrap="nowrap">
              <Text size="xs" c="dimmed" w={96} style={{ flexShrink: 0 }}>
                {BUCKET_LABEL[b]}
              </Text>
              <div aria-hidden style={{ flex: 1, minWidth: 0, height: 10, borderRadius: 999, background: 'var(--mantine-color-default-border)', overflow: 'hidden' }}>
                <div style={{ width: `${width}%`, height: '100%', background: BUCKET_COLOR[b] }} />
              </div>
              <Text size="sm" w={116} ta="right" className="tm-num" style={{ flexShrink: 0 }}>
                {formatCents(value)}
              </Text>
            </Group>
          );
        })}
      </Stack>
      <Text size="xs" c="dimmed" mt="sm">
        Bar lengths are relative to the largest bucket in this group.
      </Text>
    </Paper>
  );
}

function AgingTable({
  label,
  rows,
  name,
  idOf,
}: {
  readonly label: string;
  readonly rows: readonly ArRow[];
  readonly name: (row: ArRow) => string;
  readonly idOf?: (row: ArRow) => string | undefined;
}): JSX.Element {
  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="sm" highlightOnHover aria-label={`Balances by ${label.toLowerCase()}`}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{label}</Table.Th>
            {BUCKETS.map((b) => (
              <Table.Th key={b} ta="right">
                {BUCKET_LABEL[b]}
              </Table.Th>
            ))}
            <Table.Th ta="right">Total</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.key}>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {name(row)}
                </Text>
                {idOf && (
                  <Text size="xs" c="dimmed" className="tm-num">
                    {idOf(row)}
                  </Text>
                )}
              </Table.Td>
              {BUCKETS.map((b) => (
                <Table.Td key={b} ta="right" className="tm-num">
                  <Text size="sm">{formatCents(row.buckets[b])}</Text>
                </Table.Td>
              ))}
              <Table.Td ta="right" className="tm-num">
                <Text size="sm" fw={600}>
                  {formatCents(row.totalCents)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * The ledger's own checks. Amounts are cents, except the entry-count check, which the server
 * reports in the same fields; that one is shown as a count so it is not read as dollars.
 */
function ReconContent({ recon }: { readonly recon: ReconciliationReport }): JSX.Element {
  const failing = recon.checks.filter((c) => !c.ok).length;
  const valueText = (label: string, cents: number | undefined): string => {
    if (cents === undefined) return '—';
    return label.startsWith('The entry list') ? `${cents.toLocaleString('en-US')} entries` : formatCents(cents);
  };
  return (
    <Stack gap="sm">
      <Text size="sm" c={recon.ok ? 'dimmed' : 'red'} aria-live="polite">
        {recon.ok ? 'Every check passes.' : `${failing} check${failing === 1 ? '' : 's'} failing. Do not rely on the totals above until every check passes.`}
      </Text>
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="sm" withRowBorders aria-label="Reconciliation checks">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Result</Table.Th>
              <Table.Th>Check</Table.Th>
              <Table.Th ta="right">Expected</Table.Th>
              <Table.Th ta="right">Actual</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {recon.checks.map((c, i) => (
              <Table.Tr key={`${i}-${c.label}`}>
                <Table.Td>
                  <Badge color={c.ok ? 'green' : 'red'} variant="light" leftSection={c.ok ? <IconCircleCheck size={12} /> : <IconCircleX size={12} />}>
                    {c.ok ? 'Pass' : 'Fail'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{c.label}</Text>
                </Table.Td>
                <Table.Td ta="right" className="tm-num">
                  <Text size="sm">{valueText(c.label, c.expectedCents)}</Text>
                </Table.Td>
                <Table.Td ta="right" className="tm-num">
                  <Text size="sm">{valueText(c.label, c.actualCents)}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
