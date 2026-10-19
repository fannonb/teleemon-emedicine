import { Accordion, Alert, Badge, Button, Drawer, Group, List, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconMinus, IconRefresh, IconSend } from '@tabler/icons-react';
import type { ClaimResponse } from '@medplum/fhirtypes';
import type { BillingSettings, ClaimStatus } from '@teleemon/core';
import { CLEARINGHOUSE_IDENTIFIER_SYSTEM, REVENUE_EXT, claimContentHash, formatCents, scrubStampOf } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import type { Loaded } from '../hooks/useLoader';
import { useLoader } from '../hooks/useLoader';
import { CloseReasonModal } from '../inbox/TaskDrawer';
import { formatDate } from '../utils/format';
import { ClaimStatusBadge, ConfirmStep, ModalShell, ScrubBadge } from './billingUi';
import { CreateClaimModal } from './CreateClaimModal';
import { CLOSE_REASON_EXT, errorMessage, idOf } from './billingShared';
import { payerName } from './charges';
import type { ClaimRow, RuleResult, VisitPlan } from './claimWork';
import { claimResponsesFor, claimTotalCents, clearinghouseIdOf, closeClaim, loadVisitPlan, moveClaim, payerOfClaim, previewScrub, shortClaimId, visitOf } from './claimWork';
import type { VisitBalance } from './ledgerApi';
import { ledgerApi } from './ledgerApi';

// P31 claim detail: what the claim bills, the scrub preview with every rule, the clearinghouse
// responses, and the actions the work status allows. Each action is one server write; the server
// refuses anything the rules do not allow, and its message is shown as it is.

const REPLACEABLE: readonly ClaimStatus[] = ['accepted', 'paid', 'partially-paid', 'denied', 'appealed'];
// A claim that was never sent, or was rejected, can be closed too (made by mistake, or not billable).
const CLOSABLE: readonly ClaimStatus[] = ['draft', 'scrubbed', 'rejected', 'paid', 'partially-paid', 'denied', 'appealed'];

export function ClaimDrawer({ row, settings, onClose, onChanged }: { readonly row: ClaimRow; readonly settings: BillingSettings; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { claim, status } = row;
  const claimId = claim.id ?? '';
  const name = patientName(row.patient);
  const payer = payerName(payerOfClaim(claim), settings.payers);
  const stamp = scrubStampOf(claim);
  const stale = stamp !== undefined && stamp.hash !== claimContentHash(claim);

  const detail = useLoader(
    async () => {
      const [preview, responses] = await Promise.all([previewScrub(medplum, claim, settings), claimResponsesFor(medplum, claimId)]);
      return { preview, responses };
    },
    [medplum, claimId, claim.meta?.versionId]
  );

  const visitId = idOf(visitOf(claim));
  const balance = useLoader<VisitBalance | undefined>(() => (visitId ? ledgerApi.visit(medplum, visitId) : Promise.resolve(undefined)), [medplum, visitId]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [replacing, setReplacing] = useState<VisitPlan>();

  // Runs one write; the drawer re-reads the claim afterwards. Returns whether it went through.
  const run = async (action: () => Promise<unknown>, message: string): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      notifications.show({ color: 'brand', message });
      onChanged();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openReplacement = async (): Promise<void> => {
    const visit = visitOf(claim);
    if (!visit) {
      setError('This claim names no visit, so a replacement cannot be built from it.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setReplacing(await loadVisitPlan(medplum, visit, settings.payers, claimId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const preview = detail.data?.preview;
  const errors = preview?.rules.filter((r) => r.state === 'error') ?? [];
  const closedReason = claim.extension?.find((e) => e.url === CLOSE_REASON_EXT)?.valueString;
  const rejectionNotes = (detail.data?.responses ?? []).flatMap((r) => (r.processNote ?? []).map((n) => n.text ?? '')).filter(Boolean);
  const canSubmit = status === 'scrubbed' && preview !== undefined && errors.length === 0 && !busy;

  return (
    <Drawer opened onClose={onClose} position="right" size="xl" title={<Text fw={650}>{`Claim · ${name}`}</Text>}>
      <Stack gap="md">
        <Group gap="xs" wrap="wrap">
          <ClaimStatusBadge status={status} />
          <ScrubBadge claim={claim} />
          <Text size="sm" c="dimmed" className="tm-num">
            {formatDate(claim.billablePeriod?.start)} · {payer.text} · {formatCents(claimTotalCents(claim))} · claim {shortClaimId(claim)}
          </Text>
        </Group>

        <VisitBalanceLine visitId={visitId} balance={balance} />

        {status === 'rejected' && (
          <Alert color="red" variant="light" icon={<IconCircleX size={18} />} title="Rejected">
            <Text size="sm" mb={rejectionNotes.length ? 'xs' : 0}>
              The clearinghouse or payer rejected this claim. Correct the lines or charges, then move it back to draft and scrub it again.
            </Text>
            {rejectionNotes.length > 0 && (
              <List size="sm" spacing={2}>
                {rejectionNotes.map((n, i) => (
                  <List.Item key={`${i}-${n}`}>{n}</List.Item>
                ))}
              </List>
            )}
          </Alert>
        )}
        {status === 'denied' && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Denied">
            The appeal, its deadline and the next step are tracked on Denials &amp; appeals (P34).
          </Alert>
        )}
        {status === 'appealed' && (
          <Alert color="orange" variant="light" icon={<IconInfoCircle size={18} />} title="Appeal in progress">
            The appeal letter is saved on the patient&apos;s documents. The payer&apos;s decision arrives with the next remittance.
          </Alert>
        )}
        {(status === 'submitted' || status === 'accepted') && (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="With the clearinghouse or payer">
            Nothing to do here. The worker records acknowledgements and payments as they arrive.
          </Alert>
        )}
        {status === 'closed' && (
          <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />} title="Closed">
            {closedReason ? `Reason: ${closedReason}` : 'No reason recorded.'} The claim stays on record.
          </Alert>
        )}
        {stale && (status === 'draft' || status === 'scrubbed') && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Changed since the last scrub">
            The claim was edited after the server scrubbed it. Scrub it again before submitting.
          </Alert>
        )}

        <Stack gap={6}>
          <Text fw={650} size="sm">
            Lines
          </Text>
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs" aria-label="Claim lines" withRowBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Modifiers</Table.Th>
                  <Table.Th>Diagnosis pointers</Table.Th>
                  <Table.Th>Units</Table.Th>
                  <Table.Th>POS</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                  <Table.Th>Charge</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(claim.item ?? []).map((item, i) => (
                  <Table.Tr key={`${item.sequence ?? i}`}>
                    <Table.Td className="tm-num">{item.productOrService?.coding?.[0]?.code ?? '—'}</Table.Td>
                    <Table.Td className="tm-num">{(item.modifier ?? []).map((m) => m.coding?.[0]?.code).filter(Boolean).join(', ') || '—'}</Table.Td>
                    <Table.Td className="tm-num">{(item.diagnosisSequence ?? []).map((n) => String.fromCharCode(64 + n)).join(', ') || '—'}</Table.Td>
                    <Table.Td className="tm-num">{item.quantity?.value ?? '—'}</Table.Td>
                    <Table.Td className="tm-num">{item.locationCodeableConcept?.coding?.[0]?.code ?? '—'}</Table.Td>
                    <Table.Td ta="right" className="tm-num">
                      {item.net?.value === undefined ? '—' : formatCents(Math.round(item.net.value * 100))}
                    </Table.Td>
                    <Table.Td className="tm-num">
                      <Text size="xs" c="dimmed">
                        {item.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference?.split('/')[1]?.slice(0, 8) ?? '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group gap="xs" wrap="wrap">
            {(claim.diagnosis ?? []).map((d, i) => (
              <Badge key={`${d.sequence ?? i}`} variant="outline" color="gray" className="tm-num">
                {String.fromCharCode(65 + i)} · {d.diagnosisCodeableConcept?.coding?.[0]?.code ?? '?'}
              </Badge>
            ))}
          </Group>
        </Stack>

        <Stack gap="sm">
          <Group justify="space-between" align="center">
            <Text fw={650} size="sm">
              Scrub preview
            </Text>
            <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={detail.reload} disabled={detail.loading}>
              Run again
            </Button>
          </Group>
          {detail.error && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Preview not available">
              {detail.error.message}
            </Alert>
          )}
          {preview && (
            <>
              <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="Preview">
                Preview; the server re-checks when you scrub or submit.
              </Alert>
              <Group gap="xs" wrap="wrap" aria-live="polite">
                <Badge color={errors.length ? 'red' : 'green'} variant="light" className="tm-num">
                  {errors.length} error{errors.length === 1 ? '' : 's'}
                </Badge>
                <Badge color="orange" variant="light" className="tm-num">
                  {preview.rules.filter((r) => r.state === 'warning').length} warning{preview.rules.filter((r) => r.state === 'warning').length === 1 ? '' : 's'}
                </Badge>
                <Badge color="gray" variant="light" className="tm-num">
                  {preview.rules.filter((r) => r.state === 'pass').length} passed
                </Badge>
                <Badge color="gray" variant="outline" className="tm-num">
                  {preview.rules.filter((r) => r.state === 'off').length} off in settings
                </Badge>
              </Group>
              {(errors.length > 0 || preview.rules.some((r) => r.state === 'warning')) && (
                <Stack gap={4}>
                  {[...errors, ...preview.rules.filter((r) => r.state === 'warning')].map((r) => (
                    <RuleLine key={r.rule.id} result={r} />
                  ))}
                </Stack>
              )}
              <Accordion variant="separated" chevronPosition="left">
                <Accordion.Item value="all">
                  <Accordion.Control>All {preview.rules.length} checks</Accordion.Control>
                  <Accordion.Panel>
                    <Table verticalSpacing={6} withRowBorders aria-label="Every scrub check">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Result</Table.Th>
                          <Table.Th>Rule</Table.Th>
                          <Table.Th>Check</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {preview.rules.map((r) => (
                          <Table.Tr key={r.rule.id}>
                            <Table.Td>
                              <StateLabel state={r.state} />
                            </Table.Td>
                            <Table.Td className="tm-num">
                              <Text size="xs">{r.rule.id}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">{r.rule.title}</Text>
                              {r.message && (
                                <Text size="xs" c={r.state === 'error' ? 'red' : 'orange'}>
                                  {r.message}
                                </Text>
                              )}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </>
          )}
          {!preview && !detail.error && <Text size="sm" c="dimmed">Running the checks…</Text>}
        </Stack>

        <Stack gap={6}>
          <Text fw={650} size="sm">
            Clearinghouse and payer responses
          </Text>
          <Text size="sm">
            Clearinghouse ID: <span className="tm-num">{clearinghouseIdOf(claim) ?? (claim.identifier?.some((i) => i.system === CLEARINGHOUSE_IDENTIFIER_SYSTEM) ? '—' : 'Not sent yet')}</span>
          </Text>
          {(detail.data?.responses ?? []).length === 0 ? (
            <Text size="sm" c="dimmed">
              No acknowledgements or payments yet.
            </Text>
          ) : (
            <Stack gap={4}>
              {(detail.data?.responses ?? []).map((r: ClaimResponse) => (
                <Text key={r.id} size="sm">
                  <span className="tm-num">{formatDate(r.created)}</span> · {r.disposition ?? r.outcome ?? 'Response'}
                  {r.payment?.amount?.value !== undefined ? ` · paid ${formatCents(Math.round(r.payment.amount.value * 100))}` : ''}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not saved">
            {error}
          </Alert>
        )}

        <Group gap="xs" wrap="wrap">
          {status === 'draft' && (
            <Button leftSection={<IconCircleCheck size={16} />} loading={busy} disabled={busy} onClick={() => run(() => moveClaim(medplum, claimId, 'scrubbed'), 'Scrubbed. The server recorded the result.')}>
              Scrub with server
            </Button>
          )}
          {status === 'scrubbed' && (
            <>
              <Button leftSection={<IconSend size={16} />} color="indigo" disabled={!canSubmit} onClick={() => setConfirmSubmit(true)}>
                Submit…
              </Button>
              <Button variant="default" disabled={busy} onClick={() => run(() => moveClaim(medplum, claimId, 'draft'), 'Claim back in draft.')}>
                Back to draft
              </Button>
              {!canSubmit && (
                <Text size="xs" c="dimmed" w="100%">
                  {preview ? (errors.length ? `Fix the ${errors.length} error${errors.length === 1 ? '' : 's'} before submitting.` : 'Checking…') : 'Waiting for the checks to load.'}
                </Text>
              )}
            </>
          )}
          {status === 'rejected' && (
            <Button loading={busy} disabled={busy} onClick={() => run(() => moveClaim(medplum, claimId, 'draft'), 'Claim back in draft for correction.')}>
              Correct: back to draft
            </Button>
          )}
          {REPLACEABLE.includes(status) && (
            <Button variant="default" disabled={busy} loading={busy} onClick={openReplacement}>
              Create replacement claim
            </Button>
          )}
          {CLOSABLE.includes(status) && (
            <Button variant="subtle" color="red" disabled={busy} onClick={() => setClosing(true)}>
              Close with reason…
            </Button>
          )}
          {(status === 'submitted' || status === 'accepted') && (
            <Text size="xs" c="dimmed" w="100%">
              A submitted or accepted claim cannot be closed until the payer pays or denies it.
            </Text>
          )}
          {status === 'denied' && (
            <Text size="xs" c="dimmed" w="100%">
              Appeals, transfers and write-offs for this denial are on Denials &amp; appeals (P34).
            </Text>
          )}
        </Group>
      </Stack>

      {closing && (
        <CloseReasonModal
          opened
          title="Close claim with a reason"
          label="Why is this claim closed?"
          onClose={() => setClosing(false)}
          onConfirm={(reason) => {
            setClosing(false);
            void run(() => closeClaim(medplum, claimId, reason), 'Claim closed with its reason.');
          }}
        />
      )}

      {confirmSubmit && (
        <ModalShell title="Submit this claim" onClose={() => setConfirmSubmit(false)} busy={busy}>
          <ConfirmStep
            busy={busy}
            color="indigo"
            onBack={() => setConfirmSubmit(false)}
            onConfirm={async () => {
              const ok = await run(() => moveClaim(medplum, claimId, 'submitted'), 'Submitted. The worker sends it to the clearinghouse.');
              if (ok) setConfirmSubmit(false);
            }}
            confirmLabel="Submit claim"
            summary={
              <Text size="sm">
                Send the claim for {name} ({formatCents(claimTotalCents(claim))}) to {payer.text}. Once submitted it cannot be edited; corrections go through a rejected claim or a replacement.
              </Text>
            }
          />
        </ModalShell>
      )}

      {replacing && (
        <CreateClaimModal
          title="Create a replacement claim"
          plan={replacing.plan}
          patientName={name}
          providerName={replacing.providerName}
          payers={settings.payers}
          replaces={claimId}
          onClose={() => setReplacing(undefined)}
          onCreated={() => {
            setReplacing(undefined);
            onChanged();
            onClose();
          }}
        />
      )}
    </Drawer>
  );
}

/** What the payer and the patient still owe on the claim's visit, from the ledger. */
function VisitBalanceLine({ visitId, balance }: { readonly visitId?: string; readonly balance: Loaded<VisitBalance | undefined> }): JSX.Element {
  if (!visitId) {
    return (
      <Text size="sm" c="dimmed">
        This claim names no visit, so no visit balance is shown.
      </Text>
    );
  }
  if (balance.error) {
    return (
      <Text size="sm" c="orange">
        The visit balance could not be read: {balance.error.message}
      </Text>
    );
  }
  if (!balance.data) {
    return (
      <Text size="sm" c="dimmed">
        Reading the visit balance…
      </Text>
    );
  }
  return (
    <Group gap="xl" wrap="wrap" aria-live="polite" aria-label="Visit balance">
      <Stack gap={0}>
        <Text fw={700} fz={20} className="tm-num">
          {formatCents(balance.data.payerOwesCents)}
        </Text>
        <Text size="xs" c="dimmed">
          Payer owes on this visit
        </Text>
      </Stack>
      <Stack gap={0}>
        <Text fw={700} fz={20} className="tm-num">
          {formatCents(balance.data.patientOwesCents)}
        </Text>
        <Text size="xs" c="dimmed">
          Patient owes on this visit
        </Text>
      </Stack>
    </Group>
  );
}

function StateLabel({ state }: { readonly state: RuleResult['state'] }): JSX.Element {
  if (state === 'pass') {
    return (
      <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
        Pass
      </Badge>
    );
  }
  if (state === 'error') {
    return (
      <Badge color="red" variant="light" leftSection={<IconCircleX size={12} />}>
        Error
      </Badge>
    );
  }
  if (state === 'warning') {
    return (
      <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Warning
      </Badge>
    );
  }
  return (
    <Badge color="gray" variant="outline" leftSection={<IconMinus size={12} />}>
      Off
    </Badge>
  );
}

function RuleLine({ result }: { readonly result: RuleResult }): JSX.Element {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <StateLabel state={result.state} />
      <Text size="sm">
        <b className="tm-num">{result.rule.id}</b> {result.rule.title}
        {result.message ? ` — ${result.message}` : ''}
      </Text>
    </Group>
  );
}
