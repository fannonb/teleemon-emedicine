import { Alert, Badge, Button, Drawer, Group, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import type { BillingSettings, PayerAdjustmentReason, PayerConfig } from '@teleemon/core';
import { claimStatusOf, formatCents, parseDollars, readSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { CloseReasonModal } from '../inbox/TaskDrawer';
import { useRoles } from '../session/roles';
import { formatDate } from '../utils/format';
import { WriteOffDialog } from './AccountDialogs';
import { errorMessage, idOf } from './billingShared';
import { ClaimStatusBadge, ConfirmStep, DeadlineBadge, ModalShell } from './billingUi';
import { claimTotalCents, payerOfClaim, visitOf } from './claimWork';
import { payerName } from './charges';
import { CATEGORY_LABEL, appealLetterDraft, closeDenial, markDenialDone, patientOwed, startAppeal, storedAppealLetter, transferToPatient, writeDownPayer } from './denials';
import type { DenialRow } from './denials';
import type { VisitBalance } from './ledgerApi';
import { ledgerApi, newRequestKey } from './ledgerApi';

// One denial: the facts, the saved appeal letter and the next steps. Each step is its own
// confirmation; the server refuses what the rules do not allow, and its message is shown as it is.
// What the payer still owes on the visit comes from the ledger, and caps the transfer and write-down.

const REASON_LABEL: Record<PayerAdjustmentReason, string> = {
  contractual: 'Contractual adjustment',
  'denial-final': 'Final denial',
  'small-balance': 'Small balance',
  'timely-filing': 'Timely filing',
};

export function DenialDrawer({ row, payers, onClose, onChanged }: { readonly row: DenialRow; readonly payers: readonly PayerConfig[]; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const isAdmin = roles.includes('admin');
  const { claim, task } = row;
  const claimId = claim?.id ?? '';
  const status = claim ? claimStatusOf(claim) : undefined;
  const name = patientName(row.patient);
  const payer = payerName(claim ? payerOfClaim(claim) : undefined, payers).text;
  const patientId = row.patient?.id;
  const settings = useLoader<BillingSettings>(() => readSettings(medplum, 'billing'), [medplum]);
  const letter = useLoader(() => (claimId ? storedAppealLetter(medplum, claimId) : Promise.resolve(undefined)), [medplum, claimId]);
  const owed = useLoader<number | undefined>(() => (patientId ? patientOwed(medplum, patientId) : Promise.resolve(undefined)), [medplum, patientId]);
  const visitId = idOf(claim ? visitOf(claim) : undefined);
  const visit = useLoader<VisitBalance | undefined>(() => (visitId ? ledgerApi.visit(medplum, visitId) : Promise.resolve(undefined)), [medplum, visitId]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [appealOpen, setAppealOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [writeDownOpen, setWriteDownOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  // Runs one step, shows the server's words on failure, and refreshes the list on success.
  const step = async (action: () => Promise<unknown>, message: string, after?: () => void): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      notifications.show({ color: 'brand', message });
      onChanged();
      after?.();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canAppeal = status === 'denied' && !letter.data;
  const canTransfer = (status === 'denied' || status === 'appealed') && !!claim;
  const canMarkDone = status === 'paid' || status === 'partially-paid' || status === 'closed';
  const canCloseClaim = status === 'denied' || status === 'appealed';
  const patientOwes = owed.data ?? 0;
  const payerOwes = visit.data?.payerOwesCents ?? 0;
  const payerOwesText = !visitId ? 'No visit on this claim' : visit.error ? 'Not available' : visit.data ? formatCents(visit.data.payerOwesCents) : 'Reading…';

  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={<Text fw={650}>{`Denial · ${name}`}</Text>}>
      <Stack gap="md">
        <Group gap="xs" wrap="wrap">
          <DeadlineBadge days={row.days} date={row.deadline} />
          {status && <ClaimStatusBadge status={status} />}
          <Badge variant="light" color={task.status === 'in-progress' ? 'indigo' : 'gray'}>
            {task.status === 'in-progress' ? 'Appeal in progress' : 'Open'}
          </Badge>
        </Group>

        {row.days !== undefined && row.days < 0 && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Appeal deadline passed">
            Appeal only if the payer allows late appeals.
          </Alert>
        )}

        <Stack gap={4}>
          <Text size="sm">
            <b>Claim</b> <span className="tm-num">{claimId.slice(0, 8) || '—'}</span> · {payer}
          </Text>
          <Text size="sm">
            <b>Date of service</b> {formatDate(claim?.billablePeriod?.start)} · <b>Billed</b> {claim ? formatCents(claimTotalCents(claim)) : '—'}
          </Text>
          <Text size="sm" aria-live="polite">
            <b>Payer owes on this visit</b> <span className="tm-num">{payerOwesText}</span>
          </Text>
          {visit.error && (
            <Text size="xs" c="orange">
              The visit balance could not be read: {visit.error.message}
            </Text>
          )}
          <Text size="sm">
            <b>Denied on</b> {formatDate(task.authoredOn?.slice(0, 10))}
          </Text>
          <Text size="sm">
            <b>Category</b> {CATEGORY_LABEL[row.category]}
          </Text>
          <Group gap={6} wrap="wrap" aria-label="Reason codes">
            <Text size="sm" fw={600}>
              Reason codes
            </Text>
            {row.carc.length === 0 ? (
              <Text size="sm" c="dimmed">
                None given
              </Text>
            ) : (
              row.carc.map((c) => (
                <Badge key={c} variant="outline" color="gray" className="tm-num">
                  {c}
                </Badge>
              ))
            )}
          </Group>
        </Stack>

        <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="Recommended next step">
          {row.action}
        </Alert>

        {letter.data && (
          <Textarea label="Appeal letter on file" value={letter.data} readOnly autosize minRows={6} maxRows={14} description="Saved on the patient's documents under billing." />
        )}
        {letter.error && (
          <Alert color="orange" variant="light" title="Letter not loaded">
            {letter.error.message}
          </Alert>
        )}

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not saved">
            {error}
          </Alert>
        )}

        <Stack gap="sm">
          <Text fw={650} size="sm">
            Next steps
          </Text>
          <Group gap="xs" wrap="wrap">
            {canAppeal && (
              <Button onClick={() => setAppealOpen(true)} disabled={busy}>
                Start appeal…
              </Button>
            )}
            {canTransfer && (
              <Button variant="default" onClick={() => setTransferOpen(true)} disabled={busy || payerOwes <= 0}>
                Transfer balance to patient…
              </Button>
            )}
            {canTransfer && (
              <Button variant="default" onClick={() => setWriteDownOpen(true)} disabled={busy || payerOwes <= 0}>
                Write down payer balance…
              </Button>
            )}
            {canMarkDone && (
              <Button variant="light" color="brand" leftSection={<IconCircleCheck size={16} />} disabled={busy} onClick={() => step(() => markDenialDone(medplum, row), 'Denial marked done.', onClose)}>
                Mark done
              </Button>
            )}
            <Button variant="subtle" color="red" disabled={busy} onClick={() => setCloseOpen(true)}>
              Close with reason…
            </Button>
          </Group>
          {canTransfer && (
            <Text size="xs" c="dimmed">
              A transfer moves what the payer still owes on this visit to the patient; a write-down removes it. The ledger refuses any amount above what the payer
              owes. Timely-filing write-downs need an administrator.
            </Text>
          )}
          {status === 'appealed' && (
            <Text size="xs" c="dimmed">
              The appeal is with the payer. Its answer arrives with a later remittance and moves the claim on.
            </Text>
          )}
          <Group gap="xs" wrap="wrap">
            <Button variant="default" onClick={() => setWriteOffOpen(true)} disabled={busy || !patientId || patientOwes <= 0 || !settings.data}>
              Write off patient balance…
            </Button>
            {owed.data !== undefined && patientOwes <= 0 && (
              <Text size="xs" c="dimmed">
                The patient owes nothing on their account, so there is no balance to write off here.
              </Text>
            )}
            {owed.error && (
              <Text size="xs" c="orange">
                The patient&apos;s balance could not be read: {owed.error.message}
              </Text>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            A write-off reduces the patient&apos;s balance only. It does not write off what the payer owes.
          </Text>
        </Stack>
      </Stack>

      {appealOpen && (
        <AppealDialog
          row={row}
          patientName={name}
          payerName={payer}
          onClose={() => setAppealOpen(false)}
          onRun={(letterText) => step(() => startAppeal(medplum, row, letterText), 'Appeal started. The letter is on the patient’s documents.', () => setAppealOpen(false))}
        />
      )}

      {transferOpen && claim && (
        <TransferDialog
          row={row}
          busy={busy}
          serverError={error}
          payerOwesCents={payerOwes}
          onClose={() => setTransferOpen(false)}
          onRun={(cents, memo, key) => step(() => transferToPatient(medplum, row, cents, memo, key), `Moved ${formatCents(cents)} to the patient.`, () => setTransferOpen(false))}
        />
      )}

      {writeDownOpen && claim && visit.data && (
        <PayerWriteDownDialog
          payerName={payer}
          payerOwesCents={visit.data.payerOwesCents}
          isAdmin={isAdmin}
          busy={busy}
          serverError={error}
          onClose={() => setWriteDownOpen(false)}
          onRun={(cents, reason, key) =>
            step(() => writeDownPayer(medplum, row, cents, reason, key), `Payer balance written down by ${formatCents(cents)}.`, () => {
              setWriteDownOpen(false);
              visit.reload();
            })
          }
        />
      )}

      {writeOffOpen && patientId && settings.data && (
        <WriteOffDialog
          patientId={patientId}
          patientName={name}
          owedCents={patientOwes}
          policy={settings.data.policy}
          isAdmin={isAdmin}
          onClose={() => setWriteOffOpen(false)}
          onDone={(message) => {
            setWriteOffOpen(false);
            notifications.show({ color: 'brand', message });
            onChanged();
          }}
        />
      )}

      {closeOpen && (
        <CloseReasonModal
          opened
          title="Close denial with a reason"
          label="Why is this denial closed?"
          onClose={() => setCloseOpen(false)}
          onConfirm={(reason) => {
            setCloseOpen(false);
            void step(() => closeDenial(medplum, row, reason, canCloseClaim), canCloseClaim ? 'Denial and claim closed with the reason.' : 'Denial closed with the reason.', onClose);
          }}
        />
      )}
    </Drawer>
  );
}

/** The appeal letter, drafted from the claim and then confirmed. */
function AppealDialog({
  row,
  patientName: name,
  payerName: payer,
  onClose,
  onRun,
}: {
  readonly row: DenialRow;
  readonly patientName: string;
  readonly payerName: string;
  readonly onClose: () => void;
  readonly onRun: (letter: string) => Promise<boolean>;
}): JSX.Element {
  const [letter, setLetter] = useState(() => appealLetterDraft(row, name, payer));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const bracketsLeft = letter.includes('[');
  return (
    <ModalShell title="Start an appeal" onClose={onClose} busy={busy} size="lg">
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Review the letter and complete the bracketed parts before it goes to the payer. The letter is saved on the patient&apos;s documents under billing.
          </Text>
          {row.days !== undefined && row.days < 0 && (
            <Alert color="red" variant="light" title="Deadline passed">
              The appeal deadline has passed. Send it only if the payer allows late appeals.
            </Alert>
          )}
          <Textarea label="Appeal letter" value={letter} onChange={(e) => setLetter(e.currentTarget.value)} autosize minRows={12} maxRows={24} />
          {bracketsLeft && (
            <Text size="xs" c="orange">
              Brackets are still in the letter.
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={letter.trim().length < 40}>
              Review appeal
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          color="indigo"
          onBack={() => setConfirming(false)}
          onConfirm={async () => {
            setBusy(true);
            const ok = await onRun(letter);
            setBusy(false);
            if (!ok) setConfirming(false);
          }}
          confirmLabel="Start appeal"
          summary={
            <Text size="sm">
              Start the appeal for {name}&apos;s claim with {payer}. The claim moves to appealed, the task to in progress, and the letter is saved on the patient&apos;s documents.
            </Text>
          }
        />
      )}
    </ModalShell>
  );
}

/** A payer write-down for one visit: the reason, the amount (never more than the payer owes), then a confirmation. */
function PayerWriteDownDialog({
  payerName: payer,
  payerOwesCents,
  isAdmin,
  busy,
  serverError,
  onClose,
  onRun,
}: {
  readonly payerName: string;
  readonly payerOwesCents: number;
  readonly isAdmin: boolean;
  readonly busy: boolean;
  readonly serverError?: string;
  readonly onClose: () => void;
  readonly onRun: (cents: number, reason: PayerAdjustmentReason, key: string) => Promise<boolean>;
}): JSX.Element {
  const [key] = useState(newRequestKey);
  const [reason, setReason] = useState<PayerAdjustmentReason>('denial-final');
  const [amountText, setAmountText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const cents = parseDollars(amountText);
  const needsAdmin = reason === 'timely-filing' && !isAdmin;
  const amountError =
    amountText.trim() === ''
      ? undefined
      : cents === undefined
        ? 'Use dollars and cents.'
        : cents <= 0
          ? 'The amount must be more than $0.00.'
          : cents > payerOwesCents
            ? `The payer owes ${formatCents(payerOwesCents)} on this visit.`
            : undefined;
  const valid = !needsAdmin && cents !== undefined && cents > 0 && cents <= payerOwesCents;

  return (
    <ModalShell title="Write down the payer balance" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Writes off part of what {payer} still owes on this visit. Use it only when the payer will not pay that amount. The patient&apos;s balance does not change.
          </Text>
          <Select
            label="Reason"
            value={reason}
            onChange={(v) => v && setReason(v as PayerAdjustmentReason)}
            allowDeselect={false}
            data={(Object.keys(REASON_LABEL) as PayerAdjustmentReason[]).map((r) => ({
              value: r,
              label: r === 'timely-filing' && !isAdmin ? `${REASON_LABEL[r]} (administrator only)` : REASON_LABEL[r],
              disabled: r === 'timely-filing' && !isAdmin,
            }))}
          />
          <TextInput
            label="Amount to write down"
            leftSection="$"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.currentTarget.value)}
            error={amountError}
            description={`The payer owes ${formatCents(payerOwesCents)} on this visit.`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          {needsAdmin && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
              Only a practice administrator can write down a timely-filing balance. Ask one to post it.
            </Alert>
          )}
          {serverError && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not written down">
              {serverError}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review write-down
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={serverError}
          color="orange"
          onBack={() => setConfirming(false)}
          onConfirm={async () => {
            if (cents === undefined) return;
            const ok = await onRun(cents, reason, key);
            if (!ok) setConfirming(false);
          }}
          confirmLabel={`Write down ${cents === undefined ? '' : formatCents(cents)}`}
          summary={
            <Text size="sm">
              Write down <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> of what {payer} owes on this visit, as {REASON_LABEL[reason].toLowerCase()}. The
              payer&apos;s balance goes down by that amount; the patient&apos;s does not change.
            </Text>
          }
        />
      )}
    </ModalShell>
  );
}

/** The amount moved to the patient, then confirmed. The ledger has the final word on the amount. */
function TransferDialog({
  row,
  busy,
  serverError,
  payerOwesCents,
  onClose,
  onRun,
}: {
  readonly row: DenialRow;
  readonly busy: boolean;
  readonly serverError?: string;
  readonly payerOwesCents: number;
  readonly onClose: () => void;
  readonly onRun: (cents: number, memo: string, key: string) => Promise<boolean>;
}): JSX.Element {
  const [key] = useState(newRequestKey);
  const [amountText, setAmountText] = useState('');
  const [memo, setMemo] = useState(`Denied balance moved to patient after payer review (claim ${row.claim?.id?.slice(0, 8) ?? ''})`);
  const [confirming, setConfirming] = useState(false);
  const cents = parseDollars(amountText);
  const amountError =
    amountText.trim() === ''
      ? undefined
      : cents === undefined
        ? 'Use dollars and cents.'
        : cents <= 0
          ? 'The amount must be more than $0.00.'
          : cents > payerOwesCents
            ? `The payer owes ${formatCents(payerOwesCents)} on this visit.`
            : undefined;
  const valid = cents !== undefined && cents > 0 && cents <= payerOwesCents && memo.trim().length > 0;
  return (
    <ModalShell title="Transfer balance to patient" onClose={onClose} busy={busy}>
      {!confirming ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Moves the amount the payer still owes on this visit onto the patient&apos;s account. Do this only once the payer has decided that amount is the patient&apos;s.
          </Text>
          <TextInput
            label="Amount"
            leftSection="$"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.currentTarget.value)}
            error={amountError}
            description={`The payer owes ${formatCents(payerOwesCents)} on this visit.`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
            required
          />
          <TextInput label="Note on the account" value={memo} onChange={(e) => setMemo(e.currentTarget.value)} maxLength={500} required />
          {serverError && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not moved">
              {serverError}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review transfer
            </Button>
          </Group>
        </Stack>
      ) : (
        <ConfirmStep
          busy={busy}
          error={serverError}
          color="orange"
          onBack={() => setConfirming(false)}
          onConfirm={async () => {
            if (cents === undefined) return;
            const ok = await onRun(cents, memo.trim(), key);
            if (!ok) setConfirming(false);
          }}
          confirmLabel={`Move ${cents === undefined ? '' : formatCents(cents)} to patient`}
          summary={
            <Text size="sm">
              Move <b className="tm-num">{cents === undefined ? '' : formatCents(cents)}</b> from the payer&apos;s balance on this visit to the patient&apos;s account. The ledger refuses it if the payer owes less.
            </Text>
          }
        />
      )}
    </ModalShell>
  );
}
