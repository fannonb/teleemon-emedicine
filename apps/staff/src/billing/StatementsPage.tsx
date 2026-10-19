import { Alert, Anchor, Badge, Button, Group, Paper, Stack, Table, Tabs, Text } from '@mantine/core';
import type { MedplumClient } from '@medplum/core';
import type { Address, Invoice, Organization, Patient, Task } from '@medplum/fhirtypes';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconPlayerPlay, IconPrinter, IconReceipt } from '@tabler/icons-react';
import type { BillingPolicy, BillingSettings } from '@teleemon/core';
import { BILLING_TASKS, CODE_SYSTEMS, OPEN_TASK_STATUS_PARAM, PRACTICE_ORG_TYPE, formatCents, moneyCents, readSettings, teamCoding, zonedDate } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { patientName } from '../fhir/patient';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { CloseReasonModal } from '../inbox/TaskDrawer';
import { formatDate } from '../utils/format';
import { ConfirmStep, ModalShell } from './billingUi';
import { cancelledTask, errorMessage, idOf, patientsByRef, setTaskState, taskCodeParam } from './billingShared';

// P35 Statements: start a statement run (the worker issues the statements and opens the review tasks),
// list the statements issued, print one, and close the refund and small-balance reviews with a reason.

const LIST_LIMIT = 100;

// --- Statement run and policy -------------------------------------------------------------------

interface RunData {
  /** The run the worker has not finished yet, if any. */
  readonly open?: Task;
  /** The most recent finished run, whose result note the worker wrote. */
  readonly last?: Task;
  readonly settings: BillingSettings;
}

async function loadRuns(medplum: MedplumClient): Promise<RunData> {
  const code = taskCodeParam(BILLING_TASKS.statementRun);
  const [openRuns, lastRuns, settings] = await Promise.all([
    medplum.searchResources('Task', new URLSearchParams([['code', code], ['status', 'requested,in-progress'], ['_count', '5']]), { cache: 'no-cache' }),
    medplum.searchResources('Task', new URLSearchParams([['code', code], ['status', 'completed'], ['_sort', '-_lastUpdated'], ['_count', '1']]), { cache: 'no-cache' }),
    readSettings(medplum, 'billing'),
  ]);
  return { open: openRuns[0], last: lastRuns[0], settings };
}

/** A run Task for the worker. Team biller; the worker takes every requested run on its next pass. */
function statementRunTask(now: Date): Task {
  return {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: BILLING_TASKS.statementRun }], text: 'Run patient statements' },
    description: 'Issue statements for balances that are due, post the portal notices and open the credit and small-balance reviews.',
    performerType: teamCoding('biller'),
    authoredOn: now.toISOString(),
  };
}

function RunPanel(): JSX.Element {
  const medplum = useMedplum();
  const data = useLoader(() => loadRuns(medplum), [medplum]);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  // One open run at a time. The conditional create checks for an open run on the server as well.
  const start = async (): Promise<void> => {
    setStarting(true);
    setError(undefined);
    try {
      await medplum.createResourceIfNoneExist(statementRunTask(new Date()), new URLSearchParams([['code', taskCodeParam(BILLING_TASKS.statementRun)], ['status', 'requested,in-progress']]).toString());
      notifications.show({ color: 'brand', message: 'Statement run requested. The worker takes it on its next pass.' });
      setConfirming(false);
      data.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Section loaded={data} title="Statement run" padding="lg" rows={3}>
      {({ open, last, settings }) => {
        const lastNote = last?.note?.[last.note.length - 1]?.text;
        const policy = settings.policy;
        return (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              A run issues a statement for each patient whose balance meets the statement minimum and whose last statement is older than the cycle. Each
              statement is announced with a portal notice that carries no amounts. Credits held long enough and small balances are added to the review queues below.
            </Text>

            {open ? (
              <Alert color="indigo" variant="light" icon={<IconInfoCircle size={18} />} title={open.status === 'in-progress' ? 'Run in progress' : 'Run requested'}>
                Requested {formatDate(zonedDate(new Date(open.authoredOn ?? open.meta?.lastUpdated ?? Date.now())))}. Its result appears here when the worker finishes it.
              </Alert>
            ) : last ? (
              <Text size="sm">
                Last run finished {formatDate(zonedDate(new Date(last.meta?.lastUpdated ?? Date.now())))}
                {lastNote ? `: ${lastNote}` : '.'}
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                No statement run yet.
              </Text>
            )}

            <Group gap="sm" align="center">
              <Button leftSection={<IconPlayerPlay size={16} />} disabled={!!open || starting} onClick={() => setConfirming(true)}>
                Run statements now…
              </Button>
              {open && (
                <Text size="xs" c="dimmed">
                  Wait for the open run to finish before starting another.
                </Text>
              )}
            </Group>

            <PolicyBlock policy={policy} />

            {confirming && (
              <ModalShell title="Run statements now" onClose={() => setConfirming(false)} busy={starting}>
                <ConfirmStep
                  busy={starting}
                  error={error}
                  color="indigo"
                  onBack={() => setConfirming(false)}
                  onConfirm={start}
                  confirmLabel="Request run"
                  summary={
                    <Text size="sm">
                      Statements are issued as soon as the worker runs, using the placeholder policy below. A balance of at least {formatCents(policy.statementMinimumCents)} whose
                      last statement is {policy.statementCycleDays} or more days old (or that has none) gets one. Credit held {policy.refundReviewAfterDays} days or more, and
                      small balances, are added to the review queues.
                    </Text>
                  }
                />
              </ModalShell>
            )}
          </Stack>
        );
      }}
    </Section>
  );
}

function PolicyBlock({ policy }: { readonly policy: BillingPolicy }): JSX.Element {
  return (
    <Stack gap="sm">
      <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="Placeholder until the practice decides">
        These values are defaults for testing. The practice and its billing advisor must confirm them before any real claim or statement is sent.
      </Alert>
      <Group gap="xl" wrap="wrap">
        <PolicyValue label="Statement minimum" value={formatCents(policy.statementMinimumCents)} />
        <PolicyValue label="Statement cycle" value={`${policy.statementCycleDays} days`} />
        <PolicyValue label="Refund review after" value={`${policy.refundReviewAfterDays} days`} />
      </Group>
      <Anchor component={Link} to="/settings/payers" size="sm">
        Change these in Payers, fees &amp; codes (P40)
      </Anchor>
    </Stack>
  );
}

function PolicyValue({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={650} className="tm-num">
        {value}
      </Text>
    </Stack>
  );
}

// --- Issued statements --------------------------------------------------------------------------

interface InvoiceData {
  readonly invoices: readonly Invoice[];
  readonly patients: ReadonlyMap<string, Patient>;
  readonly practice?: Organization;
}

async function loadInvoices(medplum: MedplumClient, status: 'draft' | 'issued'): Promise<InvoiceData> {
  const [invoices, practice] = await Promise.all([
    medplum.searchResources('Invoice', new URLSearchParams([['status', status], ['_sort', '-date'], ['_count', String(LIST_LIMIT)]]), { cache: 'no-cache' }),
    medplum.searchOne('Organization', { type: PRACTICE_ORG_TYPE, active: 'true' }, { cache: 'no-cache' }),
  ]);
  const patients = await patientsByRef(
    medplum,
    invoices.map((i) => i.subject?.reference)
  );
  return { invoices, patients, practice: practice ?? undefined };
}

/** Everything a statement shows, already in display form. */
interface StatementView {
  readonly practice?: { readonly name: string; readonly lines: readonly string[] };
  readonly patient: string;
  readonly patientLines: readonly string[];
  readonly date: string;
  readonly lines: readonly { readonly date: string; readonly description: string; readonly cents?: number }[];
  readonly amountDueCents?: number;
}

function addressLines(a: Address | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [...(a.line ?? []), cityLine].filter((l) => l.length > 0);
}

function statementView(inv: Invoice, patient: Patient | undefined, practice: Organization | undefined): StatementView {
  const home = patient?.address?.find((a) => a.use === 'home') ?? patient?.address?.[0];
  return {
    practice: practice ? { name: practice.name ?? 'Practice', lines: addressLines(practice.address?.[0]) } : undefined,
    patient: patient ? patientName(patient) : 'Unknown patient',
    patientLines: addressLines(home),
    date: inv.date ? formatDate(zonedDate(new Date(inv.date))) : '—',
    lines: (inv.lineItem ?? []).map((li) => {
      const text = li.chargeItemCodeableConcept?.text ?? '';
      const m = /^(\d{4}-\d{2}-\d{2}) (.*)$/s.exec(text);
      return { date: m ? formatDate(m[1]) : '', description: m ? (m[2] ?? '') : text, cents: moneyCents(li.priceComponent?.[0]?.amount) };
    }),
    amountDueCents: moneyCents(inv.totalNet),
  };
}

const money = (cents: number | undefined): string => (cents === undefined ? '—' : formatCents(cents));

/**
 * A run creates draft statements; nothing reaches the patient until a biller reviews and issues
 * one here. Issuing makes it visible in the portal and the worker sends the "new statement" notice.
 */
function InvoicePanel({ status }: { readonly status: 'draft' | 'issued' }): JSX.Element {
  const medplum = useMedplum();
  const data = useLoader(() => loadInvoices(medplum, status), [medplum, status]);
  const [viewing, setViewing] = useState<Invoice>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const review = status === 'draft';

  const decide = async (inv: Invoice, to: 'issued' | 'cancelled'): Promise<void> => {
    setBusy(inv.id);
    setError(undefined);
    try {
      // If-Match on the version read for this row: two billers cannot issue or void the same
      // statement from stale copies (the second gets a 412 instead of overwriting the first).
      await medplum.updateResource<Invoice>(
        {
          ...inv,
          status: to,
          ...(to === 'issued' ? { date: new Date().toISOString() } : { cancelledReason: 'Voided at review: not sent to the patient' }),
        },
        { headers: { 'If-Match': `W/"${inv.meta?.versionId}"` } }
      );
      data.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Section
      loaded={data}
      title={review ? 'Statements to review' : 'Statements issued'}
      padding="lg"
      rows={review ? 3 : 6}
      isEmpty={(d) => d.invoices.length === 0}
      empty={{
        icon: <IconReceipt size={22} />,
        title: review ? 'Nothing to review' : 'No statements issued yet',
        text: review ? 'A statement run creates drafts here. Check each one, then issue it to the patient or void it.' : 'Statements you issue are listed here with their lines and the amount due.',
      }}
    >
      {({ invoices, patients, practice }) => (
        <Stack gap="sm">
          {error && (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          )}
          {invoices.length >= LIST_LIMIT && (
            <Text size="xs" c="dimmed">
              Showing the latest {LIST_LIMIT} statements.
            </Text>
          )}
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover aria-label={review ? 'Statements to review' : 'Issued statements'}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{review ? 'Prepared' : 'Issued'}</Table.Th>
                  <Table.Th>Patient</Table.Th>
                  <Table.Th ta="right">Amount due</Table.Th>
                  <Table.Th ta="right">Lines</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invoices.map((inv) => {
                  const patient = inv.subject?.reference ? patients.get(inv.subject.reference) : undefined;
                  const name = patient ? patientName(patient) : 'Unknown patient';
                  return (
                    <Table.Tr key={inv.id}>
                      <Table.Td className="tm-num">
                        <Text size="sm">{inv.date ? formatDate(zonedDate(new Date(inv.date))) : '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>
                          {name}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" className="tm-num">
                        <Text size="sm" fw={600}>
                          {money(moneyCents(inv.totalNet))}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" className="tm-num">
                        <Text size="sm">{inv.lineItem?.length ?? 0}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button size="xs" variant="default" onClick={() => setViewing(inv)} aria-label={`View statement for ${name}`}>
                            View
                          </Button>
                          {review && (
                            <>
                              <Button size="xs" loading={busy === inv.id} onClick={() => void decide(inv, 'issued')} aria-label={`Issue statement to ${name}`}>
                                Issue
                              </Button>
                              <Button size="xs" variant="subtle" color="red" disabled={busy === inv.id} onClick={() => void decide(inv, 'cancelled')} aria-label={`Void statement for ${name}`}>
                                Void
                              </Button>
                            </>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {viewing && (
            <StatementDialog
              view={statementView(viewing, viewing.subject?.reference ? patients.get(viewing.subject.reference) : undefined, practice)}
              onClose={() => setViewing(undefined)}
            />
          )}
        </Stack>
      )}
    </Section>
  );
}

/** The statement on screen, with a print button that opens a clean print page. */
function StatementDialog({ view, onClose }: { readonly view: StatementView; readonly onClose: () => void }): JSX.Element {
  return (
    <ModalShell title="Patient statement" onClose={onClose} size="lg">
      <Stack gap="md">
        <Paper withBorder p="lg" radius="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap" mb="md">
            <div>
              {view.practice ? (
                <>
                  <Text fw={650}>{view.practice.name}</Text>
                  {view.practice.lines.map((l) => (
                    <Text key={l} size="sm" c="dimmed">
                      {l}
                    </Text>
                  ))}
                </>
              ) : (
                <Text size="sm" c="orange">
                  Practice name not set. Add it in Practice &amp; locations (P38) before printing.
                </Text>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <Text fw={650}>Statement</Text>
              <Text size="sm" className="tm-num">
                {view.date}
              </Text>
            </div>
          </Group>

          <Text fw={600}>{view.patient}</Text>
          {view.patientLines.map((l) => (
            <Text key={l} size="sm" c="dimmed">
              {l}
            </Text>
          ))}

          <Table.ScrollContainer minWidth={420} mt="md">
            <Table verticalSpacing="xs" withRowBorders aria-label="Statement lines">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Description</Table.Th>
                  <Table.Th ta="right">Amount</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {view.lines.map((l, i) => (
                  <Table.Tr key={`${i}-${l.date}-${l.description}`}>
                    <Table.Td className="tm-num">
                      <Text size="sm">{l.date}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{l.description}</Text>
                    </Table.Td>
                    <Table.Td ta="right" className="tm-num">
                      <Text size="sm">{money(l.cents)}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          <Group justify="flex-end" mt="md" gap="sm">
            <Text fw={650}>
              Amount due <span className="tm-num">{money(view.amountDueCents)}</span>
            </Text>
          </Group>
          <Text size="sm" mt="xs">
            Pay online in your patient portal.
          </Text>
        </Paper>

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button leftSection={<IconPrinter size={16} />} onClick={() => printStatement(view)}>
            Print
          </Button>
        </Group>
      </Stack>
    </ModalShell>
  );
}

/** Prints a statement in a new window. Nothing is sent to any service. */
function printStatement(v: StatementView): void {
  const w = window.open('', '_blank', 'width=780,height=900');
  if (!w) return;
  const esc = (s: string | undefined): string => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const addr = (lines: readonly string[]): string => lines.map((l) => `<div>${esc(l)}</div>`).join('');
  const rows = v.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.description)}</td><td class="num">${esc(money(l.cents))}</td></tr>`).join('');
  const practice = v.practice ? `<b>${esc(v.practice.name)}</b>${addr(v.practice.lines)}` : '<b>Practice name not set</b>';
  w.document.write(`<!doctype html><html><head><title>Statement</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border-bottom:1px solid #bbb;padding:6px;text-align:left;font-size:13px}th{border-bottom:2px solid #111}.num{text-align:right;font-variant-numeric:tabular-nums}.head{display:flex;justify-content:space-between;gap:24px}.right{text-align:right}.due{font-size:16px;margin-top:20px;text-align:right}</style></head><body>
    <div class="head"><div>${practice}</div><div class="right"><b>Statement</b><div>${esc(v.date)}</div></div></div>
    <div style="margin-top:28px"><b>${esc(v.patient)}</b>${addr(v.patientLines)}</div>
    <table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="due">Amount due: <b>${esc(money(v.amountDueCents))}</b></p>
    <p>Pay online in your patient portal.</p>
    <script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
}

// --- Review queues ------------------------------------------------------------------------------

interface QueueRow {
  readonly task: Task;
  readonly patient?: Patient;
}

interface QueueData {
  readonly refunds: readonly QueueRow[];
  readonly smalls: readonly QueueRow[];
}

const openReviews = (medplum: MedplumClient, code: string): Promise<Task[]> =>
  medplum.searchResources('Task', new URLSearchParams([['code', taskCodeParam(code)], ['status', OPEN_TASK_STATUS_PARAM], ['_count', '200']]), { cache: 'no-cache' });

async function loadQueues(medplum: MedplumClient): Promise<QueueData> {
  const [refundTasks, smallTasks] = await Promise.all([openReviews(medplum, BILLING_TASKS.refundReview), openReviews(medplum, BILLING_TASKS.smallBalance)]);
  const patients = await patientsByRef(
    medplum,
    [...refundTasks, ...smallTasks].map((t) => t.for?.reference)
  );
  const rows = (tasks: Task[]): QueueRow[] =>
    [...tasks]
      .sort((a, b) => (a.authoredOn ?? '').localeCompare(b.authoredOn ?? ''))
      .map((task) => ({ task, patient: task.for?.reference ? patients.get(task.for.reference) : undefined }));
  return { refunds: rows(refundTasks), smalls: rows(smallTasks) };
}

function QueuePanel(): JSX.Element {
  const medplum = useMedplum();
  const data = useLoader(() => loadQueues(medplum), [medplum]);
  const [tab, setTab] = useState<'refunds' | 'smalls'>('refunds');
  const [closing, setClosing] = useState<Task>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = async (task: Task, reason: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await setTaskState(medplum, task.id ?? '', (t) => cancelledTask(t, reason));
      notifications.show({ color: 'brand', message: 'Review closed with its reason.' });
      data.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setClosing(undefined);
    }
  };

  return (
    <Section
      loaded={data}
      title="Review queues"
      padding="lg"
      rows={5}
      isEmpty={(d) => d.refunds.length === 0 && d.smalls.length === 0}
      empty={{
        icon: <IconCircleCheck size={22} />,
        title: 'Nothing to review',
        text: 'Credits held for a long time and small balances appear here when a statement run finds them.',
      }}
    >
      {({ refunds, smalls }) => (
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Not closed">
              {error}
            </Alert>
          )}
          <Tabs value={tab} onChange={(v) => v && setTab(v as 'refunds' | 'smalls')}>
            <Tabs.List mb="md">
              <Tabs.Tab value="refunds">
                Credit to review{' '}
                <Text span size="xs" c="dimmed" className="tm-num">
                  {refunds.length}
                </Text>
              </Tabs.Tab>
              <Tabs.Tab value="smalls">
                Small balances{' '}
                <Text span size="xs" c="dimmed" className="tm-num">
                  {smalls.length}
                </Text>
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="refunds">
              <QueueTable
                rows={refunds}
                empty="No credit is waiting for a refund decision."
                busy={busy}
                onClose={setClosing}
                hint="Approve or mark refunds on the patient's Account tab."
                accountLabel="Refunds"
              />
            </Tabs.Panel>
            <Tabs.Panel value="smalls">
              <QueueTable
                rows={smalls}
                empty="No small balances are waiting for a decision."
                busy={busy}
                onClose={setClosing}
                hint="A write-off of a small balance is posted on the patient's Account tab."
                accountLabel="Write-off"
              />
            </Tabs.Panel>
          </Tabs>

          {closing && (
            <CloseReasonModal
              opened
              title="Close review with a reason"
              label="Why is this review closed?"
              onClose={() => setClosing(undefined)}
              onConfirm={(reason) => void close(closing, reason)}
            />
          )}
        </Stack>
      )}
    </Section>
  );
}

function QueueTable({
  rows,
  empty,
  busy,
  hint,
  accountLabel,
  onClose,
}: {
  readonly rows: readonly QueueRow[];
  readonly empty: string;
  readonly busy: boolean;
  readonly hint: string;
  readonly accountLabel: string;
  readonly onClose: (task: Task) => void;
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {empty}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        {hint}
      </Text>
      <Table.ScrollContainer minWidth={840}>
        <Table verticalSpacing="sm" highlightOnHover aria-label={`${accountLabel} reviews`}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Patient</Table.Th>
              <Table.Th>Raised</Table.Th>
              <Table.Th>Why it is here</Table.Th>
              <Table.Th>Account</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map(({ task, patient }) => {
              const name = patient ? patientName(patient) : 'Unknown patient';
              const patientId = idOf(task.for?.reference);
              const lastNote = task.note?.[task.note.length - 1]?.text;
              return (
                <Table.Tr key={task.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {name}
                    </Text>
                    <Badge variant="outline" color="gray" size="xs" className="tm-num">
                      {task.id?.slice(0, 8)}
                    </Badge>
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{task.authoredOn ? formatDate(zonedDate(new Date(task.authoredOn))) : '—'}</Text>
                  </Table.Td>
                  <Table.Td maw={380}>
                    <Text size="sm">{task.description ?? task.code?.text ?? '—'}</Text>
                    {lastNote && (
                      <Text size="xs" c="dimmed">
                        {lastNote}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {patientId ? (
                      <Anchor component={Link} to={`/patients/${patientId}/account`} size="sm">
                        {accountLabel}: open account
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        No patient
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button size="xs" variant="default" disabled={busy} onClick={() => onClose(task)} aria-label={`Close review for ${name}`}>
                      Close with reason…
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

export function StatementsPage(): JSX.Element {
  return (
    <PageBody wide>
      <PageHeader eyebrow="P35 · Billing" title="Statements" subtitle="Patient statements, the statement run and the reviews it opens. Patients pay online in their portal." />
      <Stack gap="lg">
        <RunPanel />
        <InvoicePanel status="draft" />
        <InvoicePanel status="issued" />
        <QueuePanel />
      </Stack>
    </PageBody>
  );
}
