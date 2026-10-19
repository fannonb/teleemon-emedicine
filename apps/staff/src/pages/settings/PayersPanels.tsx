import { Alert, Badge, Button, Drawer, Group, List, Modal, NumberInput, Select, Stack, Switch, Table, TagsInput, Text, TextInput } from '@mantine/core';
import { IconCircleCheck, IconCoin, IconPlayerPause, IconPlus } from '@tabler/icons-react';
import type { FeeScheduleEntry, PayerConfig } from '@teleemon/core';
import { formatCents } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { EmptyState } from '../../components/states';
import { MoneyField } from './RulesPanels';
import { PAYER_CODE, feeProblems, payerProblems } from './billingRules';

const TELEHEALTH: Record<PayerConfig['telehealthModifier'], string> = { '95': 'Modifier 95', GT: 'Modifier GT', none: 'None' };

const numberOrBlank = (n: number): number | string => (Number.isNaN(n) ? '' : n);
const asNumber = (v: number | string): number => (typeof v === 'number' ? v : Number.NaN);

/** Payers (P40): the insurers the practice bills, with their identifiers and filing rules. */
export function PayersPanel({ payers, onChange }: { readonly payers: readonly PayerConfig[]; readonly onChange: (next: PayerConfig[]) => void }): JSX.Element {
  const [editing, setEditing] = useState<{ payer: PayerConfig; isNew: boolean }>();
  const active = payers.filter((p) => p.active).length;
  const blankPayer: PayerConfig = {
    id: 'payer:',
    name: '',
    payerIdCode: '',
    timelyFilingDays: 90,
    appealDays: 180,
    requiresPriorAuthCodes: [],
    telehealthModifier: 'none',
    acceptsPos10: true,
    active: true,
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed" className="tm-num" aria-live="polite">
          {payers.length} payers, {active} active. Inactive payers stay on existing charges but cannot be chosen for new ones.
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ payer: blankPayer, isNew: true })}>
          Add payer
        </Button>
      </Group>
      {payers.length === 0 ? (
        <Alert color="blue" variant="light" title="No payers yet">
          Add the payers the practice bills. Charges can only be released to an active payer or to self-pay.
        </Alert>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Payer</Table.Th>
                <Table.Th>Payer ID</Table.Th>
                <Table.Th>Timely filing</Table.Th>
                <Table.Th>Telehealth</Table.Th>
                <Table.Th>POS 10</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {payers.map((p) => (
                <Table.Tr key={p.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {p.name}
                    </Text>
                    <Text size="xs" c="dimmed" className="tm-num">
                      {p.id}
                    </Text>
                  </Table.Td>
                  <Table.Td className="tm-num">{p.payerIdCode || '—'}</Table.Td>
                  <Table.Td className="tm-num">{p.timelyFilingDays} days</Table.Td>
                  <Table.Td>{TELEHEALTH[p.telehealthModifier]}</Table.Td>
                  <Table.Td>{p.acceptsPos10 ? 'Accepted' : 'Not accepted'}</Table.Td>
                  <Table.Td>
                    {p.active ? (
                      <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
                        Active
                      </Badge>
                    ) : (
                      <Badge color="gray" variant="light" leftSection={<IconPlayerPause size={12} />}>
                        Inactive
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button size="xs" variant="default" onClick={() => setEditing({ payer: p, isNew: false })} aria-label={`Edit ${p.name}`}>
                      Edit
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {editing && (
        <PayerDrawer
          key={editing.isNew ? 'new' : editing.payer.id}
          initial={editing.payer}
          isNew={editing.isNew}
          others={editing.isNew ? payers : payers.filter((p) => p.id !== editing.payer.id)}
          onClose={() => setEditing(undefined)}
          onSave={(saved) => {
            onChange(editing.isNew ? [...payers, saved] : payers.map((p) => (p.id === saved.id ? saved : p)));
            setEditing(undefined);
          }}
        />
      )}
    </Stack>
  );
}

function PayerDrawer({
  initial,
  isNew,
  others,
  onClose,
  onSave,
}: {
  readonly initial: PayerConfig;
  readonly isNew: boolean;
  readonly others: readonly PayerConfig[];
  readonly onClose: () => void;
  readonly onSave: (p: PayerConfig) => void;
}): JSX.Element {
  const [code, setCode] = useState(isNew ? '' : initial.id.replace(/^payer:/, ''));
  const [draft, setDraft] = useState<PayerConfig>(initial);
  const candidate: PayerConfig = { ...draft, id: isNew ? `payer:${code}` : initial.id };
  const problems = payerProblems(candidate, others, isNew);
  const set = (patch: Partial<PayerConfig>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Drawer opened onClose={onClose} position="right" size="md" title={<Text fw={650}>{isNew ? 'Add a payer' : `Edit ${initial.name}`}</Text>}>
      <Stack gap="md">
        {isNew && (
          <TextInput
            label="Internal code"
            description="Used in the ledger and reports, such as synthetic-commercial. It cannot be changed later."
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.toLowerCase())}
            error={code !== '' && !PAYER_CODE.test(code) ? '2 to 41 lower-case letters, numbers or dashes.' : undefined}
            required
          />
        )}
        <TextInput label="Payer name" value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} required />
        <TextInput
          label="Payer ID (837)"
          description="The clearinghouse routing ID the claim is sent to."
          value={draft.payerIdCode}
          onChange={(e) => set({ payerIdCode: e.currentTarget.value.trim() })}
          required
        />
        <TextInput
          label="Trading partner ID (optional)"
          description="Only if the clearinghouse uses a separate trading partner ID."
          value={draft.stediTradingPartnerId ?? ''}
          onChange={(e) => set({ stediTradingPartnerId: e.currentTarget.value.trim() || undefined })}
        />
        <Group grow align="flex-start">
          <NumberInput label="Timely filing (days)" min={1} max={1095} allowDecimal={false} value={numberOrBlank(draft.timelyFilingDays)} onChange={(v) => set({ timelyFilingDays: asNumber(v) })} />
          <NumberInput label="Appeal window (days)" min={1} max={730} allowDecimal={false} value={numberOrBlank(draft.appealDays)} onChange={(v) => set({ appealDays: asNumber(v) })} />
        </Group>
        <TagsInput
          label="Codes that need prior authorization"
          description="Type a 5-character procedure code and press Enter."
          value={[...draft.requiresPriorAuthCodes]}
          onChange={(vals) => set({ requiresPriorAuthCodes: vals.map((v) => v.trim().toUpperCase()) })}
          clearable
        />
        <Select
          label="Telehealth modifier"
          description="Added to telehealth lines (place of service 02 and 10) for this payer."
          data={(Object.keys(TELEHEALTH) as PayerConfig['telehealthModifier'][]).map((v) => ({ value: v, label: TELEHEALTH[v] }))}
          value={draft.telehealthModifier}
          onChange={(v) => v && set({ telehealthModifier: v as PayerConfig['telehealthModifier'] })}
          allowDeselect={false}
        />
        <Switch label="Accepts place of service 10 (telehealth at home)" checked={draft.acceptsPos10} onChange={(e) => set({ acceptsPos10: e.currentTarget.checked })} />
        <Switch label="Active" description="Inactive payers cannot be chosen for new charges." checked={draft.active} onChange={(e) => set({ active: e.currentTarget.checked })} />

        {problems.length > 0 && (
          <Alert color="orange" variant="light" title="Fix before saving">
            <List size="sm" spacing={4}>
              {problems.map((p) => (
                <List.Item key={p}>{p}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={problems.length > 0} onClick={() => onSave(candidate)}>
            {isNew ? 'Add payer' : 'Save payer'}
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}

/** Fee schedule (P40): the billed charge for each code, and the allowed amount each payer pays (for variance checks). */
export function FeesPanel({ fees, payers, onChange }: { readonly fees: readonly FeeScheduleEntry[]; readonly payers: readonly PayerConfig[]; readonly onChange: (next: FeeScheduleEntry[]) => void }): JSX.Element {
  const [editing, setEditing] = useState<{ fee: FeeScheduleEntry; isNew: boolean }>();
  const shown = payers.filter((p) => p.active);
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed" className="tm-num" aria-live="polite">
          {fees.length} codes. A code missing from this list cannot be captured from a note.
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ fee: { code: '', description: '', chargeCents: Number.NaN }, isNew: true })}>
          Add code
        </Button>
      </Group>
      {fees.length === 0 ? (
        <EmptyState icon={<IconCoin size={22} />} title="No procedure codes yet">
          Add the codes the practice bills. A visit can only be captured with a code that is listed here.
        </EmptyState>
      ) : (
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Description</Table.Th>
              <Table.Th ta="right">Charge</Table.Th>
              {shown.map((p) => (
                <Table.Th key={p.id} ta="right">
                  Allowed, {p.name}
                </Table.Th>
              ))}
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {fees.map((f) => (
              <Table.Tr key={f.code}>
                <Table.Td className="tm-num" fw={600}>
                  {f.code}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{f.description}</Text>
                </Table.Td>
                <Table.Td ta="right" className="tm-num">
                  {formatCents(f.chargeCents)}
                </Table.Td>
                {shown.map((p) => (
                  <Table.Td key={p.id} ta="right" className="tm-num">
                    {f.allowedCents?.[p.id] === undefined ? <Text span c="dimmed">—</Text> : formatCents(f.allowedCents[p.id])}
                  </Table.Td>
                ))}
                <Table.Td ta="right">
                  <Button size="xs" variant="default" onClick={() => setEditing({ fee: f, isNew: false })} aria-label={`Edit code ${f.code}`}>
                    Edit
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      )}

      {editing && (
        <FeeModal
          key={editing.isNew ? 'new' : editing.fee.code}
          initial={editing.fee}
          isNew={editing.isNew}
          payers={shown}
          others={editing.isNew ? fees : fees.filter((f) => f.code !== editing.fee.code)}
          onClose={() => setEditing(undefined)}
          onSave={(saved) => {
            onChange(editing.isNew ? [...fees, saved] : fees.map((f) => (f.code === saved.code ? saved : f)));
            setEditing(undefined);
          }}
        />
      )}
    </Stack>
  );
}

function FeeModal({
  initial,
  isNew,
  payers,
  others,
  onClose,
  onSave,
}: {
  readonly initial: FeeScheduleEntry;
  readonly isNew: boolean;
  readonly payers: readonly PayerConfig[];
  readonly others: readonly FeeScheduleEntry[];
  readonly onClose: () => void;
  readonly onSave: (f: FeeScheduleEntry) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<FeeScheduleEntry>(initial);
  const problems = feeProblems(draft, others, isNew);
  const allowed = (payerId: string): number | undefined => draft.allowedCents?.[payerId];
  const setAllowed = (payerId: string, cents: number | undefined): void => {
    const next = { ...(draft.allowedCents ?? {}) } as Record<string, number>;
    if (cents === undefined) delete next[payerId];
    else next[payerId] = cents;
    setDraft((d) => ({ ...d, allowedCents: next }));
  };

  return (
    <Modal opened onClose={onClose} title={<Text fw={650}>{isNew ? 'Add a procedure code' : `Code ${initial.code}`}</Text>} centered size="md">
      <Stack gap="md">
        <TextInput
          label="Procedure code"
          description="5 characters, such as 99214 or 90838. Each code appears once."
          value={draft.code}
          onChange={(e) => setDraft((d) => ({ ...d, code: e.currentTarget.value.toUpperCase().trim() }))}
          disabled={!isNew}
          required
        />
        <TextInput label="Description" value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.currentTarget.value }))} required />
        <MoneyField label="Billed charge" cents={Number.isNaN(draft.chargeCents) ? Number.NaN : draft.chargeCents} onCents={(c) => setDraft((d) => ({ ...d, chargeCents: c ?? Number.NaN }))} />
        {payers.length > 0 && (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Allowed amounts (optional)
            </Text>
            <Text size="xs" c="dimmed">
              What each payer is expected to pay. Used to flag payments that differ; leave blank when unknown.
            </Text>
            {payers.map((p) => (
              <MoneyField key={p.id} label={p.name} cents={allowed(p.id)} allowBlank onCents={(c) => setAllowed(p.id, c)} />
            ))}
          </Stack>
        )}
        {problems.length > 0 && (
          <Alert color="orange" variant="light" title="Fix before saving">
            <List size="sm" spacing={4}>
              {problems.map((p) => (
                <List.Item key={p}>{p}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={problems.length > 0} onClick={() => onSave(draft)}>
            {isNew ? 'Add code' : 'Save code'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
