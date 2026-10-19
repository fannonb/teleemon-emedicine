import { Alert, Badge, Button, Card, Grid, Group, Modal, Select, SimpleGrid, Stack, Switch, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { createReference, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Coverage, DocumentReference } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconCreditCard, IconPlus, IconShieldCheck } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import type { EligibilityStatus } from '../../billing/eligibility';
import { checkNow, latestEligibility } from '../../billing/eligibility';
import { loadSuperbill, printSuperbill } from '../../billing/superbill';
import { useRoles } from '../../session/roles';
import { useChart } from './ChartContext';

const ORDER_LABEL: Record<number, string> = { 1: 'Primary', 2: 'Secondary', 3: 'Tertiary' };

interface CoverageForm {
  payer: string;
  memberId: string;
  groupNumber: string;
  relationship: string;
  start: string;
  end: string;
  order: string;
}

// P11 Insurance and eligibility.
export function InsuranceTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient, refresh } = useChart();
  const [editing, setEditing] = useState<Coverage | 'new' | undefined>();
  const selfPay = getExtensionValue(patient, EXT.selfPay) === true;
  const { roles } = useRoles();
  // Superbills read charges, which front desk cannot see (server policy).
  const canBill = roles.some((r) => r === 'admin' || r === 'biller' || r === 'provider');
  const [superbillOpen, setSuperbillOpen] = useState(false);

  const coverages = useLoader(
    () => medplum.searchResources('Coverage', { beneficiary: `Patient/${patient.id}`, _count: '20' }, { cache: 'no-cache' }),
    [patient.id]
  );
  const cards = useLoader(
    () =>
      medplum
        .searchResources('DocumentReference', { subject: `Patient/${patient.id}`, category: `${CODE_SYSTEMS.documentCategory}|id-insurance`, _count: '10' }, { cache: 'no-cache' })
        .catch(() => [] as DocumentReference[]),
    [patient.id]
  );

  const toggleSelfPay = async (on: boolean): Promise<void> => {
    const extension = (patient.extension ?? []).filter((e) => e.url !== EXT.selfPay);
    if (on) extension.push({ url: EXT.selfPay, valueBoolean: true });
    try {
      await medplum.updateResource({ ...patient, extension });
      notifications.show({ color: 'brand', message: on ? 'Marked as self-pay. Insurance will not be billed.' : 'Self-pay removed.' });
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };

  /** Patient uploads stay preliminary (and editable by the patient) until someone checks them. */
  const markChecked = async (d: DocumentReference): Promise<void> => {
    try {
      await medplum.updateResource<DocumentReference>({ ...d, docStatus: 'final' }, { headers: { 'If-Match': `W/"${d.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: 'Card image marked as checked.' });
      cards.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <Stack gap="lg">
          <Card padding="md">
            <Group justify="space-between">
              <div>
                <Text fw={600}>Self-pay</Text>
                <Text size="xs" c="dimmed">
                  The patient pays out of pocket; insurance is never billed. Give a superbill for out-of-network reimbursement.
                </Text>
              </div>
              <Switch checked={selfPay} onChange={(e) => toggleSelfPay(e.currentTarget.checked)} aria-label="Self-pay" />
            </Group>
            {selfPay && canBill && (
              <Group mt="sm">
                <Button size="xs" variant="light" onClick={() => setSuperbillOpen(true)}>Print superbill</Button>
              </Group>
            )}
            {superbillOpen && <SuperbillModal onClose={() => setSuperbillOpen(false)} />}
          </Card>
          <Section
            title="Coverage"
            loaded={coverages}
            actions={
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
                Add coverage
              </Button>
            }
            isEmpty={(l) => l.length === 0}
            empty={{ icon: <IconCreditCard size={22} />, title: selfPay ? 'Self-pay patient' : 'No insurance on file', text: selfPay ? 'Coverage can still be added if the patient later wants to use insurance.' : 'Add coverage, or mark the patient as self-pay.' }}
          >
            {(list) => (
              <Stack gap="sm">
                {[...list].sort((a, b) => (a.order ?? 9) - (b.order ?? 9)).map((c) => (
                  <Card key={c.id} padding="md" withBorder>
                    <Group justify="space-between" align="flex-start">
                      <div>
                        <Group gap={8}>
                          <Text fw={650}>{c.payor?.[0]?.display ?? 'Unknown payer'}</Text>
                          <Badge size="sm" variant="light" color="navy">
                            {ORDER_LABEL[c.order ?? 1] ?? `Order ${c.order}`}
                          </Badge>
                          <Badge size="sm" variant="dot" color={c.status === 'active' ? 'green' : 'gray'}>
                            {c.status}
                          </Badge>
                        </Group>
                        <Text size="sm" className="tm-num" mt={4}>
                          Member ID {c.subscriberId ?? '—'} · Group {c.class?.[0]?.value ?? '—'} · Patient is {c.relationship?.coding?.[0]?.code ?? 'self'}
                        </Text>
                        <Text size="xs" c="dimmed" className="tm-num">
                          Effective {formatDate(c.period?.start)}
                          {c.period?.end ? ` to ${formatDate(c.period.end)}` : ''}
                        </Text>
                      </div>
                      <Button size="xs" variant="default" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                    </Group>
                  </Card>
                ))}
              </Stack>
            )}
          </Section>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Stack gap="lg">
          <EligibilityCard coverages={(coverages.data ?? []).filter((c) => c.status === 'active')} selfPay={selfPay} />
          <Section title="Card images" loaded={cards} isEmpty={(l) => l.length === 0} empty={{ icon: <IconCreditCard size={22} />, title: 'No card images', text: 'Patients can add photos in the portal, or upload them in Documents under “ID and insurance cards”.' }}>
            {(docs) => (
              <Stack gap={8}>
                {docs.map((d) => (
                  <Group key={d.id} justify="space-between" wrap="nowrap" gap="xs">
                    <div>
                      <Text size="sm">{d.content?.[0]?.attachment?.title ?? d.description}</Text>
                      <Text size="xs" c="dimmed">{formatDate(d.date?.slice(0, 10))}{d.docStatus === 'preliminary' ? ' · uploaded by the patient' : ''}</Text>
                    </div>
                    {d.docStatus === 'preliminary' ? (
                      <Button size="compact-xs" variant="light" onClick={() => void markChecked(d)} disabled={!d.content?.[0]?.attachment?.url}>Mark checked</Button>
                    ) : (
                      <Badge size="sm" color="green" variant="light">Checked</Badge>
                    )}
                  </Group>
                ))}
                <Text size="xs" c="dimmed">Open the images from Documents to compare them with the coverage details.</Text>
              </Stack>
            )}
          </Section>
        </Stack>
      </Grid.Col>
      {editing && (
        <CoverageModal
          coverage={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            coverages.reload();
            refresh();
          }}
        />
      )}
    </Grid>
  );
}

function CoverageModal({ coverage, onClose, onSaved }: { readonly coverage?: Coverage; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [error, setError] = useState<string>();
  const form = useForm<CoverageForm>({
    initialValues: {
      payer: coverage?.payor?.[0]?.display ?? '',
      memberId: coverage?.subscriberId ?? '',
      groupNumber: coverage?.class?.[0]?.value ?? '',
      relationship: coverage?.relationship?.coding?.[0]?.code ?? 'self',
      start: coverage?.period?.start ?? '',
      end: coverage?.period?.end ?? '',
      order: String(coverage?.order ?? 1),
    },
    validate: {
      payer: (v) => (v.trim() ? null : 'Required'),
      memberId: (v) => (v.trim() ? null : 'Required'),
      end: (v, all) => (v && all.start && v < all.start ? 'End date is before the start date' : null),
    },
  });

  const save = async (v: CoverageForm): Promise<void> => {
    const memberId = v.memberId.trim().toUpperCase();
    const resource: Coverage = {
      ...coverage,
      resourceType: 'Coverage',
      status: v.end && v.end < new Date().toISOString().slice(0, 10) ? 'cancelled' : 'active',
      beneficiary: createReference(patient),
      subscriber: coverage?.subscriber ?? createReference(patient),
      subscriberId: memberId,
      identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] }, value: memberId }],
      relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: v.relationship }] },
      payor: [{ display: v.payer.trim() }],
      class: v.groupNumber ? [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] }, value: v.groupNumber.trim() }] : undefined,
      period: v.start || v.end ? { start: v.start || undefined, end: v.end || undefined } : undefined,
      order: Number(v.order),
    };
    try {
      await (coverage?.id ? medplum.updateResource(resource) : medplum.createResource(resource));
      notifications.show({ color: 'brand', message: 'Coverage saved.' });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  return (
    <Modal opened onClose={onClose} title={coverage ? 'Edit coverage' : 'Add coverage'} size="lg" centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Insurance company" required {...form.getInputProps('payer')} />
            <TextInput label="Member ID" required {...form.getInputProps('memberId')} />
            <TextInput label="Group number" {...form.getInputProps('groupNumber')} />
            <Select
              label="Patient is the"
              data={[
                { value: 'self', label: 'Subscriber (self)' },
                { value: 'child', label: 'Child of the subscriber' },
                { value: 'spouse', label: 'Spouse of the subscriber' },
                { value: 'other', label: 'Other dependent' },
              ]}
              {...form.getInputProps('relationship')}
            />
            <TextInput label="Effective from" type="date" {...form.getInputProps('start')} />
            <TextInput label="Ends" type="date" {...form.getInputProps('end')} />
            <Select label="Order" data={[{ value: '1', label: 'Primary' }, { value: '2', label: 'Secondary' }, { value: '3', label: 'Tertiary' }]} {...form.getInputProps('order')} />
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save coverage</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

const ELIGIBILITY_BADGE: Record<EligibilityStatus, { color: string; label: string }> = {
  active: { color: 'green', label: 'Active' },
  inactive: { color: 'red', label: 'Inactive' },
  check: { color: 'orange', label: 'Needs a look' },
  pending: { color: 'gray', label: 'Waiting for payer' },
};

/** Latest eligibility per active coverage, with an on-demand check. The worker answers the request (P32). */
function EligibilityCard({ coverages, selfPay }: { readonly coverages: readonly Coverage[]; readonly selfPay: boolean }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [busy, setBusy] = useState<string>();
  const results = useLoader(() => Promise.all(coverages.map((c) => latestEligibility(medplum, c))), [coverages.map((c) => c.id).join(',')]);

  const check = async (c: Coverage): Promise<void> => {
    setBusy(c.id);
    try {
      await checkNow(medplum, patient, c, c.payor?.[0]?.display ?? 'Payer');
      notifications.show({ color: 'brand', message: 'Eligibility check requested. The result usually arrives within a minute.' });
      results.reload();
    } catch (err) {
      notifications.show({ color: 'red', message: normalizeErrorString(err) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card>
      <Group gap="sm" mb="xs">
        <ThemeIcon variant="light" color="navy" radius="xl">
          <IconShieldCheck size={16} />
        </ThemeIcon>
        <Title order={3}>Eligibility</Title>
      </Group>
      {selfPay || coverages.length === 0 ? (
        <Text size="sm" c="dimmed">{selfPay ? 'Self-pay: no eligibility check is needed.' : 'Add an active insurance plan to check eligibility.'}</Text>
      ) : (
        <Stack gap="sm">
          {coverages.map((c, i) => {
            const r = results.data?.[i];
            const badge = r ? ELIGIBILITY_BADGE[r.status] : undefined;
            return (
              <Stack key={c.id} gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" fw={600}>{c.payor?.[0]?.display ?? 'Plan'}</Text>
                  {badge ? <Badge color={badge.color} variant="light">{badge.label}</Badge> : <Badge color="gray" variant="outline">Not checked</Badge>}
                </Group>
                {r?.lines.slice(0, 4).map((line) => <Text key={line} size="xs" c="dimmed">{line}</Text>)}
                <Group justify="space-between">
                  <Text size="xs" c="dimmed">{r?.checkedAt ? `Checked ${formatDate(r.checkedAt.slice(0, 10))}` : 'Checked automatically the day before each visit'}</Text>
                  <Button size="xs" variant="light" loading={busy === c.id} onClick={() => void check(c)}>Check now</Button>
                </Group>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

/** Choose the service period, then print. Defaults to this calendar year. */
function SuperbillModal({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const print = async (): Promise<void> => {
    if (!from || !to || from > to) {
      setError('Choose a start date on or before the end date.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      printSuperbill(patient, await loadSuperbill(medplum, patient, from, to), from, to);
      onClose();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Print superbill">
      <Stack>
        <Text size="sm" c="dimmed">Lists released charges with codes and fees, and what the patient paid, for the period.</Text>
        <SimpleGrid cols={2}>
          <TextInput type="date" label="From" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput type="date" label="To" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </SimpleGrid>
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={() => void print()}>Print</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
