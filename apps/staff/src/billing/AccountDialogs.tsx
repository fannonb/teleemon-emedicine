import { Alert, Button, Group, Modal, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { BillingPolicy, WriteOffReason } from '@teleemon/core';
import { formatCents, parseDollars } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { formatDate } from '../utils/format';
import type { LedgerEntry, PaymentMethod, RefundMethod } from './ledgerApi';
import { LedgerApiError, ledgerApi, newRequestKey } from './ledgerApi';

// The posting dialogs on the account tab (P19). Each one has two steps: the details, then a
// confirmation that repeats the exact amount. Every posting carries a request key made when the
// dialog opened, so a double click replays the same posting instead of making a second one.

export interface PendingRefund {
  readonly refundId: string;
  readonly cents: number;
  readonly approvedAt: string;
}

const JOURNAL_KIND: Record<LedgerEntry['kind'], string> = {
  charge: 'Charge',
  payment: 'Payment',
  adjustment: 'Write-off or adjustment',
  refund: 'Refund',
  transfer: 'Transfer',
  reversal: 'Reversal',
};

const SOURCE: [RegExp | string, string][] = [
  ['front-desk', 'Front desk'],
  ['portal', 'Patient portal'],
  ['billing', 'Billing'],
  ['charge-review', 'Charge review'],
  ['card-processor', 'Card processor'],
  [/^era:/, 'Insurance payment'],
];

export const kindLabel = (kind: LedgerEntry['kind']): string => JOURNAL_KIND[kind];

/** The memo when there is one (it says what happened); otherwise where the entry came from. */
export function describeEntry(e: LedgerEntry): string {
  if (e.memo) return e.memo;
  const hit = SOURCE.find(([k]) => (typeof k === 'string' ? k === e.source : k.test(e.source)));
  return hit ? hit[1] : e.source;
}

const WRITE_OFF_LABEL: Record<WriteOffReason, string> = {
  'small-balance': 'Small balance',
  courtesy: 'Courtesy',
  'bad-debt': 'Bad debt',
  'timely-filing': 'Timely filing',
};

export interface DialogProps {
  readonly patientId: string;
  readonly patientName: string;
  /** Called after a successful posting, so the account reloads and the dialog closes. */
  readonly onDone: (message: string) => void;
  readonly onClose: () => void;
}

const messageOf = (err: unknown): string => (err instanceof LedgerApiError ? err.message : normalizeErrorString(err));

/** Whole-cent amount from the field, or the reason it cannot be used. */
function moneyProblem(text: string, cents: number | undefined, max?: number, maxLabel?: string): string | undefined {
  if (text.trim() === '') return 'Enter the amount in dollars.';
  if (cents === undefined) return 'Use dollars and cents, such as 45.00.';
  if (cents <= 0) return 'The amount must be more than $0.00.';
  if (max !== undefined && cents > max) return maxLabel ?? `The amount cannot be more than ${formatCents(max)}.`;
  return undefined;
}

function Shell({
  title,
  onClose,
  busy,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Modal opened onClose={busy ? () => undefined : onClose} title={<Text fw={650}>{title}</Text>} centered size="md" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      {children}
    </Modal>
  );
}

export function ConfirmStep({
  summary,
  confirmLabel,
  color,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  readonly summary: ReactNode;
  readonly confirmLabel: string;
  readonly color?: string;
  readonly busy: boolean;
  readonly error?: string;
  readonly onBack: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  return (
    <Stack gap="md">
      <Alert color={color ?? 'brand'} variant="light" title="Check before posting">
        {summary}
      </Alert>
      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not recorded">
          {error}
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button color={color} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </Group>
    </Stack>
  );
}

export function PaymentDialog({ patientId, patientName, owedCents, onDone, onClose }: DialogProps & { readonly owedCents: number }): JSX.Element {
  const medplum = useMedplum();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [receipt, setReceipt] = useState('');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cents = parseDollars(amount);
  const amountError = amount.trim() === '' ? undefined : moneyProblem(amount, cents);
  const receiptOk = /^[A-Za-z0-9-]{3,40}$/.test(receipt.trim());
  const valid = receiptOk && cents !== undefined && cents > 0;
  const over = cents !== undefined && cents > owedCents && owedCents >= 0;

  // The receipt number is the payment's idempotency key on the server, so no request key is needed here.
  const submit = async (): Promise<void> => {
    if (cents === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.recordPayment(medplum, patientId, { method, receipt: receipt.trim(), cents });
      onDone(`Payment of ${formatCents(cents)} recorded.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Record a payment" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Cash or check received from {patientName}. Card payments come through the patient portal or card processor and are not entered here.
          </Text>
          <SegmentedControl value={method} onChange={(v) => setMethod(v as PaymentMethod)} data={[{ value: 'cash', label: 'Cash' }, { value: 'check', label: 'Check' }]} />
          <TextInput
            label={method === 'check' ? 'Check number' : 'Receipt number'}
            description="3 to 40 letters, numbers or dashes. Posting the same number twice does nothing."
            value={receipt}
            onChange={(e) => setReceipt(e.currentTarget.value)}
            error={receipt.trim() !== '' && !receiptOk ? 'Use 3 to 40 letters, numbers or dashes.' : undefined}
            required
          />
          <TextInput
            label="Amount received"
            leftSection="$"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            error={amountError}
            description={`Owed now: ${formatCents(owedCents)}.${over ? ' The part above the balance is kept as credit.' : ''}`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review payment
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel={`Record ${cents === undefined ? '' : formatCents(cents)}`}
          summary={
            <Text size="sm">
              Record <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> received by {method} (number {receipt.trim()}) from {patientName}.
            </Text>
          }
        />
      )}
    </Shell>
  );
}

export function WriteOffDialog({ patientId, patientName, owedCents, policy, isAdmin, onDone, onClose }: DialogProps & { readonly owedCents: number; readonly policy: BillingPolicy; readonly isAdmin: boolean }): JSX.Element {
  const medplum = useMedplum();
  const [requestKey] = useState(newRequestKey);
  const [reason, setReason] = useState<WriteOffReason>('small-balance');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cents = parseDollars(amount);
  const cap = reason === 'small-balance' ? Math.min(policy.smallBalanceWriteOffCents, owedCents) : owedCents;
  const capLabel =
    reason === 'small-balance'
      ? `Small-balance write-offs are limited to ${formatCents(policy.smallBalanceWriteOffCents)} under the billing policy.`
      : `The amount cannot be more than the ${formatCents(owedCents)} owed.`;
  const amountError = amount.trim() === '' ? undefined : moneyProblem(amount, cents, cap, capLabel);
  const needsAdmin = reason !== 'small-balance' && !isAdmin;
  const valid = !needsAdmin && cents !== undefined && cents > 0 && cents <= cap;

  const submit = async (): Promise<void> => {
    if (cents === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.writeOff(medplum, patientId, { key: requestKey, reason, cents });
      onDone(`Written off ${formatCents(cents)}.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Write off a balance" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Takes money off what {patientName} owes. Each write-off needs an approver; yours is recorded with it.
          </Text>
          <Select
            label="Reason"
            value={reason}
            onChange={(v) => v && setReason(v as WriteOffReason)}
            allowDeselect={false}
            data={(Object.keys(WRITE_OFF_LABEL) as WriteOffReason[]).map((r) => ({
              value: r,
              label: r === 'small-balance' || isAdmin ? WRITE_OFF_LABEL[r] : `${WRITE_OFF_LABEL[r]} (administrator only)`,
              disabled: r !== 'small-balance' && !isAdmin,
            }))}
          />
          <TextInput
            label="Amount to write off"
            leftSection="$"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            error={amountError}
            description={`Owed now: ${formatCents(owedCents)}. ${reason === 'small-balance' ? `Small balances up to ${formatCents(policy.smallBalanceWriteOffCents)}.` : ''}`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          {needsAdmin && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
              Only a practice administrator can write off this kind of balance. Ask one to post it.
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review write-off
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          color="orange"
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel={`Write off ${cents === undefined ? '' : formatCents(cents)}`}
          summary={
            <Text size="sm">
              Write off <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> of {patientName}&apos;s balance as {WRITE_OFF_LABEL[reason].toLowerCase()}. This cannot be undone except by a reversal.
            </Text>
          }
        />
      )}
    </Shell>
  );
}

export function ApplyCreditDialog({ patientId, patientName, creditCents, owedCents, onDone, onClose }: DialogProps & { readonly creditCents: number; readonly owedCents: number }): JSX.Element {
  const medplum = useMedplum();
  const [requestKey] = useState(newRequestKey);
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cap = Math.min(creditCents, owedCents);
  const cents = parseDollars(amount);
  const amountError = amount.trim() === '' ? undefined : moneyProblem(amount, cents, cap, `Only ${formatCents(cap)} can be applied: the lower of the credit held and the amount owed.`);
  const valid = cents !== undefined && cents > 0 && cents <= cap;

  const submit = async (): Promise<void> => {
    if (cents === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.applyCredit(medplum, patientId, { key: requestKey, cents });
      onDone(`Applied ${formatCents(cents)} of credit.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Apply credit to the balance" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Uses money {patientName} has already paid, against what they still owe.
          </Text>
          <Text size="sm">
            Credit held: <b className="tm-num">{formatCents(creditCents)}</b> · Owed: <b className="tm-num">{formatCents(owedCents)}</b>
          </Text>
          <TextInput
            label="Amount to apply"
            leftSection="$"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            error={amountError}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel={`Apply ${cents === undefined ? '' : formatCents(cents)}`}
          summary={
            <Text size="sm">
              Apply <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> of {patientName}&apos;s credit to what they owe.
            </Text>
          }
        />
      )}
    </Shell>
  );
}

export function ApproveRefundDialog({ patientId, patientName, creditCents, onDone, onClose }: DialogProps & { readonly creditCents: number }): JSX.Element {
  const medplum = useMedplum();
  // The refund id is generated once, so a repeated approval replays instead of approving twice.
  const [refundId] = useState(newRequestKey);
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cents = parseDollars(amount);
  const amountError = amount.trim() === '' ? undefined : moneyProblem(amount, cents, creditCents, `Only ${formatCents(creditCents)} of credit is held.`);
  const valid = cents !== undefined && cents > 0 && cents <= creditCents;

  const submit = async (): Promise<void> => {
    if (cents === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.approveRefund(medplum, patientId, { refundId, cents });
      onDone(`Refund of ${formatCents(cents)} approved. Mark it paid when it goes out.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Approve a refund" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Moves credit that {patientName} holds into refunds payable. It stays there until the refund is marked paid.
          </Text>
          <TextInput
            label="Refund amount"
            leftSection="$"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            error={amountError}
            description={`Credit held: ${formatCents(creditCents)}.`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review refund
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel={`Approve ${cents === undefined ? '' : formatCents(cents)}`}
          summary={
            <Text size="sm">
              Approve a refund of <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> to {patientName}. Your name is recorded as approver.
            </Text>
          }
        />
      )}
    </Shell>
  );
}

export function RefundPaidDialog({ pending, patientName, onDone, onClose }: DialogProps & { readonly pending: PendingRefund[] }): JSX.Element {
  const medplum = useMedplum();
  const [refundId, setRefundId] = useState(pending[0]?.refundId ?? '');
  const [method, setMethod] = useState<RefundMethod>('check');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = pending.find((r) => r.refundId === refundId);

  const submit = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.markRefundPaid(medplum, chosen.refundId, { method });
      onDone(`Refund of ${formatCents(chosen.cents)} marked paid.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Mark a refund paid" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Records that a refund approved for {patientName} has gone out. Card refunds are sent through the card processor; this only records them.
          </Text>
          <Select
            label="Approved refund"
            value={refundId}
            onChange={(v) => v && setRefundId(v)}
            allowDeselect={false}
            data={pending.map((r) => ({ value: r.refundId, label: `${formatDate(r.approvedAt.slice(0, 10))} · ${formatCents(r.cents)}` }))}
          />
          <SegmentedControl value={method} onChange={(v) => setMethod(v as RefundMethod)} data={[{ value: 'check', label: 'Check' }, { value: 'card', label: 'Card' }]} />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!chosen} onClick={() => setConfirming(true)}>
              Review
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel={`Mark ${chosen ? formatCents(chosen.cents) : ''} paid`}
          summary={
            <Text size="sm">
              Mark the refund of <b className="tm-num">{chosen ? formatCents(chosen.cents) : ''}</b> to {patientName} as paid by {method}.
            </Text>
          }
        />
      )}
    </Shell>
  );
}

export function ReverseDialog({ entry, patientName, onDone, onClose }: Omit<DialogProps, 'patientId'> & { readonly entry: LedgerEntry }): JSX.Element {
  const medplum = useMedplum();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const valid = reason.trim().length >= 3;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await ledgerApi.reverse(medplum, { key: entry.idempotencyKey, reason: reason.trim() });
      onDone(`${kindLabel(entry.kind)} reversed.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const what = `${kindLabel(entry.kind)} of ${formatDate(entry.occurredAt.slice(0, 10))}, ${describeEntry(entry)}`;
  return (
    <Shell title="Reverse an entry" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm">
            {what}: <b className="tm-num">{formatCents(entry.cents)}</b> on {patientName}&apos;s account.
          </Text>
          <Text size="sm" c="dimmed">
            A reversal posts the exact opposite of every line in the original entry, including lines on other accounts. The original stays on record.
          </Text>
          <TextInput label="Reason" description="At least 3 characters. Recorded with the reversal." value={reason} onChange={(e) => setReason(e.currentTarget.value)} required />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button color="red" disabled={!valid} onClick={() => setConfirming(true)}>
              Review reversal
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={error}
          color="red"
          onBack={() => setConfirming(false)}
          onConfirm={submit}
          confirmLabel="Reverse this entry"
          summary={
            <Text size="sm">
              Reverse {what}, which is <b className="tm-num">{formatCents(entry.cents)}</b> on this account. Reason: {reason.trim()}.
            </Text>
          }
        />
      )}
    </Shell>
  );
}
