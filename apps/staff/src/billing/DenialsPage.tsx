import { Badge, Button, Card, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconClock } from '@tabler/icons-react';
import type { PayerConfig } from '@teleemon/core';
import { claimStatusOf } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { formatDate } from '../utils/format';
import { ClaimStatusBadge, DeadlineBadge } from './billingUi';
import { payerName } from './charges';
import { DenialDrawer } from './DenialDrawer';
import { CATEGORY_LABEL, loadDenials } from './denials';
import type { DenialRow } from './denials';
import { payerOfClaim } from './claimWork';

// P34 Denials & appeals: every open denial, the nearest appeal deadline first. Each one needs an
// owner's next step or a reason to close it; the drawer holds the appeal, the transfer and the closes.

type View = 'all' | 'overdue' | 'week';

const VIEWS: readonly { readonly value: View; readonly label: string }[] = [
  { value: 'all', label: 'All open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'week', label: 'Due in 7 days' },
];

const inView = (r: DenialRow, view: View): boolean => {
  if (view === 'all') return true;
  if (r.days === undefined) return false;
  return view === 'overdue' ? r.days < 0 : r.days >= 0 && r.days <= 7;
};

export function DenialsPage(): JSX.Element {
  const medplum = useMedplum();
  const [view, setView] = useState<View>('all');
  const [openId, setOpenId] = useState<string>();
  const data = useLoader(() => loadDenials(medplum), [medplum]);
  const all = data.data?.rows ?? [];
  const shown = all.filter((r) => inView(r, view));
  const overdue = all.filter((r) => r.days !== undefined && r.days < 0).length;
  const soon = all.filter((r) => r.days !== undefined && r.days >= 0 && r.days <= 7).length;
  const openRow = openId ? all.find((r) => r.task.id === openId) : undefined;
  const payers: readonly PayerConfig[] = data.data?.payers ?? [];

  return (
    <PageBody wide>
      <PageHeader eyebrow="P34 · Billing" title="Denials & appeals" subtitle="Denied claims, the nearest appeal deadline first. Each one needs a next step or a reason to close it." />
      <Stack gap="lg">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Group gap="xs" wrap="wrap" aria-live="polite">
            <Badge color={overdue ? 'red' : 'green'} variant="light" leftSection={overdue ? <IconAlertTriangle size={12} /> : <IconCircleCheck size={12} />} className="tm-num">
              {overdue} overdue
            </Badge>
            <Badge color={soon ? 'orange' : 'gray'} variant="light" leftSection={<IconClock size={12} />} className="tm-num">
              {soon} due within 7 days
            </Badge>
            <Badge color="gray" variant="outline" className="tm-num">
              {all.length} open
            </Badge>
          </Group>
          <SegmentedControl value={view} onChange={(v) => setView(v as View)} data={VIEWS.map((v) => ({ value: v.value, label: v.label }))} aria-label="Filter denials" />
        </Group>

        <Section
          loaded={data}
          padding="md"
          rows={6}
          isEmpty={() => shown.length === 0}
          empty={{
            icon: <IconCircleCheck size={22} />,
            title: view === 'all' ? 'No open denials' : 'Nothing in this view',
            text: view === 'all' ? 'Denials arrive with the remittance and wait here until they are appealed or closed.' : 'Switch the filter to see every open denial.',
          }}
        >
          {() => (
            <Card padding={0} withBorder={false}>
              <Table.ScrollContainer minWidth={1180}>
                <Table verticalSpacing="sm" highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Appeal deadline</Table.Th>
                      <Table.Th>Patient</Table.Th>
                      <Table.Th>Claim</Table.Th>
                      <Table.Th>Payer</Table.Th>
                      <Table.Th>Reason codes</Table.Th>
                      <Table.Th>Category</Table.Th>
                      <Table.Th>Recommended next step</Table.Th>
                      <Table.Th>Claim status</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {shown.map((r) => (
                      <DenialTableRow key={r.task.id} row={r} payers={payers} onOpen={() => setOpenId(r.task.id)} />
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          )}
        </Section>
      </Stack>

      {openRow && data.data && (
        <DenialDrawer
          key={`${openRow.task.id}:${openRow.task.meta?.versionId}:${openRow.claim?.meta?.versionId ?? ''}`}
          row={openRow}
          payers={payers}
          onClose={() => setOpenId(undefined)}
          onChanged={() => data.reload()}
        />
      )}
    </PageBody>
  );
}

function DenialTableRow({ row, payers, onOpen }: { readonly row: DenialRow; readonly payers: readonly PayerConfig[]; readonly onOpen: () => void }): JSX.Element {
  const name = patientName(row.patient);
  const payer = row.claim ? payerName(payerOfClaim(row.claim), payers).text : '—';
  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer' }}>
      <Table.Td>
        <DeadlineBadge days={row.days} date={row.deadline} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={600}>
          {name}
        </Text>
        <Text size="xs" c="dimmed" className="tm-num">
          Denied {formatDate(row.task.authoredOn?.slice(0, 10))}
        </Text>
      </Table.Td>
      <Table.Td className="tm-num">
        <Text size="sm">{row.claim?.id?.slice(0, 8) ?? '—'}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{payer}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="wrap">
          {row.carc.length === 0 ? (
            <Text size="sm" c="dimmed">
              None
            </Text>
          ) : (
            row.carc.map((c) => (
              <Badge key={c} variant="outline" color="gray" className="tm-num">
                {c}
              </Badge>
            ))
          )}
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{CATEGORY_LABEL[row.category]}</Text>
      </Table.Td>
      <Table.Td maw={320}>
        <Text size="xs" lineClamp={2}>
          {row.action}
        </Text>
      </Table.Td>
      <Table.Td>{row.claim ? <ClaimStatusBadge status={claimStatusOf(row.claim)} /> : <Text size="sm" c="dimmed">—</Text>}</Table.Td>
      <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="default" onClick={onOpen} aria-label={`Open denial for ${name}`}>
          Open
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}
