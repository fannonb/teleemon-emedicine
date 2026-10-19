import { Badge, Button, Card, Checkbox, Group, Stack, Table, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconInbox, IconSend } from '@tabler/icons-react';
import type { PayerConfig } from '@teleemon/core';
import { formatCents, scrubCurrentAndClean } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { formatDate } from '../utils/format';
import { ClaimStatusBadge, ConfirmStep, ModalShell, ScrubBadge } from './billingUi';
import { CreateClaimModal } from './CreateClaimModal';
import { ClaimDrawer } from './ClaimDrawer';
import { errorMessage } from './billingShared';
import { payerName } from './charges';
import type { ClaimRow, VisitPlan, WorkTab } from './claimWork';
import { WORK_TABS, claimTotalCents, clearinghouseIdOf, loadClaimsWork, moveClaim, payerOfClaim } from './claimWork';

// P31 Claims workbench: every claim by work status, the visits ready to bill, and the bulk scrub
// and submit. Payer results never appear here as a choice; they come from the worker.

const EMPTY: Record<WorkTab, { title: string; text: string }> = {
  ready: { title: 'No visits waiting to be billed', text: 'A visit appears here once its charges are released in charge review and it has no claim yet.' },
  draft: { title: 'No draft claims', text: 'New claims start here. Scrub each one before it can be submitted.' },
  scrubbed: { title: 'No scrubbed claims', text: 'A claim waits here after the server has scrubbed it, until it is submitted.' },
  submitted: { title: 'Nothing sent yet', text: 'Claims sent to the clearinghouse wait here for acknowledgements and payment.' },
  rejected: { title: 'No rejected claims', text: 'A claim the clearinghouse or payer rejected waits here to be corrected.' },
  paid: { title: 'No paid claims', text: 'Claims paid in full or in part appear here.' },
  denied: { title: 'No denied claims', text: 'Denials appear here. Their appeals are tracked on the Denials page (P34).' },
  closed: { title: 'No closed claims', text: 'Claims closed with a reason are kept here. They are never deleted.' },
};

export function ClaimsPage(): JSX.Element {
  const medplum = useMedplum();
  const [tab, setTab] = useState<WorkTab>('ready');
  const [picked, setPicked] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [visitPlan, setVisitPlan] = useState<VisitPlan>();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [working, setWorking] = useState(false);

  const data = useLoader(() => loadClaimsWork(medplum), [medplum]);
  const claims = data.data?.claims ?? [];
  const settings = data.data?.settings;
  const ready = data.data?.ready ?? [];
  const tabStatuses = WORK_TABS.find((t) => t.value === tab)?.statuses ?? [];
  const tabRows: readonly ClaimRow[] = tab === 'ready' ? [] : claims.filter((r) => tabStatuses.includes(r.status));
  const countOf = (t: WorkTab): number => (t === 'ready' ? ready.length : claims.filter((r) => (WORK_TABS.find((w) => w.value === t)?.statuses ?? []).includes(r.status)).length);

  const selectable = (r: ClaimRow): boolean => (tab === 'draft' ? true : tab === 'scrubbed' ? scrubCurrentAndClean(r.claim) : false);
  const bulkRows = tabRows.filter((r) => picked.includes(r.claim.id ?? '') && selectable(r));
  const openRow = openId ? claims.find((r) => r.claim.id === openId) : undefined;

  const changeTab = (value: WorkTab): void => {
    setTab(value);
    setPicked([]);
  };

  const togglePick = (id: string, on: boolean): void => setPicked((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  // One claim at a time: each write reads the claim fresh, and the server scrubs or refuses each one.
  const runBulk = async (to: 'scrubbed' | 'submitted'): Promise<void> => {
    setWorking(true);
    const failures: string[] = [];
    let done = 0;
    for (const row of bulkRows) {
      try {
        await moveClaim(medplum, row.claim.id ?? '', to);
        done += 1;
      } catch (err) {
        failures.push(`${patientName(row.patient)}: ${errorMessage(err)}`);
      }
    }
    setWorking(false);
    setPicked([]);
    setConfirmSubmit(false);
    data.reload();
    if (done > 0) notifications.show({ color: 'brand', title: to === 'scrubbed' ? 'Scrubbed' : 'Submitted', message: `${done} claim${done === 1 ? '' : 's'} ${to === 'scrubbed' ? 'scrubbed by the server' : 'sent to the submission queue'}.` });
    if (failures.length > 0) notifications.show({ color: 'red', title: `${failures.length} not updated`, message: failures[0], autoClose: false });
  };

  const allPicked = bulkRows.length > 0 && bulkRows.every((r) => picked.includes(r.claim.id ?? ''));

  return (
    <PageBody wide>
      <PageHeader eyebrow="P31 · Billing" title="Claims" subtitle="Scrub, submit and track insurance claims. The server checks every change; payer results come from the clearinghouse." />
      <Tabs value={tab} onChange={(v) => v && changeTab(v as WorkTab)}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap', rowGap: 6 }} aria-label="Claim work status">
          {WORK_TABS.map((t) => (
            <Tabs.Tab key={t.value} value={t.value}>
              {t.label}{' '}
              <Text span size="xs" c="dimmed" className="tm-num">
                {data.data ? countOf(t.value) : '…'}
              </Text>
            </Tabs.Tab>
          ))}
        </Tabs.List>

        <Tabs.Panel value={tab}>
          <Section
            loaded={data}
            padding="md"
            rows={6}
            isEmpty={() => (tab === 'ready' ? ready.length === 0 : tabRows.length === 0)}
            empty={{ icon: <IconInbox size={22} />, title: EMPTY[tab].title, text: EMPTY[tab].text }}
          >
            {() => (
              <Stack gap="sm">
                {(tab === 'draft' || tab === 'scrubbed') && (
                  <Group justify="space-between" p="sm" style={{ border: '1px solid var(--tm-border)', borderRadius: 8, minHeight: 52 }}>
                    <Text size="sm" aria-live="polite">
                      {bulkRows.length === 0
                        ? tab === 'scrubbed'
                          ? 'Only scrubbed claims with a clean, current scrub can be submitted in bulk.'
                          : 'Select draft claims to scrub them together.'
                        : `${bulkRows.length} selected.`}
                    </Text>
                    {bulkRows.length > 0 && (
                      <Group gap="xs">
                        <Button variant="subtle" size="xs" onClick={() => setPicked([])} disabled={working}>
                          Clear
                        </Button>
                        {tab === 'draft' ? (
                          <Button size="xs" leftSection={<IconCircleCheck size={14} />} onClick={() => runBulk('scrubbed')} loading={working}>
                            Scrub {bulkRows.length}
                          </Button>
                        ) : (
                          <Button size="xs" leftSection={<IconSend size={14} />} onClick={() => setConfirmSubmit(true)} loading={working}>
                            Submit {bulkRows.length}
                          </Button>
                        )}
                      </Group>
                    )}
                  </Group>
                )}

                {tab === 'ready' ? (
                  <ReadyTable visits={ready} payers={settings?.payers ?? []} onCreate={setVisitPlan} />
                ) : (
                  <ClaimsTable
                    rows={tabRows}
                    payers={settings?.payers ?? []}
                    selectable={selectable}
                    picked={picked}
                    allPicked={allPicked}
                    onToggle={togglePick}
                    onToggleAll={(on) => setPicked(on ? bulkRows.map((r) => r.claim.id ?? '') : [])}
                    showCheckboxes={tab === 'draft' || tab === 'scrubbed'}
                    onOpen={setOpenId}
                  />
                )}
              </Stack>
            )}
          </Section>
        </Tabs.Panel>
      </Tabs>

      {openRow && settings && (
        <ClaimDrawer
          key={`${openRow.claim.id}:${openRow.claim.meta?.versionId}`}
          row={openRow}
          settings={settings}
          onClose={() => setOpenId(undefined)}
          onChanged={() => data.reload()}
        />
      )}

      {visitPlan && settings && (
        <CreateClaimModal
          title="Create a claim"
          plan={visitPlan.plan}
          patientName={patientName(visitPlan.patient)}
          providerName={visitPlan.providerName}
          payers={settings.payers}
          onClose={() => setVisitPlan(undefined)}
          onCreated={(claim) => {
            setVisitPlan(undefined);
            setTab('draft');
            setOpenId(claim.id);
            data.reload();
          }}
        />
      )}

      {confirmSubmit && (
        <ModalShell title="Submit claims" onClose={() => setConfirmSubmit(false)} busy={working}>
          <ConfirmStep
            busy={working}
            color="indigo"
            onBack={() => setConfirmSubmit(false)}
            onConfirm={() => runBulk('submitted')}
            confirmLabel={`Submit ${bulkRows.length}`}
            summary={
              <Text size="sm">
                Send {bulkRows.length} claim{bulkRows.length === 1 ? '' : 's'} ({formatCents(bulkRows.reduce((s, r) => s + claimTotalCents(r.claim), 0))} billed) to the
                clearinghouse. A submitted claim cannot be edited; corrections go through a rejected claim or a replacement.
              </Text>
            }
          />
        </ModalShell>
      )}
    </PageBody>
  );
}

function ReadyTable({ visits, payers, onCreate }: { readonly visits: readonly VisitPlan[]; readonly payers: readonly PayerConfig[]; readonly onCreate: (v: VisitPlan) => void }): JSX.Element {
  return (
    <Card padding={0} withBorder={false}>
      <Table.ScrollContainer minWidth={1100}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Patient</Table.Th>
              <Table.Th>Service date</Table.Th>
              <Table.Th>Provider</Table.Th>
              <Table.Th>Codes</Table.Th>
              <Table.Th>Diagnoses</Table.Th>
              <Table.Th ta="right">Total</Table.Th>
              <Table.Th>Payer</Table.Th>
              <Table.Th>Readiness</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visits.map((v) => {
              const name = patientName(v.patient);
              const ok = v.plan.problems.length === 0;
              return (
                <Table.Tr key={v.visit}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {name}
                    </Text>
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{formatDate(v.plan.serviceDate)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{v.providerName ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{v.plan.lines.map((l) => (l.modifiers.length ? `${l.code}-${l.modifiers.join('-')}` : l.code)).join(', ') || '—'}</Text>
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{v.plan.diagnoses.map((d, i) => `${String.fromCharCode(65 + i)} ${d.code}`).join(', ') || 'None'}</Text>
                  </Table.Td>
                  <Table.Td ta="right" className="tm-num">
                    <Text size="sm" fw={600}>
                      {formatCents(v.plan.totalCents)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{v.plan.payer ? payerName(v.plan.payer, payers).text : 'No payer'}</Text>
                  </Table.Td>
                  <Table.Td>
                    {ok ? (
                      <Badge color="green" variant="light" leftSection={<IconCircleCheck size={12} />}>
                        Ready
                      </Badge>
                    ) : (
                      <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                        {v.plan.problems.length} to fix
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button size="xs" variant={ok ? 'filled' : 'default'} onClick={() => onCreate(v)} aria-label={`${ok ? 'Create claim' : 'See what is missing'} for ${name}`}>
                      {ok ? 'Create claim' : 'See what is missing'}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function ClaimsTable({
  rows,
  payers,
  selectable,
  picked,
  allPicked,
  onToggle,
  onToggleAll,
  showCheckboxes,
  onOpen,
}: {
  readonly rows: readonly ClaimRow[];
  readonly payers: readonly PayerConfig[];
  readonly selectable: (r: ClaimRow) => boolean;
  readonly picked: readonly string[];
  readonly allPicked: boolean;
  readonly onToggle: (id: string, on: boolean) => void;
  readonly onToggleAll: (on: boolean) => void;
  readonly showCheckboxes: boolean;
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  const selectableRows = rows.filter(selectable);
  return (
    <Card padding={0} withBorder={false}>
      <Table.ScrollContainer minWidth={1140}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {showCheckboxes && (
                <Table.Th style={{ width: 36 }}>
                  <Checkbox aria-label="Select all selectable claims" checked={allPicked} indeterminate={picked.length > 0 && !allPicked} disabled={selectableRows.length === 0} onChange={(e) => onToggleAll(e.currentTarget.checked)} />
                </Table.Th>
              )}
              <Table.Th>Patient</Table.Th>
              <Table.Th>Service date</Table.Th>
              <Table.Th>Payer</Table.Th>
              <Table.Th ta="right">Total</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Scrub</Table.Th>
              <Table.Th>Clearinghouse ID</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => {
              const id = r.claim.id ?? '';
              const name = patientName(r.patient);
              return (
                <Table.Tr key={id} onClick={() => onOpen(id)} style={{ cursor: 'pointer' }}>
                  {showCheckboxes && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox aria-label={`Select claim for ${name}`} checked={picked.includes(id)} disabled={!selectable(r)} onChange={(e) => onToggle(id, e.currentTarget.checked)} />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {name}
                    </Text>
                    <Text size="xs" c="dimmed" className="tm-num">
                      {id.slice(0, 8)}
                    </Text>
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{formatDate(r.claim.billablePeriod?.start)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{payerName(payerOfClaim(r.claim), payers).text}</Text>
                  </Table.Td>
                  <Table.Td ta="right" className="tm-num">
                    <Text size="sm" fw={600}>
                      {formatCents(claimTotalCents(r.claim))}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <ClaimStatusBadge status={r.status} />
                  </Table.Td>
                  <Table.Td>
                    <ScrubBadge claim={r.claim} />
                  </Table.Td>
                  <Table.Td className="tm-num">
                    <Text size="sm">{clearinghouseIdOf(r.claim) ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
                    <Button size="xs" variant="default" onClick={() => onOpen(id)} aria-label={`Open claim for ${name}`}>
                      Open
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
