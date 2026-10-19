import { Alert, Badge, NumberInput, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleX, IconLock } from '@tabler/icons-react';
import type { BillingPolicy } from '@teleemon/core';
import { SCRUB_RULES, parseDollars } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';

/** Money input. An unreadable amount is reported as NaN, which the settings check refuses to save. */
export function MoneyField({
  label,
  cents,
  onCents,
  description,
  allowBlank = false,
}: {
  readonly label: string;
  readonly cents: number | undefined;
  readonly onCents: (cents: number | undefined) => void;
  readonly description?: string;
  readonly allowBlank?: boolean;
}): JSX.Element {
  const [text, setText] = useState(() => (cents === undefined || Number.isNaN(cents) ? '' : (cents / 100).toFixed(2)));
  const parsed = parseDollars(text);
  const error =
    text.trim() === ''
      ? allowBlank
        ? undefined
        : 'Enter an amount.'
      : parsed === undefined
        ? 'Use dollars and cents, such as 45.00.'
        : parsed < 0
          ? 'Cannot be negative.'
          : undefined;
  const change = (value: string): void => {
    setText(value);
    if (value.trim() === '') onCents(allowBlank ? undefined : Number.NaN);
    else onCents(parseDollars(value) ?? Number.NaN);
  };
  return (
    <TextInput
      label={label}
      leftSection="$"
      inputMode="decimal"
      value={text}
      onChange={(e) => change(e.currentTarget.value)}
      error={error}
      description={description}
      styles={{ input: { fontVariantNumeric: 'tabular-nums' } }}
    />
  );
}

const MANDATORY_REASON = 'Identity, licensure, payer set-up and AI acceptance checks always run, so they cannot be switched off.';

/** Scrub rules (P40): each check run on a claim before it is sent. Errors block a claim; warnings are shown and allowed. */
export function ScrubRulesPanel({ disabledRules, onChange }: { readonly disabledRules: readonly string[]; readonly onChange: (ids: string[]) => void }): JSX.Element {
  const enabledCount = SCRUB_RULES.filter((r) => r.mandatory || !disabledRules.includes(r.id)).length;
  const toggle = (id: string, on: boolean): void => onChange(on ? disabledRules.filter((x) => x !== id) : [...disabledRules.filter((x) => x !== id), id]);
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed" aria-live="polite">
        {enabledCount} of {SCRUB_RULES.length} checks are on. A change applies to the next scrub; claims already scrubbed keep their result until scrubbed again.
      </Text>
      <Table.ScrollContainer minWidth={820}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Rule</Table.Th>
              <Table.Th>Check</Table.Th>
              <Table.Th>Severity</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {SCRUB_RULES.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td className="tm-num">
                  <Text size="sm" fw={600}>
                    {r.id}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{r.title}</Text>
                </Table.Td>
                <Table.Td>
                  {r.severity === 'error' ? (
                    <Badge color="red" variant="light" leftSection={<IconCircleX size={12} />}>
                      Error, blocks claim
                    </Badge>
                  ) : (
                    <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                      Warning
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  {r.mandatory ? (
                    <Tooltip label={MANDATORY_REASON} multiline w={260} withArrow>
                      <Badge color="gray" variant="light" leftSection={<IconLock size={12} />} tabIndex={0} aria-label={`${r.id} is always on. ${MANDATORY_REASON}`}>
                        Always on
                      </Badge>
                    </Tooltip>
                  ) : (
                    <Switch
                      size="sm"
                      checked={!disabledRules.includes(r.id)}
                      onChange={(e) => toggle(r.id, e.currentTarget.checked)}
                      label={disabledRules.includes(r.id) ? 'Off' : 'On'}
                      aria-label={`${r.id}: ${r.title}`}
                    />
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

/** Billing policy (P40). These values are placeholders until the practice decides them. */
export function PolicyPanel({ policy, onChange }: { readonly policy: BillingPolicy; readonly onChange: (p: BillingPolicy) => void }): JSX.Element {
  const set = (patch: Partial<BillingPolicy>): void => onChange({ ...policy, ...patch });
  const days = (v: number | string): number => (typeof v === 'number' ? v : Number.NaN);
  return (
    <Stack gap="md" maw={640}>
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Placeholder until the practice decides">
        These values are defaults for testing. The practice and its billing advisor must confirm them before any real claim or statement is sent.
      </Alert>
      <MoneyField
        label="Small-balance write-off limit"
        cents={policy.smallBalanceWriteOffCents}
        onCents={(c) => set({ smallBalanceWriteOffCents: c ?? 0 })}
        description="Billers may write off a balance up to this amount. Larger write-offs need an administrator."
      />
      <NumberInput
        label="Refund review after (days)"
        description="A credit held this long is listed for review."
        min={1}
        max={365}
        allowDecimal={false}
        value={Number.isNaN(policy.refundReviewAfterDays) ? '' : policy.refundReviewAfterDays}
        onChange={(v) => set({ refundReviewAfterDays: days(v) })}
      />
      <MoneyField
        label="No-show fee (self-pay)"
        cents={policy.noShowFeeCents ?? 0}
        onCents={(c) => set({ noShowFeeCents: c ?? 0 })}
        description="Charged to self-pay patients who miss a visit, from the appointment. $0 means no fee. Never billed to insurance."
      />
      <MoneyField
        label="Late-cancellation fee (self-pay)"
        cents={policy.lateCancelFeeCents ?? 0}
        onCents={(c) => set({ lateCancelFeeCents: c ?? 0 })}
        description="Charged to self-pay patients who cancel late. $0 means no fee."
      />
      <MoneyField
        label="Statement minimum"
        cents={policy.statementMinimumCents}
        onCents={(c) => set({ statementMinimumCents: c ?? 0 })}
        description="Patients who owe less than this are not sent a statement."
      />
      <NumberInput
        label="Statement cycle (days)"
        description="How often a statement falls due for a patient with a balance."
        min={1}
        max={365}
        allowDecimal={false}
        value={Number.isNaN(policy.statementCycleDays) ? '' : policy.statementCycleDays}
        onChange={(v) => set({ statementCycleDays: days(v) })}
      />
      <Switch
        label="Post clean insurance payments automatically"
        description="When on, an insurance payment that matches its claim exactly posts without staff. Anything else waits in exceptions (P33)."
        checked={policy.autoPostEra}
        onChange={(e) => set({ autoPostEra: e.currentTarget.checked })}
      />
      <Switch label="Every write-off names an approver" description="Fixed by the ledger. Each write-off records who approved it." checked={policy.writeOffNeedsApproval} disabled />
    </Stack>
  );
}
