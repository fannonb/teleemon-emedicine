import { Badge, Button, Card, Grid, Group, SimpleGrid, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MedplumClient } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconArrowBackUp, IconCash, IconCircleCheck, IconCoin, IconFileInvoice, IconReceiptRefund, IconScale, IconWallet } from '@tabler/icons-react';
import type { BillingPolicy } from '@teleemon/core';
import { AGING_BUCKETS, PRACTICE_TIME_ZONE, agingReport, formatCents, readSettings } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { CardHeader } from '../../components/CardHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { ApplyCreditDialog, ApproveRefundDialog, PaymentDialog, RefundPaidDialog, ReverseDialog, WriteOffDialog, describeEntry, kindLabel } from '../../billing/AccountDialogs';
import type { PendingRefund } from '../../billing/AccountDialogs';
import type { LedgerEntry, PatientAccount } from '../../billing/ledgerApi';
import { ledgerApi } from '../../billing/ledgerApi';
import { patientName } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

const BUCKET_LABEL: Record<(typeof AGING_BUCKETS)[number], string> = {
  '0-30': '0–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '91-120': '91–120 days',
  '120+': 'Over 120 days',
};

const ACCOUNT_LABEL: Record<LedgerEntry['account']['kind'], string> = {
  patient_receivable: 'Owed by patient',
  patient_credit: 'Credit held',
  insurance_receivable: 'Insurance',
  cash: 'Cash',
  card_clearing: 'Card clearing',
  revenue: 'Revenue',
  contractual_adjustment: 'Contractual',
  write_off: 'Write-off',
  refund_payable: 'Refund payable',
};

interface AccountData {
  readonly account: PatientAccount;
  /** Billing policy; only read for billers and administrators. */
  readonly policy?: BillingPolicy;
  readonly pending: PendingRefund[];
}

type Dialog = { readonly kind: 'payment' | 'writeOff' | 'credit' | 'approve' | 'refundPaid' } | { readonly kind: 'reverse'; readonly entry: LedgerEntry };

/**
 * Approved refunds that have no paid journal yet. Needs the biller's journal read, so front desk
 * never calls it. A 404 means the paid journal is absent and the refund is pending; any other
 * probe failure leaves it unconfirmed, and it is kept pending too, because re-marking a paid
 * refund is an idempotent no-op while hiding a real one would lose the patient their money.
 * Either way, one bad probe must not fail the whole account tab.
 */
async function pendingRefunds(medplum: MedplumClient, entries: LedgerEntry[]): Promise<PendingRefund[]> {
  const approved = entries.filter((e) => e.kind === 'refund' && !e.reversed && /^refund:[^:]+:approved$/.test(e.idempotencyKey));
  const asPending = (e: LedgerEntry): PendingRefund => ({ refundId: e.idempotencyKey.split(':')[1] ?? '', cents: e.cents, approvedAt: e.occurredAt });
  const checks = await Promise.allSettled(
    approved.map(async (e): Promise<PendingRefund | undefined> => {
      const refundId = e.idempotencyKey.split(':')[1] ?? '';
      await ledgerApi.journal(medplum, `refund:${refundId}:paid`);
      return undefined;
    })
  );
  return checks.flatMap((c, i) => (c.status === 'fulfilled' ? (c.value ? [c.value] : []) : [asPending(approved[i])]));
}

/** Today's date in the practice's time zone, as YYYY-MM-DD, for aging. */
const practiceToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: PRACTICE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// P19 Account & ledger: what the patient owes, what they have paid, and every posting on their account.
export function AccountTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const { roles } = useRoles();
  const isAdmin = roles.includes('admin');
  // Billing actions: billers and providers (practice decision, 18 Oct 2026).
  const isBiller = isAdmin || roles.includes('biller') || roles.includes('provider');
  const canTakePayment = isBiller || roles.includes('frontdesk');
  const [dialog, setDialog] = useState<Dialog>();
  const name = patientName(patient);

  const account = useLoader<AccountData>(
    async () => {
      const [acct, settings] = await Promise.all([ledgerApi.account(medplum, patient.id ?? ''), isBiller ? readSettings(medplum, 'billing') : undefined]);
      const pending = isBiller ? await pendingRefunds(medplum, acct.entries) : [];
      return { account: acct, policy: settings?.policy, pending };
    },
    [medplum, patient.id, isBiller]
  );

  const done = (message: string): void => {
    setDialog(undefined);
    notifications.show({ color: 'brand', message });
    account.reload();
  };

  if (account.loading && !account.data) return <RowsSkeleton rows={4} />;
  if (account.error || !account.data) {
    return <ErrorState error={account.error ?? new Error('The account did not load.')} onRetry={account.reload} />;
  }
  const { account: acct, policy, pending } = account.data;
  const aging = agingReport(acct.openItems, practiceToday());
  const openCount = acct.openItems.filter((i) => i.cents > 0).length;
  const entries = [...acct.entries].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.postedAt.localeCompare(a.postedAt));
  // One Reverse action per journal: its first line on this account carries it.
  const reverseOffered = new Set<string>();

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} fz={18}>
          Account &amp; ledger
        </Title>
        <Text size="sm" c="dimmed">
          Every charge, payment and adjustment for {name}. Each posting is kept on record; corrections are reversals, not edits.
        </Text>
      </div>

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="md" aria-live="polite">
        <BalanceCard icon={<IconFileInvoice size={18} />} color="navy" label="Owed" cents={acct.owedCents} note={openCount ? `${openCount} open ${openCount === 1 ? 'visit' : 'visits'}` : 'Nothing owed'} />
        <BalanceCard icon={<IconWallet size={18} />} color="brand" label="Credit held" cents={acct.creditCents} note="Can be applied to a balance or refunded." />
        <BalanceCard
          icon={<IconScale size={18} />}
          color={acct.netCents < 0 ? 'blue' : 'gray'}
          label="Net balance"
          cents={acct.netCents}
          note={acct.netCents < 0 ? 'Credit is more than the amount owed.' : 'Owed minus credit held.'}
        />
      </SimpleGrid>

      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card h="100%">
            <CardHeader title="Aging of open items" count={`${acct.openItems.length} ${acct.openItems.length === 1 ? 'item' : 'items'}`} />
            {acct.openItems.length === 0 ? (
              <EmptyState icon={<IconCircleCheck size={22} />} title="No open items">
                Visits with an unpaid balance are listed here by days since the visit.
              </EmptyState>
            ) : (
              <Table verticalSpacing="xs">
                <Table.Tbody>
                  {AGING_BUCKETS.map((b) => (
                    <Table.Tr key={b}>
                      <Table.Td>{BUCKET_LABEL[b]}</Table.Td>
                      <Table.Td ta="right" className="tm-num">
                        {formatCents(aging.byBucket[b])}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  <Table.Tr>
                    <Table.Td fw={650}>Total open</Table.Td>
                    <Table.Td ta="right" fw={650} className="tm-num">
                      {formatCents(aging.totalCents)}
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            )}
            <Text size="xs" c="dimmed" mt="sm">
              Days since the visit date. A negative amount is money received but not yet matched to a visit.
            </Text>
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Card h="100%">
            <CardHeader title="Actions" />
            <Stack gap="sm">
              {canTakePayment && (
                <ActionButton
                  icon={<IconCash size={16} />}
                  label="Record payment"
                  hint="Cash or check received. Card payments are taken by the portal or card processor, not here."
                  onClick={() => setDialog({ kind: 'payment' })}
                />
              )}
              {isBiller && policy && (
                <ActionButton
                  icon={<IconArrowBackUp size={16} />}
                  label="Write off…"
                  hint={acct.owedCents > 0 ? `Small balances up to ${formatCents(policy.smallBalanceWriteOffCents)}. Other reasons: administrator only.` : 'Nothing is owed.'}
                  disabled={acct.owedCents <= 0}
                  onClick={() => setDialog({ kind: 'writeOff' })}
                />
              )}
              {isBiller && (
                <ActionButton
                  icon={<IconCoin size={16} />}
                  label="Apply credit…"
                  hint={acct.creditCents > 0 && acct.owedCents > 0 ? 'Uses money already paid against what is owed.' : 'Needs both credit held and an amount owed.'}
                  disabled={acct.creditCents <= 0 || acct.owedCents <= 0}
                  onClick={() => setDialog({ kind: 'credit' })}
                />
              )}
              {isBiller && (
                <ActionButton
                  icon={<IconReceiptRefund size={16} />}
                  label="Approve refund…"
                  hint={acct.creditCents > 0 ? 'Moves credit held into refunds payable.' : 'No credit is held.'}
                  disabled={acct.creditCents <= 0}
                  onClick={() => setDialog({ kind: 'approve' })}
                />
              )}
              {isBiller && (
                <ActionButton
                  icon={<IconCircleCheck size={16} />}
                  label="Mark refund paid…"
                  hint={pending.length > 0 ? `${pending.length} approved ${pending.length === 1 ? 'refund is' : 'refunds are'} waiting to be paid.` : 'No approved refund is waiting to be paid.'}
                  disabled={pending.length === 0}
                  onClick={() => setDialog({ kind: 'refundPaid' })}
                />
              )}
              {!isBiller && !canTakePayment && <Text size="sm" c="dimmed">Your role can view this account only.</Text>}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <Card>
        <CardHeader title="Ledger entries" count={`${entries.length} ${entries.length === 1 ? 'line' : 'lines'}`} />
        {entries.length === 0 ? (
          <EmptyState icon={<IconFileInvoice size={22} />} title="No entries yet">
            Charges from signed visits, payments and adjustments appear here once they are posted to the ledger.
          </EmptyState>
        ) : (
          <Table.ScrollContainer minWidth={900}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Description</Table.Th>
                  <Table.Th>Account</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {entries.map((e, i) => {
                  const canReverse = isBiller && !e.reversed && e.kind !== 'reversal' && !reverseOffered.has(e.journalId);
                  if (canReverse) reverseOffered.add(e.journalId);
                  return (
                    <Table.Tr key={`${e.journalId}:${e.account.kind}:${i}`}>
                      <Table.Td className="tm-num">
                        <Text size="sm">{formatDate(e.occurredAt.slice(0, 10))}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{kindLabel(e.kind)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{describeEntry(e)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{ACCOUNT_LABEL[e.account.kind]}</Text>
                      </Table.Td>
                      <Table.Td ta="right" className="tm-num">
                        <Text size="sm" fw={600}>
                          {e.cents > 0 ? '+' : ''}
                          {formatCents(e.cents)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <EntryStatus entry={e} />
                      </Table.Td>
                      <Table.Td ta="right">
                        {canReverse && (
                          <Button size="xs" variant="subtle" color="red" onClick={() => setDialog({ kind: 'reverse', entry: e })} aria-label={`Reverse ${kindLabel(e.kind)} of ${formatDate(e.occurredAt.slice(0, 10))}`}>
                            Reverse…
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <Text size="xs" c="dimmed" mt="sm">
          Debits (+) increase what the patient owes or what the practice is due; credits (−) reduce them.
        </Text>
      </Card>

      {dialog?.kind === 'payment' && <PaymentDialog patientId={patient.id ?? ''} patientName={name} owedCents={acct.owedCents} onDone={done} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'writeOff' && policy && (
        <WriteOffDialog patientId={patient.id ?? ''} patientName={name} owedCents={acct.owedCents} policy={policy} isAdmin={isAdmin} onDone={done} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'credit' && <ApplyCreditDialog patientId={patient.id ?? ''} patientName={name} creditCents={acct.creditCents} owedCents={acct.owedCents} onDone={done} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'approve' && <ApproveRefundDialog patientId={patient.id ?? ''} patientName={name} creditCents={acct.creditCents} onDone={done} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'refundPaid' && <RefundPaidDialog patientId={patient.id ?? ''} patientName={name} pending={pending} onDone={done} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'reverse' && <ReverseDialog patientName={name} entry={dialog.entry} onDone={done} onClose={() => setDialog(undefined)} />}
    </Stack>
  );
}

function BalanceCard({ icon, color, label, cents, note }: { readonly icon: ReactNode; readonly color: string; readonly label: string; readonly cents: number; readonly note: string }): JSX.Element {
  return (
    <Card>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon variant="light" color={color} size={36} radius="md">
          {icon}
        </ThemeIcon>
        <div style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts="0.04em">
            {label}
          </Text>
          <Text fz={24} fw={700} lh={1.25} className="tm-num">
            {formatCents(cents)}
          </Text>
          <Text size="xs" c="dimmed">
            {note}
          </Text>
        </div>
      </Group>
    </Card>
  );
}

function ActionButton({ icon, label, hint, disabled, onClick }: { readonly icon: ReactNode; readonly label: string; readonly hint: string; readonly disabled?: boolean; readonly onClick: () => void }): JSX.Element {
  return (
    <div>
      <Button variant="light" fullWidth justify="flex-start" leftSection={icon} disabled={disabled} onClick={onClick}>
        {label}
      </Button>
      <Text size="xs" c="dimmed" mt={4}>
        {hint}
      </Text>
    </div>
  );
}

function EntryStatus({ entry }: { readonly entry: LedgerEntry }): JSX.Element {
  if (entry.reversed) {
    return (
      <Badge color="gray" variant="light" leftSection={<IconArrowBackUp size={12} />}>
        Reversed
      </Badge>
    );
  }
  if (entry.kind === 'reversal') {
    return (
      <Badge color="blue" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Reverses an earlier entry
      </Badge>
    );
  }
  return (
    <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
      Posted
    </Badge>
  );
}
