import { Badge, Button, Card, Checkbox, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconInbox } from '@tabler/icons-react';
import type { PayerConfig } from '@teleemon/core';
import { chargeItemCents, chargeLineOf, formatCents, readSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { formatDate } from '../utils/format';
import { ChargeDrawer } from './ChargeDrawer';
import type { ChargeRow, ChargeTab } from './charges';
import { CHARGE_TABS, aiUnaccepted, chargeId, codeOf, diagnosesOf, holdReasonOf, loadCharges, payerName, payerOf, releaseProblems, rowPatientName, saveCharge } from './charges';

interface Queue {
  readonly payers: readonly PayerConfig[];
  readonly rows: ChargeRow[];
}

const EMPTY: Record<ChargeTab, { title: string; text: string }> = {
  planned: { title: 'Nothing waiting for review', text: 'Charges appear here when a signed note includes a visit code. Each needs a payer and a diagnosis before it can be released.' },
  billable: { title: 'No billable charges yet', text: 'Released charges wait here until claims are built from them.' },
  'not-billable': { title: 'No held charges', text: 'Charges held or returned to review show here with the reason given.' },
  'entered-in-error': { title: 'No charges entered in error', text: 'Charges entered by mistake stay on record here, with the reason. They are never deleted.' },
};

// P30 Charge review: confirm each charge from a signed note before it can become a claim.
export function ChargeReviewPage(): JSX.Element {
  const medplum = useMedplum();
  const [tab, setTab] = useState<ChargeTab>('planned');
  const [picked, setPicked] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [releasing, setReleasing] = useState(false);

  const queue = useLoader<Queue>(
    async () => {
      const [settings, rows] = await Promise.all([readSettings(medplum, 'billing'), loadCharges(medplum, tab)]);
      return { payers: settings.payers, rows };
    },
    [medplum, tab]
  );

  const payers = queue.data?.payers ?? [];
  const rows = queue.data?.rows ?? [];
  const isReviewTab = tab === 'planned';
  const readyIds = isReviewTab ? rows.filter((r) => releaseProblems(r.charge, payers).length === 0).map((r) => chargeId(r.charge)) : [];
  const openRow = openId ? rows.find((r) => chargeId(r.charge) === openId) : undefined;

  // The drawer closes itself once its charge leaves this queue (released, held or errored).
  useEffect(() => {
    if (!openId || !queue.data) return;
    if (!queue.data.rows.some((r) => chargeId(r.charge) === openId)) setOpenId(undefined);
  }, [openId, queue.data]);

  const changeTab = (value: ChargeTab): void => {
    setTab(value);
    setPicked([]);
    setOpenId(undefined);
  };

  const togglePick = (id: string, on: boolean): void => setPicked((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  const releaseSelected = async (): Promise<void> => {
    const targets = rows.filter((r) => picked.includes(chargeId(r.charge)) && releaseProblems(r.charge, payers).length === 0);
    if (targets.length === 0) return;
    setReleasing(true);
    let released = 0;
    const failures: string[] = [];
    // One at a time: each write is checked against its own version, and the server checks each charge.
    for (const row of targets) {
      try {
        await saveCharge(medplum, row.charge, { ...row.charge, status: 'billable' });
        released += 1;
      } catch (err) {
        failures.push(`${rowPatientName(row)}: ${normalizeErrorString(err)}`);
      }
    }
    setReleasing(false);
    setPicked([]);
    queue.reload();
    if (released > 0) notifications.show({ color: 'brand', title: 'Released', message: `${released} charge${released === 1 ? '' : 's'} released to billing.` });
    if (failures.length > 0) notifications.show({ color: 'red', title: `${failures.length} not released`, message: failures[0], autoClose: false });
  };

  const allReadyPicked = readyIds.length > 0 && readyIds.every((id) => picked.includes(id));

  return (
    <PageBody wide>
      <PageHeader eyebrow="P30 · Billing" title="Charge review" subtitle="Confirm each charge from a signed note before it can become a claim. Nothing is billed until it is released." />
      <Stack gap="lg">
        <SegmentedControl value={tab} onChange={(v) => changeTab(v as ChargeTab)} data={CHARGE_TABS.map((t) => ({ value: t.value, label: t.label }))} style={{ alignSelf: 'flex-start' }} />
        <Section
          loaded={queue}
          padding="md"
          rows={6}
          isEmpty={(d) => d.rows.length === 0}
          empty={{ icon: <IconInbox size={22} />, title: EMPTY[tab].title, text: EMPTY[tab].text }}
          actions={
            isReviewTab && queue.data ? (
              <Text size="sm" c="dimmed" className="tm-num" aria-live="polite">
                {rows.length} to review · {readyIds.length} ready
              </Text>
            ) : undefined
          }
        >
          {(data) => (
            <Stack gap="sm">
              {isReviewTab && picked.length > 0 && (
                <Group justify="space-between" p="sm" style={{ border: '1px solid var(--tm-border)', borderRadius: 8 }}>
                  <Text size="sm" aria-live="polite">
                    {picked.length} selected. Each is checked by the server as it releases.
                  </Text>
                  <Group gap="xs">
                    <Button variant="subtle" size="xs" onClick={() => setPicked([])} disabled={releasing}>
                      Clear
                    </Button>
                    <Button size="xs" leftSection={<IconCircleCheck size={14} />} onClick={releaseSelected} loading={releasing}>
                      Release {picked.length}
                    </Button>
                  </Group>
                </Group>
              )}
              <Card padding={0} withBorder={false}>
                <Table.ScrollContainer minWidth={1080}>
                  <Table verticalSpacing="sm" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        {isReviewTab && (
                          <Table.Th style={{ width: 36 }}>
                            <Checkbox
                              aria-label="Select all clean charges"
                              checked={allReadyPicked}
                              indeterminate={picked.length > 0 && !allReadyPicked}
                              disabled={readyIds.length === 0}
                              onChange={(e) => setPicked(e.currentTarget.checked ? readyIds : [])}
                            />
                          </Table.Th>
                        )}
                        <Table.Th>Service date</Table.Th>
                        <Table.Th>Patient</Table.Th>
                        <Table.Th>Provider</Table.Th>
                        <Table.Th>Code</Table.Th>
                        <Table.Th>Diagnoses</Table.Th>
                        <Table.Th ta="right">Amount</Table.Th>
                        <Table.Th>Payer</Table.Th>
                        <Table.Th>Flags</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.rows.map((row) => {
                        const id = chargeId(row.charge);
                        return (
                          <ChargeTableRow
                            key={id}
                            row={row}
                            payers={data.payers}
                            tab={tab}
                            selectable={isReviewTab && readyIds.includes(id)}
                            selected={picked.includes(id)}
                            onToggle={(on) => togglePick(id, on)}
                            onOpen={() => setOpenId(id)}
                          />
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Card>
            </Stack>
          )}
        </Section>
      </Stack>

      {openRow && <ChargeDrawer key={`${chargeId(openRow.charge)}:${openRow.charge.meta?.versionId}`} row={openRow} payers={payers} onClose={() => setOpenId(undefined)} onChanged={() => queue.reload()} />}
    </PageBody>
  );
}

function ChargeTableRow({
  row,
  payers,
  tab,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  readonly row: ChargeRow;
  readonly payers: readonly PayerConfig[];
  readonly tab: ChargeTab;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onToggle: (on: boolean) => void;
  readonly onOpen: () => void;
}): JSX.Element {
  const { charge } = row;
  const cents = chargeItemCents(charge);
  const line = chargeLineOf(charge);
  const dx = diagnosesOf(charge);
  const ai = aiUnaccepted(charge);
  const payerId = payerOf(charge);
  const payer = payerName(payerId, payers);
  const name = rowPatientName(row);
  const ready = tab === 'planned' && releaseProblems(charge, payers).length === 0;

  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer' }}>
      {tab === 'planned' && (
        <Table.Td onClick={(e) => e.stopPropagation()}>
          <Checkbox aria-label={`Select ${name} ${codeOf(charge) ?? ''} for release`} checked={selected} disabled={!selectable} onChange={(e) => onToggle(e.currentTarget.checked)} />
        </Table.Td>
      )}
      <Table.Td className="tm-num">
        <Text size="sm">{formatDate(charge.occurrenceDateTime?.slice(0, 10))}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={600}>
          {name}
        </Text>
        {tab !== 'planned' && holdReasonOf(charge) && (
          <Text size="xs" c="dimmed" lineClamp={1}>
            {holdReasonOf(charge)}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.provider ?? '—'}</Text>
      </Table.Td>
      <Table.Td className="tm-num">
        <Text size="sm">
          {codeOf(charge) ?? '—'}
          {line && line.modifiers.length > 0 ? `-${line.modifiers.join('-')}` : ''}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" className="tm-num">
          {dx.map((d) => `${d.letter} ${d.code}`).join(', ') || 'None'}
        </Text>
      </Table.Td>
      <Table.Td ta="right" className="tm-num">
        <Text size="sm" fw={600}>
          {cents === undefined ? '—' : formatCents(cents)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c={payer.known ? undefined : 'orange'}>
          {payer.text}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="wrap">
          {ai && (
            <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
              AI code not accepted
            </Badge>
          )}
          {!payerId && tab === 'planned' && (
            <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
              No payer
            </Badge>
          )}
          {payerId && !payer.known && (
            <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
              Payer not active
            </Badge>
          )}
          {ready && (
            <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
              Ready
            </Badge>
          )}
        </Group>
      </Table.Td>
      <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="default" onClick={onOpen} aria-label={`Review ${name} ${codeOf(charge) ?? 'charge'}`}>
          Review
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}
