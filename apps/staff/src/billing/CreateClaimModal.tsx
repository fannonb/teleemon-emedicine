import { Alert, Badge, Button, Group, List, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconFilePlus } from '@tabler/icons-react';
import type { Claim } from '@medplum/fhirtypes';
import type { PayerConfig } from '@teleemon/core';
import { formatCents } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { formatDate } from '../utils/format';
import { ModalShell } from './billingUi';
import type { ClaimPlan } from './claimWork';
import { errorMessage } from './billingShared';
import { payerName } from './charges';

// Shows a claim before it is created (a draft; nothing is sent). A replacement names the claim it
// corrects. The server checks the claim again when it is saved, and its refusal shows here.

export function CreateClaimModal({
  title,
  plan,
  patientName,
  providerName,
  payers,
  replaces,
  onClose,
  onCreated,
}: {
  readonly title: string;
  readonly plan: ClaimPlan;
  readonly patientName: string;
  readonly providerName?: string;
  readonly payers: readonly PayerConfig[];
  /** Set for a replacement; the new draft names this claim in Claim.related. */
  readonly replaces?: string;
  readonly onClose: () => void;
  readonly onCreated: (claim: Claim) => void;
}): JSX.Element {
  const medplum = useMedplum();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = plan.problems.length === 0 && plan.claim !== undefined;

  const create = async (): Promise<void> => {
    if (!plan.claim) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await medplum.createResource(plan.claim);
      notifications.show({ color: 'brand', message: replaces ? 'Replacement claim drafted. It is in Draft.' : 'Claim drafted. Scrub it when the lines are right.' });
      onCreated(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={title} onClose={onClose} busy={busy} size="lg">
      <Stack gap="md">
        <Text size="sm">
          <b>{patientName}</b>
          {plan.serviceDate ? ` · service ${formatDate(plan.serviceDate)}` : ''}
          {providerName ? ` · ${providerName}` : ''}
          {plan.payer ? ` · ${payerName(plan.payer, payers).text}` : ''}
        </Text>

        {plan.problems.length > 0 && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Not ready to bill">
            <List size="sm" spacing={4}>
              {plan.problems.map((p) => (
                <List.Item key={p}>{p}</List.Item>
              ))}
            </List>
          </Alert>
        )}

        {plan.lines.length > 0 && (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" aria-label="Claim lines">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Modifiers</Table.Th>
                  <Table.Th>Diagnosis pointers</Table.Th>
                  <Table.Th>POS</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {plan.lines.map((l) => (
                  <Table.Tr key={l.charge.id}>
                    <Table.Td className="tm-num">{l.code || '—'}</Table.Td>
                    <Table.Td className="tm-num">{l.modifiers.join(', ') || '—'}</Table.Td>
                    <Table.Td className="tm-num">{l.pointers.map((p) => String.fromCharCode(64 + p)).join(', ') || '—'}</Table.Td>
                    <Table.Td className="tm-num">{l.pos || '—'}</Table.Td>
                    <Table.Td ta="right" className="tm-num">{formatCents(l.cents)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        <Group gap="xs" wrap="wrap">
          {plan.diagnoses.map((d, i) => (
            <Badge key={`${d.code}-${i}`} variant="outline" color="gray" className="tm-num">
              {String.fromCharCode(65 + i)} · {d.code}
            </Badge>
          ))}
        </Group>

        <Group justify="space-between">
          <Text size="sm" fw={650}>
            Total <span className="tm-num">{formatCents(plan.totalCents)}</span>
          </Text>
          <Text size="xs" c="dimmed">
            Saved as a draft. Nothing is sent until it is scrubbed and submitted.
          </Text>
        </Group>

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not saved">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button leftSection={<IconFilePlus size={16} />} onClick={create} disabled={!ready || busy} loading={busy}>
            {replaces ? 'Create replacement draft' : 'Create draft claim'}
          </Button>
        </Group>
      </Stack>
    </ModalShell>
  );
}
