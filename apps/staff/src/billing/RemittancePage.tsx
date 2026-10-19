import { Alert, Badge, Button, Card, Drawer, Group, List, Stack, Table, Tabs, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconClock, IconInbox, IconInfoCircle } from '@tabler/icons-react';
import type { Claim, Task } from '@medplum/fhirtypes';
import type { PayerConfig, RemitClaim } from '@teleemon/core';
import { claimStatusOf, formatCents, parseDollars } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { CloseReasonModal } from '../inbox/TaskDrawer';
import { formatDate, formatTime } from '../utils/format';
import { cancelledTask, completedTask, errorMessage, setTaskState } from './billingShared';
import { ClaimStatusBadge, ConfirmStep } from './billingUi';
import { payerName } from './charges';
import { ledgerApi } from './ledgerApi';
import type { ExceptionContext, ExceptionRow, RemitData, RemitRow } from './remittance';
import { exceptionContext, loadRemitDetail, loadRemittances } from './remittance';
import { payerOfClaim, visitOf } from './claimWork';

// P33 Remittance & posting: every 835 against what the ledger posted under its trace. Clean ones
// post on their own; the exceptions wait here, where a biller posts the claim by hand or closes it.

type Tab = 'remittances' | 'exceptions';

export function RemittancePage(): JSX.Element {
  const medplum = useMedplum();
  const [tab, setTab] = useState<Tab>('remittances');
  const [openTrace, setOpenTrace] = useState<string>();
  const [openException, setOpenException] = useState<string>();
  const data = useLoader(() => loadRemittances(medplum), [medplum]);
  const rows = data.data?.rows ?? [];
  const exceptions = data.data?.exceptions ?? [];
  const openRow = openTrace ? rows.find((r) => r.trace === openTrace) : undefined;
  const openEx = openException ? exceptions.find((e) => e.task.id === openException) : undefined;

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="P33 · Billing"
        title="Remittance & posting"
        subtitle="Insurer payments (835s) against what the ledger posted. Clean payments post automatically; the rest wait in exceptions."
      />
      <Stack gap="lg">
        <ChecksStrip data={data.data} error={data.error} onRetry={data.reload} />

        <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)}>
          <Tabs.List mb="md" aria-label="Remittance views">
            <Tabs.Tab value="remittances">Remittances</Tabs.Tab>
            <Tabs.Tab value="exceptions">
              Exceptions{' '}
              <Text span size="xs" c="dimmed" className="tm-num">
                {data.data ? exceptions.length : '…'}
              </Text>
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="remittances">
            <Section
              loaded={data}
              padding="md"
              rows={5}
              isEmpty={(d) => d.rows.length === 0}
              empty={{ icon: <IconInbox size={22} />, title: 'No remittances yet', text: 'Each insurer payment file appears here once the worker has read it.' }}
            >
              {(d) => (
                <Card padding={0} withBorder={false}>
                  <Table.ScrollContainer minWidth={1080}>
                    <Table verticalSpacing="sm" highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Payment date</Table.Th>
                          <Table.Th>Trace</Table.Th>
                          <Table.Th>Payer</Table.Th>
                          <Table.Th ta="right">Payer total</Table.Th>
                          <Table.Th ta="right">Cash posted</Table.Th>
                          <Table.Th>Posting</Table.Th>
                          <Table.Th ta="right">Claims</Table.Th>
                          <Table.Th ta="right">Exceptions</Table.Th>
                          <Table.Th />
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {d.rows.map((r) => (
                          <Table.Tr key={r.trace} onClick={() => setOpenTrace(r.trace)} style={{ cursor: 'pointer' }}>
                            <Table.Td className="tm-num">{formatDate(r.paymentDate)}</Table.Td>
                            <Table.Td className="tm-num">{r.trace}</Table.Td>
                            <Table.Td>
                              <Text size="sm">{payerName(r.ledger?.payerRef, d.payers).text}</Text>
                            </Table.Td>
                            <Table.Td ta="right" className="tm-num">
                              {formatCents(r.ledger?.paidCents ?? r.eftCents)}
                            </Table.Td>
                            <Table.Td ta="right" className="tm-num">
                              {r.ledger ? formatCents(r.ledger.postedCashCents) : '—'}
                            </Table.Td>
                            <Table.Td>
                              <PostingBadge row={r} />
                            </Table.Td>
                            <Table.Td ta="right" className="tm-num">
                              {r.claimCount}
                            </Table.Td>
                            <Table.Td ta="right" className="tm-num">
                              {r.openExceptions}
                            </Table.Td>
                            <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                              <Button size="xs" variant="default" onClick={() => setOpenTrace(r.trace)} aria-label={`Open remittance ${r.trace}`}>
                                Open
                              </Button>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Card>
              )}
            </Section>
          </Tabs.Panel>

          <Tabs.Panel value="exceptions">
            <Section
              loaded={data}
              padding="md"
              rows={4}
              isEmpty={(d) => d.exceptions.length === 0}
              empty={{ icon: <IconCircleCheck size={22} />, title: 'No open exceptions', text: 'Payments that did not post on their own appear here with the reason.' }}
            >
              {(d) => (
                <Card padding={0} withBorder={false}>
                  <Table.ScrollContainer minWidth={960}>
                    <Table verticalSpacing="sm" highlightOnHover>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Opened</Table.Th>
                          <Table.Th>Trace</Table.Th>
                          <Table.Th>Claim</Table.Th>
                          <Table.Th>Patient</Table.Th>
                          <Table.Th>Reason</Table.Th>
                          <Table.Th />
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {d.exceptions.map((x) => (
                          <Table.Tr key={x.task.id} onClick={() => setOpenException(x.task.id)} style={{ cursor: 'pointer' }}>
                            <Table.Td className="tm-num">
                              <Text size="sm">{formatDate(x.task.authoredOn?.slice(0, 10))}</Text>
                              <Text size="xs" c="dimmed">
                                {formatTime(x.task.authoredOn)}
                              </Text>
                            </Table.Td>
                            <Table.Td className="tm-num">{x.trace ?? '—'}</Table.Td>
                            <Table.Td className="tm-num">{x.patientControlNumber ? x.patientControlNumber.slice(0, 8) : '—'}</Table.Td>
                            <Table.Td>
                              <Text size="sm" fw={600}>
                                {patientName(x.patient)}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" lineClamp={2}>
                                {x.task.description ?? x.task.code?.text ?? 'Remittance exception'}
                              </Text>
                            </Table.Td>
                            <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                              <Button size="xs" variant="default" onClick={() => setOpenException(x.task.id)} aria-label={`Resolve exception for ${patientName(x.patient)}`}>
                                Resolve…
                              </Button>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </Card>
              )}
            </Section>
          </Tabs.Panel>
        </Tabs>
      </Stack>

      {openRow && data.data && <RemittanceDrawer key={openRow.trace} row={openRow} payers={data.data.payers} onClose={() => setOpenTrace(undefined)} />}
      {openEx && data.data && (
        <ExceptionDrawer
          key={`${openEx.task.id}:${openEx.task.meta?.versionId}`}
          row={openEx}
          payers={data.data.payers}
          onClose={() => setOpenException(undefined)}
          onChanged={() => data.reload()}
        />
      )}
    </PageBody>
  );
}

/** The ledger's reconciliation checks as one strip: green when every check passes. */
function ChecksStrip({ data, error, onRetry }: { readonly data: RemitData | undefined; readonly error: Error | undefined; readonly onRetry: () => void }): JSX.Element | null {
  if (error) return null;
  if (!data) return <Alert color="gray" variant="light" title="Checking the ledger…">Loading the reconciliation checks.</Alert>;
  const { report, error: ledgerError } = data.ledger;
  if (ledgerError || !report) {
    return (
      <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Ledger checks not available" aria-live="polite">
        {ledgerError ?? 'The ledger did not answer.'} The remittances below still show the payment files; their posting totals are missing.{' '}
        <Button size="xs" variant="white" color="red" onClick={onRetry}>
          Try again
        </Button>
      </Alert>
    );
  }
  const failing = report.checks.filter((c) => !c.ok);
  if (failing.length === 0) {
    return (
      <Alert color="green" variant="light" icon={<IconCircleCheck size={18} />} title={`All ${report.checks.length} ledger checks pass`} aria-live="polite">
        The ledger balances, the receivables tie to the accounts, and every remittance has posted its cash.
      </Alert>
    );
  }
  return (
    <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={`${failing.length} ledger check${failing.length === 1 ? '' : 's'} not passing`} aria-live="polite">
      <List size="sm" spacing={2}>
        {failing.map((c) => (
          <List.Item key={c.label}>
            {c.label}
            {c.expectedCents !== undefined && c.actualCents !== undefined ? `: expected ${formatCents(c.expectedCents)}, found ${formatCents(c.actualCents)}` : ''}
          </List.Item>
        ))}
      </List>
    </Alert>
  );
}

/** Whether the payer's total equals the cash posted under the trace. Text and an icon, not colour alone. */
function PostingBadge({ row }: { readonly row: RemitRow }): JSX.Element {
  if (!row.ledger) {
    return (
      <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
        Not in ledger
      </Badge>
    );
  }
  const diff = row.ledger.paidCents - row.ledger.postedCashCents;
  if (diff === 0) {
    return (
      <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
        Reconciled
      </Badge>
    );
  }
  if (diff > 0) {
    return (
      <Badge color="orange" variant="light" leftSection={<IconClock size={12} />} className="tm-num">
        {diff} cents unposted
      </Badge>
    );
  }
  return (
    <Badge color="red" variant="light" leftSection={<IconCircleX size={12} />} className="tm-num">
      {-diff} cents over-posted
    </Badge>
  );
}

function RemittanceDrawer({ row, payers, onClose }: { readonly row: RemitRow; readonly payers: readonly PayerConfig[]; readonly onClose: () => void }): JSX.Element {
  const medplum = useMedplum();
  const detail = useLoader(() => loadRemitDetail(medplum, row.pr), [medplum, row.pr.id]);
  const claims: Claim[] = detail.data?.claims ?? [];
  const responses = detail.data?.responses ?? [];
  const eft = row.ledger?.paidCents ?? row.eftCents;
  return (
    <Drawer opened onClose={onClose} position="right" size="xl" title={<Text fw={650}>{`Remittance ${row.trace}`}</Text>}>
      <Stack gap="md">
        <Group gap="xs" wrap="wrap">
          <PostingBadge row={row} />
          <Text size="sm" c="dimmed" className="tm-num">
            {formatDate(row.paymentDate)} · {payerName(row.ledger?.payerRef, payers).text}
          </Text>
        </Group>
        <Group gap="xl" wrap="wrap">
          <Stack gap={2}>
            <Text size="xs" c="dimmed">Payer total</Text>
            <Text fw={650} className="tm-num">{formatCents(eft)}</Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">Cash posted</Text>
            <Text fw={650} className="tm-num">{row.ledger ? formatCents(row.ledger.postedCashCents) : 'Not in ledger'}</Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">Journals</Text>
            <Text fw={650} className="tm-num">{row.ledger?.journalCount ?? '—'}</Text>
          </Stack>
        </Group>

        {detail.error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Claims not loaded">
            {detail.error.message}
          </Alert>
        )}
        {claims.length === 0 && !detail.loading && <Text size="sm" c="dimmed">No claim in this file matched one of ours; it is in exceptions.</Text>}

        {claims.length > 0 && (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="sm" aria-label="Claims in this remittance">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Claim</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th ta="right">Paid</Table.Th>
                  <Table.Th>Responses</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {claims.map((c) => {
                  const ref = `Claim/${c.id}`;
                  const paid = row.pr.detail?.find((d) => d.request?.reference === ref)?.amount?.value;
                  const mine = responses.filter((r) => r.request?.reference === ref);
                  return (
                    <Table.Tr key={c.id}>
                      <Table.Td className="tm-num">{c.id?.slice(0, 8)}</Table.Td>
                      <Table.Td>
                        <ClaimStatusBadge status={claimStatusOf(c)} />
                      </Table.Td>
                      <Table.Td ta="right" className="tm-num">
                        {paid === undefined ? '—' : formatCents(Math.round(paid * 100))}
                      </Table.Td>
                      <Table.Td>
                        {mine.length === 0 ? (
                          <Text size="sm" c="dimmed">
                            None recorded
                          </Text>
                        ) : (
                          <Stack gap={2}>
                            {mine.map((r) => (
                              <Text key={r.id} size="xs">
                                <span className="tm-num">{formatDate(r.created?.slice(0, 10))}</span> · {r.disposition ?? r.outcome ?? 'Response'}
                              </Text>
                            ))}
                          </Stack>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Drawer>
  );
}

/** One exception: why it stopped, the claim, the 835's line, and the manual post or a close with reason. */
function ExceptionDrawer({ row, payers, onClose, onChanged }: { readonly row: ExceptionRow; readonly payers: readonly PayerConfig[]; readonly onClose: () => void; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const ctx = useLoader(() => exceptionContext(medplum, row.task), [medplum, row.task.id, row.task.meta?.versionId]);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const taskId = row.task.id ?? '';

  const closeWithReason = async (reason: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await setTaskState(medplum, taskId, (t) => cancelledTask(t, reason));
      notifications.show({ color: 'brand', message: 'Exception closed with its reason.' });
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const c: ExceptionContext | undefined = ctx.data;
  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={<Text fw={650}>{`Exception · ${patientName(row.patient)}`}</Text>}>
      <Stack gap="md">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Why it did not post">
          {row.task.description ?? 'The payment could not be posted automatically.'}
        </Alert>
        <Text size="sm" c="dimmed" className="tm-num">
          Trace {row.trace ?? '—'} · patient control number {row.patientControlNumber ?? '—'}
        </Text>

        {ctx.loading && !c && <Text size="sm" c="dimmed">Reading the claim and the stored 835…</Text>}
        {ctx.error && (
          <Alert color="red" variant="light" title="Not loaded">
            {ctx.error.message}
          </Alert>
        )}

        {c && (
          <>
            {c.remitNote && (
              <Alert color="orange" variant="light" icon={<IconInfoCircle size={18} />} title="Stored 835">
                {c.remitNote}
              </Alert>
            )}
            {c.claim ? (
              <Group gap="xs" wrap="wrap">
                <Text size="sm">Our claim</Text>
                <ClaimStatusBadge status={claimStatusOf(c.claim)} />
                <Text size="sm" c="dimmed" className="tm-num">
                  {c.claim.id?.slice(0, 8)} · {payerName(payerOfClaim(c.claim), payers).text}
                </Text>
              </Group>
            ) : (
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="No claim matches">
                No claim has the patient control number {c.patientControlNumber ?? '(none)'}, so the payment cannot be posted by hand. Close the exception with a reason.
              </Alert>
            )}
            {c.remit && <RemitLine remit={c.remit} />}
            {c.claim && c.trace && (
              <PostByHand
                task={row.task}
                claim={c.claim}
                trace={c.trace}
                remit={c.remit}
                onDone={(message) => {
                  notifications.show({ color: 'brand', message });
                  onChanged();
                  onClose();
                }}
              />
            )}
          </>
        )}

        {error && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not saved">
            {error}
          </Alert>
        )}
        <Group gap="xs">
          <Button variant="subtle" color="red" disabled={busy} onClick={() => setClosing(true)}>
            Close with reason…
          </Button>
        </Group>
      </Stack>

      {closing && (
        <CloseReasonModal
          opened
          title="Close exception without posting"
          label="Why is this payment not posted here?"
          onClose={() => setClosing(false)}
          onConfirm={(reason) => {
            setClosing(false);
            void closeWithReason(reason);
          }}
        />
      )}
    </Drawer>
  );
}

function RemitLine({ remit }: { readonly remit: RemitClaim }): JSX.Element {
  const contractual = remit.adjustments.filter((a) => a.group === 'CO' || a.group === 'OA' || a.group === 'PI').reduce((s, a) => s + a.cents, 0);
  return (
    <Card withBorder padding="sm">
      <Text size="sm" fw={600} mb={4}>
        On the 835 for this claim
      </Text>
      <Text size="sm" className="tm-num">
        Payer control {remit.payerClaimControl} · paid {formatCents(remit.paidCents)} · contractual {formatCents(contractual)} · patient share {formatCents(remit.patientResponsibilityCents)}
      </Text>
      {remit.adjustments.length > 0 && (
        <Text size="xs" c="dimmed" className="tm-num" mt={4}>
          Adjustments: {remit.adjustments.map((a) => `${a.group}-${a.reason} ${formatCents(a.cents)}`).join(' · ')}
        </Text>
      )}
    </Card>
  );
}

const centsText = (cents: number): string => (cents / 100).toFixed(2);

/**
 * Posts one claim of the 835 by hand. The form starts from the stored 835 when it has the claim;
 * otherwise the amounts are typed from the remittance. Two steps, like every posting in the ledger.
 */
function PostByHand({
  task,
  claim,
  trace,
  remit,
  onDone,
}: {
  readonly task: Task;
  readonly claim: Claim;
  readonly trace: string;
  readonly remit: RemitClaim | undefined;
  readonly onDone: (message: string) => void;
}): JSX.Element {
  const medplum = useMedplum();
  const [payerClaimControl, setPayerClaimControl] = useState(remit?.payerClaimControl ?? '');
  const [paidText, setPaidText] = useState(remit ? centsText(remit.paidCents) : '');
  const [contractualText, setContractualText] = useState(
    remit ? centsText(remit.adjustments.filter((a) => a.group === 'CO' || a.group === 'OA' || a.group === 'PI').reduce((s, a) => s + a.cents, 0)) : ''
  );
  const [patientText, setPatientText] = useState(remit ? centsText(remit.patientResponsibilityCents) : '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const paid = parseDollars(paidText);
  const contractual = parseDollars(contractualText);
  const patient = parseDollars(patientText);
  const pcc = payerClaimControl.trim();
  const amountsOk = [paid, contractual, patient].every((v) => v !== undefined && v >= 0);
  const valid = amountsOk && pcc.length > 0 && pcc.length <= 80 && claim.patient?.reference !== undefined;
  const total = (paid ?? 0) + (contractual ?? 0) + (patient ?? 0);
  const patientRef = claim.patient?.reference ?? '';
  const encounterRef = visitOf(claim);
  const claimRef = `Claim/${claim.id}`;

  const submit = async (): Promise<void> => {
    if (paid === undefined || contractual === undefined || patient === undefined) return;
    setBusy(true);
    setError(undefined);
    let posted: boolean;
    try {
      const results = await ledgerApi.postRemittanceClaim(medplum, trace, {
        payerClaimControl: pcc,
        claimRef,
        patientRef,
        paidCents: paid,
        contractualCents: contractual,
        patientResponsibilityCents: patient,
        encounterRef,
        occurredAt: new Date().toISOString(),
      });
      posted = results.some((r) => r.created);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    // The posting is recorded (or was already); now close the exception with a note on what was done.
    try {
      const note = `Posted by hand from trace ${trace}: claim ${claim.id?.slice(0, 8)}, payer control ${pcc}, paid ${formatCents(paid)}, contractual ${formatCents(contractual)}, patient share ${formatCents(patient)}.`;
      await setTaskState(medplum, task.id ?? '', (t) => completedTask(t, note));
      onDone(posted ? 'Posted by hand. The exception is complete.' : 'This claim was already posted; nothing changed. The exception is complete.');
    } catch (err) {
      setError(`The payment is posted, but the exception could not be completed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder padding="md">
      <Text fw={650} mb="sm">
        Post this claim by hand
      </Text>
      {!confirming ? (
        <Stack gap="sm">
          {!remit && (
            <Alert color="gray" variant="light" title="Type the amounts from the remittance">
              The stored 835 did not give this claim&apos;s amounts. Copy them from the payment file.
            </Alert>
          )}
          <TextInput label="Payer claim control number" description="From the 835 (CLP07). Posting the same one twice does nothing." value={payerClaimControl} onChange={(e) => setPayerClaimControl(e.currentTarget.value)} required />
          <Group grow align="flex-start">
            <TextInput label="Paid" leftSection="$" inputMode="decimal" value={paidText} onChange={(e) => setPaidText(e.currentTarget.value)} error={paidText && paid === undefined ? 'Use dollars and cents.' : undefined} styles={{ input: { fontVariantNumeric: 'tabular-nums' } }} required />
            <TextInput label="Contractual" description="Payer write-down (CO, OA, PI)" leftSection="$" inputMode="decimal" value={contractualText} onChange={(e) => setContractualText(e.currentTarget.value)} error={contractualText && contractual === undefined ? 'Use dollars and cents.' : undefined} styles={{ input: { fontVariantNumeric: 'tabular-nums' } }} required />
            <TextInput label="Patient share" description="Patient responsibility (PR)" leftSection="$" inputMode="decimal" value={patientText} onChange={(e) => setPatientText(e.currentTarget.value)} error={patientText && patient === undefined ? 'Use dollars and cents.' : undefined} styles={{ input: { fontVariantNumeric: 'tabular-nums' } }} required />
          </Group>
          <Text size="xs" c="dimmed">
            Claim {claim.id?.slice(0, 8)} · total {formatCents(total)}. The server checks the claim and the amounts again when you post.
          </Text>
          <Group justify="flex-end">
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              Review posting
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
          confirmLabel={`Post ${formatCents(total)}`}
          summary={
            <Text size="sm">
              Post claim {claim.id?.slice(0, 8)} from trace {trace}: paid {formatCents(paid ?? 0)}, contractual {formatCents(contractual ?? 0)}, patient share {formatCents(patient ?? 0)}. The payer&apos;s
              receivable on this claim goes down by {formatCents(total)}. This can only be undone by a reversal.
            </Text>
          }
        />
      )}
      {!confirming && error && (
        <Alert color="red" variant="light" mt="sm" title="Not posted">
          {error}
        </Alert>
      )}
    </Card>
  );
}
