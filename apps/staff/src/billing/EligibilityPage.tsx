import { Alert, Badge, Button, Card, Drawer, Group, List, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconClock, IconInbox, IconRefresh, IconSearch } from '@tabler/icons-react';
import type { Coverage, Patient } from '@medplum/fhirtypes';
import type { BillingSettings, PayerConfig } from '@teleemon/core';
import { payerIdOf, readSettings, suggestPayer } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { patientName } from '../fhir/patient';
import { searchPatients } from '../fhir/patientSearch';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { useRoles } from '../session/roles';
import { formatDate, formatTime } from '../utils/format';
import { errorMessage } from './billingShared';
import { checkNow, checkTomorrowsVisits, linkCoveragePayer, loadEligibility, type EligibilityRow, type EligibilityStatus } from './eligibility';
import { planNameOf } from './charges';

// P32 Eligibility: confirm coverage before visits. Results arrive from the worker, usually within a
// minute, so the list refreshes itself while any check is still waiting.

const STATUS: Record<EligibilityStatus, { label: string; color: string; icon: JSX.Element }> = {
  active: { label: 'Active', color: 'green', icon: <IconCircleCheck size={12} /> },
  inactive: { label: 'Inactive', color: 'red', icon: <IconCircleX size={12} /> },
  check: { label: 'Check', color: 'orange', icon: <IconAlertTriangle size={12} /> },
  pending: { label: 'Waiting', color: 'gray', icon: <IconClock size={12} /> },
};

function StatusBadge({ status }: { readonly status: EligibilityStatus }): JSX.Element {
  const s = STATUS[status];
  return (
    <Badge variant="light" color={s.color} leftSection={s.icon}>
      {s.label}
    </Badge>
  );
}

export function EligibilityPage(): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const canLink = roles.includes('biller') || roles.includes('provider') || roles.includes('admin');
  const [openId, setOpenId] = useState<string>();
  const [batchBusy, setBatchBusy] = useState(false);
  const [refreshMs, setRefreshMs] = useState<number>();

  const data = useLoader(() => loadEligibility(medplum), [medplum], refreshMs);
  const settings = useLoader<BillingSettings | undefined>(async () => (canLink ? readSettings(medplum, 'billing') : undefined), [medplum, canLink]);
  const rows = data.data ?? [];
  const payers = settings.data?.payers ?? [];
  const openRow = openId ? rows.find((r) => r.request.id === openId) : undefined;

  // Poll every 20 seconds only while a check is waiting for its answer.
  useEffect(() => {
    setRefreshMs((data.data ?? []).some((r) => r.status === 'pending') ? 20_000 : undefined);
  }, [data.data]);

  const runBatch = async (): Promise<void> => {
    setBatchBusy(true);
    try {
      const r = await checkTomorrowsVisits(medplum);
      notifications.show({
        color: 'brand',
        title: "Tomorrow's visits",
        message:
          r.patients === 0
            ? 'No booked visits tomorrow.'
            : `${r.requested} check${r.requested === 1 ? '' : 's'} requested for ${r.patients} patient${r.patients === 1 ? '' : 's'}. ${r.checkedRecently} already checked in the last day; ${r.noCoverage} with no active coverage.`,
        autoClose: 8000,
      });
      data.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not checked', message: errorMessage(err), autoClose: false });
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <PageBody wide>
      <PageHeader
        eyebrow="P32 · Billing"
        title="Eligibility"
        subtitle="Confirm coverage before visits. Results usually arrive within a minute of a check."
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={data.reload} disabled={data.loading}>
              Refresh
            </Button>
            <Button onClick={runBatch} loading={batchBusy}>
              Check tomorrow&apos;s visits
            </Button>
          </>
        }
      />
      <Stack gap="lg">
        <PatientCoverageCheck canLink={canLink} payers={payers} onRequested={() => data.reload()} />

        <Section
          title="Recent checks"
          loaded={data}
          padding="md"
          rows={6}
          isEmpty={(d) => d.length === 0}
          empty={{ icon: <IconInbox size={22} />, title: 'No checks yet', text: "Check a patient's coverage above, or check tomorrow's visits." }}
          actions={
            refreshMs ? (
              <Text size="xs" c="dimmed" aria-live="polite">
                Refreshing while checks wait for the payer
              </Text>
            ) : undefined
          }
        >
          {(list) => (
            <Table.ScrollContainer minWidth={960}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Requested</Table.Th>
                    <Table.Th>Patient</Table.Th>
                    <Table.Th>Payer</Table.Th>
                    <Table.Th>Why</Table.Th>
                    <Table.Th>Result</Table.Th>
                    <Table.Th>Details</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map((r) => (
                    <EligibilityTableRow key={r.request.id} row={r} onOpen={() => setOpenId(r.request.id)} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Section>
      </Stack>

      {openRow && (
        <EligibilityDrawer
          key={`${openRow.request.id}:${openRow.response?.meta?.versionId ?? ''}`}
          row={openRow}
          payers={payers}
          canLink={canLink}
          onClose={() => setOpenId(undefined)}
          onChanged={() => data.reload()}
        />
      )}
    </PageBody>
  );
}

function EligibilityTableRow({ row, onOpen }: { readonly row: EligibilityRow; readonly onOpen: () => void }): JSX.Element {
  const created = row.request.created;
  const name = patientName(row.patient);
  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer' }}>
      <Table.Td className="tm-num">
        <Text size="sm">{formatDate(created?.slice(0, 10))}</Text>
        <Text size="xs" c="dimmed">
          {formatTime(created)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={600}>
          {name}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{row.insurer ?? row.coverage?.payor?.[0]?.display ?? '—'}</Text>
      </Table.Td>
      <Table.Td>
        <Badge variant="outline" color="gray">
          {row.source === 'tomorrow' ? "Tomorrow's visit" : 'Checked now'}
        </Badge>
      </Table.Td>
      <Table.Td>
        <StatusBadge status={row.status} />
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed" lineClamp={2}>
          {row.lines.slice(0, 4).join(' · ')}
        </Text>
      </Table.Td>
      <Table.Td ta="right" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="default" onClick={onOpen} aria-label={`Open eligibility check for ${name}`}>
          Open
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

/** Find a patient, then check any of their active coverages now. */
function PatientCoverageCheck({ canLink, payers, onRequested }: { readonly canLink: boolean; readonly payers: readonly PayerConfig[]; readonly onRequested: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Patient[]>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [selected, setSelected] = useState<Patient>();
  const coverages = useLoader(
    async () => (selected?.id ? medplum.searchResources('Coverage', { beneficiary: `Patient/${selected.id}`, status: 'active', _count: '20' }, { cache: 'no-cache' }) : []),
    [medplum, selected?.id]
  );

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setSearchError(undefined);
    try {
      setResults(await searchPatients(medplum, query, 10));
    } catch (err) {
      setSearchError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card padding="md">
      <Text fw={650} mb="xs">
        Check a patient&apos;s coverage
      </Text>
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <TextInput
          label="Patient"
          placeholder="Name, date of birth, phone, MRN or member ID"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void search()}
          style={{ flex: 1 }}
        />
        <Button leftSection={<IconSearch size={16} />} onClick={search} loading={searching} disabled={query.trim().length < 2}>
          Search
        </Button>
      </Group>
      {searchError && (
        <Alert color="red" variant="light" mt="sm" title="Search failed">
          {searchError}
        </Alert>
      )}
      {results && results.length === 0 && (
        <Text size="sm" c="dimmed" mt="sm">
          No patient matches that search.
        </Text>
      )}
      {results && results.length > 0 && (
        <Group gap="xs" mt="sm" wrap="wrap" role="list" aria-label="Matching patients">
          {results.map((p) => (
            <Button key={p.id} role="listitem" size="xs" variant={selected?.id === p.id ? 'filled' : 'default'} onClick={() => setSelected(p)}>
              {patientName(p)}
              {p.birthDate ? ` · ${formatDate(p.birthDate)}` : ''}
            </Button>
          ))}
        </Group>
      )}

      {selected && (
        <Stack gap="sm" mt="md">
          <Text size="sm" fw={600}>
            {patientName(selected)}
          </Text>
          {coverages.loading && !coverages.data && <Text size="sm" c="dimmed">Loading coverage…</Text>}
          {coverages.error && (
            <Alert color="red" variant="light" title="Coverage not loaded">
              {coverages.error.message}
            </Alert>
          )}
          {coverages.data?.length === 0 && (
            <Text size="sm" c="dimmed">
              No active coverage on file for this patient. Add it in the chart&apos;s insurance tab, or mark the patient self-pay.
            </Text>
          )}
          {coverages.data?.map((cov) => (
            <CoverageCheck key={cov.id} patient={selected} coverage={cov} canLink={canLink} payers={payers} onRequested={onRequested} onLinked={() => coverages.reload()} />
          ))}
        </Stack>
      )}
    </Card>
  );
}

function CoverageCheck({
  patient,
  coverage,
  canLink,
  payers,
  onRequested,
  onLinked,
}: {
  readonly patient: Patient;
  readonly coverage: Coverage;
  readonly canLink: boolean;
  readonly payers: readonly PayerConfig[];
  readonly onRequested: () => void;
  readonly onLinked: () => void;
}): JSX.Element {
  const medplum = useMedplum();
  const [busy, setBusy] = useState(false);
  const insurer = coverage.payor?.[0]?.display ?? 'Payer';
  const linked = payerIdOf(coverage);
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Text fw={600}>{insurer}</Text>
          <Text size="xs" c="dimmed" className="tm-num">
            Member ID {coverage.subscriberId ?? coverage.identifier?.[0]?.value ?? 'not recorded'}
          </Text>
          <Text size="xs" c={linked ? 'dimmed' : 'orange'}>
            {linked ? 'Linked to a configured payer' : 'Not linked to a configured payer yet'}
          </Text>
        </div>
        <Button
          size="xs"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await checkNow(medplum, patient, coverage, insurer);
              notifications.show({ color: 'brand', message: 'Check sent. The result usually arrives within a minute.' });
              onRequested();
            } catch (err) {
              notifications.show({ color: 'red', title: 'Not sent', message: errorMessage(err), autoClose: false });
            } finally {
              setBusy(false);
            }
          }}
        >
          Check now
        </Button>
      </Group>
      {canLink && !linked && <CoverageLinker coverage={coverage} payers={payers} onLinked={onLinked} />}
    </Card>
  );
}

/** Points an unlinked plan at a configured payer, defaulting to a name match. Billers and admins only. */
function CoverageLinker({ coverage, payers, onLinked }: { readonly coverage: Coverage; readonly payers: readonly PayerConfig[]; readonly onLinked: () => void }): JSX.Element {
  const medplum = useMedplum();
  const suggested = suggestPayer(planNameOf(coverage), payers);
  const [payer, setPayer] = useState<string | null>(suggested?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = payers.find((p) => p.id === payer && p.active);
  return (
    <Stack gap={6} mt="sm">
      <Group align="flex-end" gap="xs" wrap="wrap">
        <Select
          label="Configured payer"
          data={payers.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))}
          value={payer}
          onChange={setPayer}
          placeholder="Choose the payer"
          allowDeselect={false}
          style={{ minWidth: 280 }}
        />
        <Button
          size="xs"
          variant="light"
          disabled={!chosen || busy}
          loading={busy}
          onClick={async () => {
            if (!chosen) return;
            setBusy(true);
            setError(undefined);
            try {
              await linkCoveragePayer(medplum, coverage, chosen);
              notifications.show({ color: 'brand', message: `Plan linked to ${chosen.name}. Future charges will default to it.` });
              onLinked();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Link payer
        </Button>
      </Group>
      {suggested && suggested.id === payer && <Text size="xs" c="dimmed">The plan name matches {suggested.name}.</Text>}
      {error && (
        <Alert color="red" variant="light" title="Not linked">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

function EligibilityDrawer({
  row,
  payers,
  canLink,
  onClose,
  onChanged,
}: {
  readonly row: EligibilityRow;
  readonly payers: readonly PayerConfig[];
  readonly canLink: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const medplum = useMedplum();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = patientName(row.patient);
  const { result, coverage } = row;
  const insurer = row.insurer ?? coverage?.payor?.[0]?.display ?? 'Payer';

  const recheck = async (): Promise<void> => {
    if (!row.patient || !coverage) return;
    setBusy(true);
    setError(undefined);
    try {
      await checkNow(medplum, row.patient, coverage, insurer);
      notifications.show({ color: 'brand', message: 'Check sent. The result usually arrives within a minute.' });
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer opened onClose={onClose} position="right" size="md" title={<Text fw={650}>{`Eligibility · ${name}`}</Text>}>
      <Stack gap="md">
        <Group gap="xs">
          <StatusBadge status={row.status} />
          <Text size="sm" c="dimmed">
            {insurer} · checked {formatDate(row.request.created?.slice(0, 10))} {formatTime(row.request.created)}
          </Text>
        </Group>
        {row.status === 'pending' && (
          <Alert color="gray" variant="light" icon={<IconClock size={18} />} title="Waiting for the payer">
            Results usually arrive within a minute. This page refreshes itself while the check is waiting.
          </Alert>
        )}
        {result && (
          <List size="sm" spacing={4} aria-label="Eligibility details">
            {row.lines.map((l) => (
              <List.Item key={l}>{l}</List.Item>
            ))}
          </List>
        )}
        {!result && row.response && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title="No result">
            {row.lines.join(' ')}
          </Alert>
        )}
        {coverage && canLink && !payerIdOf(coverage) && <CoverageLinker coverage={coverage} payers={payers} onLinked={onChanged} />}
        {error && (
          <Alert color="red" variant="light" title="Not sent">
            {error}
          </Alert>
        )}
        <Group gap="xs">
          <Button variant="default" onClick={recheck} loading={busy} disabled={!row.patient || !coverage}>
            Check again
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Patient checks are for scheduling and billing only. Coverage details come from the payer through the clearinghouse.
        </Text>
      </Stack>
    </Drawer>
  );
}
