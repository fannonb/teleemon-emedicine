import { Alert, Badge, Button, Drawer, Group, List, MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { ChargeItem } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconPlayerPause } from '@tabler/icons-react';
import type { PayerConfig } from '@teleemon/core';
import { MIN_REASON, chargeLineOf, formatCents, parseDollars, suggestPayer } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { formatDate } from '../utils/format';
import type { ChargeRow } from './charges';
import {
  MODIFIER_OPTIONS,
  SELF_PAY,
  aiUnaccepted,
  codeOf,
  coverageWithPayer,
  diagnosesOf,
  editedCharge,
  holdReasonOf,
  isPosted,
  linkedPayerOf,
  payerName,
  payerOf,
  planNameOf,
  releaseProblems,
  rowPatientName,
  saveCharge,
  withStatus,
} from './charges';

const STATUS: Record<ChargeItem['status'], { label: string; color: string; icon: JSX.Element }> = {
  planned: { label: 'To review', color: 'blue', icon: <IconInfoCircle size={12} /> },
  billable: { label: 'Billable', color: 'green', icon: <IconCircleCheck size={12} /> },
  billed: { label: 'Billed', color: 'green', icon: <IconCircleCheck size={12} /> },
  'not-billable': { label: 'Not billable', color: 'orange', icon: <IconPlayerPause size={12} /> },
  'entered-in-error': { label: 'Entered in error', color: 'red', icon: <IconCircleX size={12} /> },
  aborted: { label: 'Aborted', color: 'gray', icon: <IconCircleX size={12} /> },
  unknown: { label: 'Unknown', color: 'gray', icon: <IconInfoCircle size={12} /> },
};

/** Status as text and an icon, never colour alone. */
export function ChargeStatusBadge({ status }: { readonly status: ChargeItem['status'] }): JSX.Element {
  const s = STATUS[status];
  return (
    <Badge variant="light" color={s.color} leftSection={s.icon}>
      {s.label}
    </Badge>
  );
}

type Holding = 'hold' | 'error';

/**
 * Charge editor and release actions (P30). The form starts from the charge as read; the parent
 * re-mounts this drawer when the charge's version changes, so a saved edit shows the stored copy.
 */
export function ChargeDrawer({ row, payers, onClose, onChanged }: { readonly row: ChargeRow; readonly payers: readonly PayerConfig[]; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { charge, coverage } = row;
  const line = chargeLineOf(charge);
  const editable = charge.status === 'planned' && line !== undefined;
  const [modifiers, setModifiers] = useState<string[]>(() => [...(line?.modifiers ?? [])]);
  const [pointers, setPointers] = useState<string[]>(() => (line?.diagnosisPointers ?? []).map(String));
  const [amountText, setAmountText] = useState(() => ((line?.chargeCents ?? 0) / 100).toFixed(2));
  const [payer, setPayer] = useState<string | null>(() => payerOf(charge) ?? null);
  const [holding, setHolding] = useState<Holding | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const cents = parseDollars(amountText);
  const amountError = amountText.trim() === '' ? 'Enter the amount.' : cents === undefined ? 'Use dollars and cents, such as 110.00.' : cents <= 0 ? 'The amount must be more than $0.00.' : undefined;
  const preview = cents !== undefined ? editedCharge(charge, { modifiers, pointers: pointers.map(Number), cents, payer: payer ?? undefined }) : undefined;
  const problems = preview && editable ? releaseProblems(preview, payers) : [];
  const aiLine = aiUnaccepted(charge);
  const dx = diagnosesOf(charge);

  const payerOptions = [...payers.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name })), { value: SELF_PAY, label: 'Self-pay' }];
  if (payer && !payerOptions.some((o) => o.value === payer)) payerOptions.push({ value: payer, label: `${payerName(payer, payers).text} (not active)` });

  const planName = planNameOf(coverage);
  const suggested = suggestPayer(planName, payers);
  const linked = linkedPayerOf(coverage);
  const chosen = payers.find((p) => p.id === payer && p.active);
  const reasonOk = reason.trim().length >= MIN_REASON;

  // Save and release write the form as it stands (server checks it all again).
  const save = async (opts: { status?: ChargeItem['status']; message: string }): Promise<void> => {
    if (cents === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = editedCharge(charge, { modifiers, pointers: pointers.map(Number), cents, payer: payer ?? undefined, status: opts.status });
      await saveCharge(medplum, charge, next);
      notifications.show({ color: 'brand', message: opts.message });
      onChanged();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  // Hold, error and return-to-review change only the status and reason, so they work even when the charge line is unreadable.
  const moveTo = async (status: ChargeItem['status'], holdReason: string | null, message: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await saveCharge(medplum, charge, withStatus(charge, status, holdReason));
      notifications.show({ color: 'brand', message });
      onChanged();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  const linkPlan = async (): Promise<void> => {
    if (!coverage || !chosen) return;
    setBusy(true);
    setError(undefined);
    try {
      await medplum.updateResource(coverageWithPayer(coverage, chosen), { headers: { 'If-Match': `W/"${coverage.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: `Plan linked to ${chosen.name}. Future charges will default to it.` });
      onChanged();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  const showHolding = holding !== null && (charge.status === 'planned' || charge.status === 'not-billable');

  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={<Text fw={650}>{`${codeOf(charge) ?? 'Charge'} · ${rowPatientName(row)}`}</Text>}>
      <Stack gap="md">
        <Group gap="xs" wrap="wrap">
          <ChargeStatusBadge status={charge.status} />
          <Text size="sm" c="dimmed" className="tm-num">
            {formatDate(charge.occurrenceDateTime?.slice(0, 10))}
          </Text>
          <Text size="sm" c="dimmed">
            · {row.provider ?? 'Provider not recorded'}
          </Text>
        </Group>

        {charge.status === 'not-billable' && (
          <Alert color="orange" variant="light" icon={<IconPlayerPause size={18} />} title="Held, not billed">
            {holdReasonOf(charge) ?? 'No reason recorded.'}
          </Alert>
        )}
        {charge.status === 'entered-in-error' && (
          <Alert color="red" variant="light" icon={<IconCircleX size={18} />} title="Entered in error">
            {holdReasonOf(charge) ?? 'No reason recorded.'} It stays on record and cannot be changed.
          </Alert>
        )}
        {charge.status === 'billable' && (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="Released to billing">
            {isPosted(charge) ? 'Posted to the ledger. Corrections need a reversal and a new charge.' : 'Waiting for the ledger to post it.'}
          </Alert>
        )}
        {!line && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Charge line unreadable">
            This charge cannot be edited here. Mark it entered in error with a reason, and capture the visit again from the signed note.
          </Alert>
        )}
        {aiLine && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title={`AI suggested ${aiLine.code}; the provider has not accepted it`}>
            Only the provider who signed the note can accept an AI-suggested code. Hold this charge, or ask the provider to review the note.
          </Alert>
        )}

        <Stack gap="sm">
          <MultiSelect label="Modifiers" data={[...new Set([...MODIFIER_OPTIONS, ...modifiers])]} value={modifiers} onChange={setModifiers} disabled={!editable} searchable />
          <MultiSelect
            label="Diagnosis pointers (up to four)"
            description="Pointers refer to the diagnoses on the charge, in the order shown."
            data={dx.map((d, i) => ({ value: String(i + 1), label: `${d.letter} · ${d.code}${d.display ? ` ${d.display}` : ''}` }))}
            value={pointers}
            onChange={setPointers}
            maxValues={4}
            disabled={!editable}
          />
          <TextInput
            label="Amount"
            leftSection="$"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.currentTarget.value)}
            error={editable ? amountError : undefined}
            disabled={!editable}
            description={`Fee schedule amount for this code: ${formatCents(line?.chargeCents ?? 0)}`}
            styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
          />
          <Select label="Payer" data={payerOptions} value={payer} onChange={setPayer} allowDeselect={false} disabled={!editable} placeholder="Choose the payer" />
        </Stack>

        {editable && (
          <Alert color={suggested && suggested.id !== payer && !linked ? 'blue' : 'gray'} variant="light" icon={<IconInfoCircle size={18} />} title="Coverage on file">
            {coverage ? (
              <Stack gap={6}>
                <Text size="sm">
                  Plan: <b>{planName ?? 'Unnamed plan'}</b>
                  {linked ? ` · linked to ${payerName(linked, payers).text}` : ' · not linked to a configured payer yet'}
                </Text>
                {suggested && suggested.id !== payer && !linked && (
                  <Group gap="xs">
                    <Text size="sm">The plan name matches {suggested.name}.</Text>
                    <Button size="xs" variant="light" onClick={() => setPayer(suggested.id)} disabled={busy}>
                      Use {suggested.name}
                    </Button>
                  </Group>
                )}
                {chosen && linked !== chosen.id && (
                  <Group gap="xs">
                    <Button size="xs" variant="default" onClick={linkPlan} disabled={busy}>
                      Link this plan to {chosen.name}
                    </Button>
                    <Text size="xs" c="dimmed">Future charges for this patient will default to this payer.</Text>
                  </Group>
                )}
              </Stack>
            ) : (
              <Text size="sm">No active coverage is on file. Choose self-pay if the patient pays directly.</Text>
            )}
          </Alert>
        )}

        {editable &&
          (problems.length > 0 ? (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Not ready to release">
              <List size="sm" spacing={4}>
                {problems.map((p) => (
                  <List.Item key={p}>{p}</List.Item>
                ))}
              </List>
            </Alert>
          ) : (
            <Alert color="green" variant="light" icon={<IconCircleCheck size={18} />}>
              Ready to release. The server checks again when you release.
            </Alert>
          ))}

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not saved">
            {error}
          </Alert>
        )}

        {showHolding && (
          <Stack gap="xs">
            <TextInput
              label={holding === 'hold' ? 'Why is this charge not billed?' : 'Why was this charge entered in error?'}
              description={`At least ${MIN_REASON} characters. Recorded with the charge.`}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              autoFocus
            />
            <Group gap="xs">
              <Button
                color={holding === 'hold' ? 'orange' : 'red'}
                disabled={!reasonOk || busy}
                loading={busy}
                onClick={() =>
                  moveTo(
                    holding === 'hold' ? 'not-billable' : 'entered-in-error',
                    reason.trim(),
                    holding === 'hold' ? 'Charge held. It is not billed.' : 'Charge entered in error.'
                  )
                }
              >
                {holding === 'hold' ? 'Hold charge' : 'Enter in error'}
              </Button>
              <Button variant="default" onClick={() => setHolding(null)} disabled={busy}>
                Cancel
              </Button>
            </Group>
          </Stack>
        )}

        <Group gap="xs" wrap="wrap">
          {editable && (
            <>
              <Button
                leftSection={<IconCircleCheck size={16} />}
                disabled={cents === undefined || busy || problems.length > 0}
                loading={busy}
                onClick={() => save({ status: 'billable', message: 'Charge released to billing.' })}
              >
                Release to billing
              </Button>
              <Button variant="default" disabled={cents === undefined || busy} onClick={() => save({ message: 'Charge saved.' })}>
                Save changes
              </Button>
            </>
          )}
          {charge.status === 'planned' && (
            <>
              <Button variant="light" color="orange" disabled={busy} onClick={() => setHolding('hold')}>
                Hold, not billed…
              </Button>
              <Button variant="subtle" color="red" disabled={busy} onClick={() => setHolding('error')}>
                Enter in error…
              </Button>
            </>
          )}
          {charge.status === 'not-billable' && (
            <>
              <Button variant="default" disabled={busy} loading={busy} onClick={() => moveTo('planned', null, 'Charge back in review.')}>
                Return to review
              </Button>
              <Button variant="subtle" color="red" disabled={busy} onClick={() => setHolding('error')}>
                Enter in error…
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Drawer>
  );
}
