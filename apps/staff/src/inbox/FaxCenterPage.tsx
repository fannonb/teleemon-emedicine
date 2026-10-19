import { Alert, Badge, Button, Card, Checkbox, Grid, Group, List, Paper, SegmentedControl, Select, Stack, Table, Text, TextInput, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { BundleEntry, Communication, DocumentReference, Patient, Resource, ServiceRequest, Task } from '@medplum/fhirtypes';
import { ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconFileText, IconInbox, IconPrinter } from '@tabler/icons-react';
import type { DocumentCategoryCode, FaxSuggestion } from '@teleemon/core';
import { CODE_SYSTEMS, DOCUMENT_CATEGORIES, DOCUMENT_TYPE_SYSTEM, EXT, confirmMatchExtension, isOverdue } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { formatAge, formatDate } from '../utils/format';
import { QUEUES } from './inbox';
import { CloseReasonModal } from './TaskDrawer';

type View = 'inbound' | 'sent' | 'removed';
interface QueueItem { readonly task: Task; readonly doc?: DocumentReference }

const suggestionOf = (d: DocumentReference | undefined): FaxSuggestion | undefined => {
  const raw = d?.extension?.find((e) => e.url === EXT.faxSuggestion)?.valueString;
  try { return raw ? (JSON.parse(raw) as FaxSuggestion) : undefined; } catch { return undefined; }
};
const CONFIDENCE_COLOR = { high: 'green', medium: 'yellow', low: 'orange', none: 'gray' } as const;

// P28 Documents & fax: file every received fax to the right patient (after a person confirms the
// match), or remove it with a reason. Nothing is deleted. Outbound faxes are sent from a patient's
// Documents tab and tracked here.
export function FaxCenterPage(): JSX.Element {
  const medplum = useMedplum();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('inbound');
  const selectedId = params.get('fax') ?? undefined;

  const queue = useLoader(async (): Promise<QueueItem[]> => {
    const entries: BundleEntry[] = [];
    for await (const page of medplum.searchResourcePages('Task', new URLSearchParams([...Object.entries(QUEUES.faxes.params()), ['_sort', 'authored-on'], ['_count', '200'], ['_include', 'Task:focus']]), { cache: 'no-cache' })) entries.push(...(page.bundle.entry ?? []));
    const docs = new Map<string, Resource>();
    for (const e of entries) if (e.search?.mode === 'include' && e.resource) docs.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    return entries.filter((e) => e.search?.mode !== 'include' && e.resource?.resourceType === 'Task').map((e) => ({ task: e.resource as Task, doc: docs.get((e.resource as Task).focus?.reference ?? '') as DocumentReference | undefined }));
  }, [], 30000);
  const items = queue.data ?? [];
  const selected = items.find((i) => i.doc?.id === selectedId) ?? items[0];

  return (
    <PageBody wide>
      <PageHeader eyebrow="P28 · Clinical work" title="Documents & fax" subtitle="File each received fax to the right patient, or remove it with a reason. Faxes are never deleted." />
      <Stack gap="md">
        <SegmentedControl style={{ alignSelf: 'flex-start' }} value={view} onChange={(v) => setView(v as View)}
          data={[{ value: 'inbound', label: `To file${items.length ? ` (${items.length})` : ''}` }, { value: 'sent', label: 'Sent faxes' }, { value: 'removed', label: 'Removed' }]} />
        {view === 'inbound' && (
          <Section loaded={queue} padding="md" isEmpty={(l) => l.length === 0} empty={{ icon: <IconInbox size={22} />, title: 'No faxes to file', text: 'Received faxes appear here until they are filed or removed with a reason.' }}>
            {() => (
              <Grid gutter="lg">
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <Stack gap={6}>
                    {items.map((i) => {
                      const s = suggestionOf(i.doc);
                      const active = i === selected;
                      return (
                        <UnstyledButton key={i.task.id} onClick={() => setParams({ fax: i.doc?.id ?? '' })}>
                          <Paper withBorder p="sm" radius="md" style={{ borderColor: active ? 'var(--mantine-color-brand-6)' : undefined, background: active ? 'var(--mantine-color-brand-light)' : undefined }}>
                            <Group justify="space-between" wrap="nowrap">
                              <Text size="sm" fw={600} lineClamp={1}>{i.doc?.description ?? 'Fax'}</Text>
                              {isOverdue(i.task) && <Badge color="red" variant="light" size="xs">Overdue</Badge>}
                            </Group>
                            <Text size="xs" c="dimmed">Received {formatAge(i.doc?.date ?? i.task.authoredOn)} ago{s?.category ? ` · looks like ${DOCUMENT_CATEGORIES.find((c) => c.code === s.category)?.display.toLowerCase()}` : ''}</Text>
                          </Paper>
                        </UnstyledButton>
                      );
                    })}
                  </Stack>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 8 }}>
                  {selected?.doc ? <FileFax key={selected.doc.id} item={selected as Required<QueueItem>} onDone={() => { setParams({}); queue.reload(); }} /> : <Alert color="red">This fax's document could not be loaded.</Alert>}
                </Grid.Col>
              </Grid>
            )}
          </Section>
        )}
        {view === 'sent' && <SentFaxes />}
        {view === 'removed' && <RemovedFaxes />}
      </Stack>
    </PageBody>
  );
}

function FileFax({ item, onDone }: { readonly item: Required<QueueItem>; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { doc, task } = item;
  const suggestion = suggestionOf(doc);
  const [preview, setPreview] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const suggested = useLoader(async () => (suggestion?.patientId ? medplum.readResource('Patient', suggestion.patientId).catch(() => undefined) : undefined), [doc.id]);
  const [patient, setPatient] = useState<Patient>();
  const [patientChanged, setPatientChanged] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [category, setCategory] = useState<DocumentCategoryCode | null>(suggestion?.category ?? null);
  const [title, setTitle] = useState('');
  const [order, setOrder] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = patientChanged ? patient : suggested.data;
  const orders = useLoader(async () => (chosen && category === 'lab-report' ? medplum.searchResources('ServiceRequest', { subject: `Patient/${chosen.id}`, status: 'active', _count: '20' }).catch(() => [] as ServiceRequest[]) : []), [chosen?.id, category]);

  useEffect(() => {
    let url: string | undefined;
    let active = true;
    setPreview(undefined);
    setPreviewError(undefined);
    const src = doc.content?.[0]?.attachment?.url;
    if (src) medplum.download(src).then((blob) => { if (active) { url = URL.createObjectURL(blob); setPreview(url); } }).catch((err) => { if (active) setPreviewError(normalizeErrorString(err)); });
    else setPreviewError('The fax file is not available yet. Refresh after intake finishes.');
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [doc.id, medplum, doc.content]);

  const file = async (): Promise<void> => {
    if (!chosen || !category || !profile) return;
    setError(undefined);
    setBusy(true);
    try {
      const display = DOCUMENT_CATEGORIES.find((c) => c.code === category)?.display;
      const filed = await medplum.updateResource<DocumentReference>({
        ...doc,
        subject: createReference(chosen),
        category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: category, display }] }],
        description: title.trim() || doc.description,
        context: { ...doc.context, related: order ? [{ reference: order }] : undefined },
        extension: [...(doc.extension ?? []).filter((e) => e.url !== EXT.matchConfirmed), confirmMatchExtension(getReferenceString(profile) as string)],
      }, { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } });
      await medplum.updateResource<Task>({ ...task, status: 'completed', for: createReference(chosen), owner: { reference: getReferenceString(profile) as string }, output: [{ type: { text: 'filed document' }, valueReference: createReference(filed) }], lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
      notifications.show({ color: 'brand', title: 'Fax filed', message: `${display} for ${patientName(chosen)}${category === 'lab-report' ? '; the provider has a result to review' : ''}` });
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (reason: string): Promise<void> => {
    setError(undefined);
    try {
      await medplum.updateResource<DocumentReference>({ ...doc, status: 'entered-in-error', extension: [...(doc.extension ?? []), { url: EXT.removalReason, valueString: reason }] }, { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } });
      await medplum.updateResource<Task>({ ...task, status: 'cancelled', statusReason: { text: reason }, lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
      notifications.show({ color: 'gray', message: 'Fax removed from the queue (kept for audit).' });
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  return (
    <Grid gutter="md">
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <Card withBorder padding={0} style={{ height: 620, overflow: 'hidden' }}>
          {preview ? <iframe title="Fax preview" src={preview} style={{ width: '100%', height: '100%', border: 0 }} /> : <Stack align="center" justify="center" h="100%"><IconFileText size={28} /><Text size="sm" c={previewError ? 'red' : 'dimmed'}>{previewError ?? 'Loading preview…'}</Text></Stack>}
        </Card>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="sm">
          <Text size="sm" fw={650}>{doc.description}</Text>
          {suggestion && (
            <Paper withBorder p="sm" radius="md">
              <Group gap="xs" mb={4}>
                <Text size="xs" fw={650} tt="uppercase" c="dimmed">Suggestion</Text>
                <Badge size="xs" variant="light" color={CONFIDENCE_COLOR[suggestion.confidence]}>{suggestion.confidence === 'none' ? 'no patient match' : `${suggestion.confidence} confidence`}</Badge>
              </Group>
              <List size="xs" spacing={2}>
                {suggestion.reasons.map((r) => <List.Item key={r}>{r}</List.Item>)}
                {suggestion.categoryReason && <List.Item>Category: {suggestion.categoryReason}</List.Item>}
              </List>
              {(suggestion.parsed.names.length > 0 || suggestion.parsed.birthDates.length > 0) && (
                <Text size="xs" c="dimmed" mt={4}>Read from the fax: {[...suggestion.parsed.names, ...suggestion.parsed.birthDates.map((d) => `DOB ${d}`)].join(' · ')}</Text>
              )}
            </Paper>
          )}
          {!suggested.loading && (
            <ResourceInput<Patient> key={suggested.data?.id ?? 'none'} resourceType="Patient" name="patient" label="Patient" required defaultValue={suggested.data} onChange={(p) => { setPatient(p); setPatientChanged(true); setConfirmed(false); setOrder(null); }} />
          )}
          {chosen && <Text size="xs" c="dimmed">Chart: {patientName(chosen)} · DOB {formatDate(chosen.birthDate)}</Text>}
          <Checkbox label="I checked the name and date of birth on the fax match this patient" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} disabled={!chosen} />
          <Select label="Category" required data={DOCUMENT_CATEGORIES.filter((c) => !['visit-export', 'after-visit-summary', 'private-psychotherapy', 'transcript'].includes(c.code)).map((c) => ({ value: c.code, label: c.display }))} value={category} onChange={(v) => { setCategory(v as DocumentCategoryCode | null); setOrder(null); }} />
          {category === 'lab-report' && (orders.data?.length ?? 0) > 0 && (
            <Select label="Answers lab order (optional)" clearable data={(orders.data ?? []).map((o) => ({ value: `ServiceRequest/${o.id}`, label: `${o.code?.text} · ordered ${formatDate(o.authoredOn?.slice(0, 10))}` }))} value={order} onChange={setOrder} />
          )}
          <TextInput label="Title (optional)" placeholder="e.g. LabCorp CMP results" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          {error && <Alert color="red" variant="light" title="Not filed">{error}</Alert>}
          <Group justify="space-between" mt="xs">
            <Button variant="subtle" color="red" onClick={() => setRemoving(true)}>Remove…</Button>
            <Button loading={busy} disabled={!chosen || !confirmed || !category || !preview} onClick={file}>File to chart</Button>
          </Group>
        </Stack>
      </Grid.Col>
      <CloseReasonModal opened={removing} title="Remove fax from the queue" label="Why? (e.g. wrong number, duplicate, blank pages)" onClose={() => setRemoving(false)} onConfirm={(r) => { setRemoving(false); void remove(r); }} />
    </Grid>
  );
}

function SentFaxes(): JSX.Element {
  const medplum = useMedplum();
  const sent = useLoader(async () => {
    const bundle = await medplum.search('Communication', new URLSearchParams([['category', `${CODE_SYSTEMS.communicationCategory}|fax-outbound`], ['_sort', '-_lastUpdated'], ['_count', '100'], ['_include', 'Communication:subject']]), { cache: 'no-cache' });
    const patients = new Map<string, Resource>();
    for (const e of bundle.entry ?? []) if (e.search?.mode === 'include' && e.resource) patients.set(`Patient/${e.resource.id}`, e.resource);
    return (bundle.entry ?? []).filter((e) => e.search?.mode !== 'include').map((e) => ({ msg: e.resource as Communication, patient: patients.get((e.resource as Communication).subject?.reference ?? '') as Patient | undefined }));
  }, [], 15000);
  return (
    <Section loaded={sent} padding="md" isEmpty={(l) => l.length === 0} empty={{ icon: <IconPrinter size={22} />, title: 'No faxes sent', text: 'Send a fax from a patient’s Documents tab.' }}>
      {(list) => (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead><Table.Tr><Table.Th>To</Table.Th><Table.Th>Patient</Table.Th><Table.Th>Queued</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {list.map(({ msg, patient }) => (
                <Table.Tr key={msg.id}>
                  <Table.Td><Text size="sm" fw={600}>{msg.recipient?.[0]?.display ?? 'Recipient'}</Text><Text size="xs" c="dimmed">{msg.extension?.find((e) => e.url === EXT.faxTo)?.valueString}</Text></Table.Td>
                  <Table.Td>{patientName(patient)}</Table.Td>
                  <Table.Td className="tm-num">{formatAge(msg.meta?.lastUpdated)} ago</Table.Td>
                  <Table.Td>
                    <Badge variant="light" color={msg.status === 'completed' ? 'green' : msg.status === 'stopped' ? 'red' : 'blue'}>{msg.status === 'completed' ? 'Logged (sandbox)' : msg.status === 'stopped' ? 'Failed' : 'Queued (sandbox)'}</Badge>
                    {msg.statusReason?.text && <Text size="xs" c="dimmed">{msg.statusReason.text}</Text>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Section>
  );
}

function RemovedFaxes(): JSX.Element {
  const medplum = useMedplum();
  const removed = useLoader(() => medplum.searchResources('DocumentReference', { type: `${DOCUMENT_TYPE_SYSTEM}|inbound-fax`, status: 'entered-in-error', _sort: '-_lastUpdated', _count: '100' }, { cache: 'no-cache' }), []);
  return (
    <Section loaded={removed} padding="md" isEmpty={(l) => l.length === 0} empty={{ icon: <IconInbox size={22} />, title: 'Nothing removed', text: 'Faxes removed from the queue stay here with the reason, for audit.' }}>
      {(list) => (
        <Table verticalSpacing="sm">
          <Table.Thead><Table.Tr><Table.Th>Fax</Table.Th><Table.Th>Removed</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {list.map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td>{d.description}</Table.Td>
                <Table.Td className="tm-num">{formatAge(d.meta?.lastUpdated)} ago</Table.Td>
                <Table.Td>{d.extension?.find((e) => e.url === EXT.removalReason)?.valueString}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Section>
  );
}
