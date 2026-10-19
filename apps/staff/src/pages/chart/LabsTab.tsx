import { Alert, Badge, Button, Checkbox, FileInput, Grid, Group, Modal, MultiSelect, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { DocumentReference, ServiceRequest, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconFlask, IconPlus, IconPrinter, IconUpload } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT, LABS, LAB_TESTS, buildLabOrder, findLabTest } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { patientName } from '../../fhir/patient';
import { uploadDocument } from '../../fhir/documents';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

const reviewOf = (d: DocumentReference): { by?: string; at?: string; abnormal?: boolean; comment?: string } | undefined => {
  const e = d.extension?.find((x) => x.url === EXT.resultReview);
  if (!e) return undefined;
  const get = (url: string) => e.extension?.find((x) => x.url === url);
  return { by: get('by')?.valueReference?.reference, at: get('at')?.valueDateTime, abnormal: get('abnormal')?.valueBoolean, comment: get('comment')?.valueString };
};

// P16 Labs & results (manual): order monitoring labs, print the requisition, file PDF results
// (upload here or from the fax centre) and review each one. Electronic ordering arrives in Phase 9.
export function LabsTab(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const { roles } = useRoles();
  const isProvider = roles.includes('provider') && profile?.resourceType === 'Practitioner';
  const [ordering, setOrdering] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewing, setReviewing] = useState<DocumentReference>();
  const orders = useLoader(() => medplum.searchResources('ServiceRequest', { subject: `Patient/${patient.id}`, _sort: '-authored', _count: '100' }, { cache: 'no-cache' }), [patient.id]);
  const results = useLoader(() => medplum.searchResources('DocumentReference', { subject: `Patient/${patient.id}`, category: `${CODE_SYSTEMS.documentCategory}|lab-report`, status: 'current', _sort: '-date', _count: '100' }, { cache: 'no-cache' }), [patient.id], 10000);
  const monitoring = useLoader(() => medplum.searchResources('Task', { subject: `Patient/${patient.id}`, code: `${CODE_SYSTEMS.taskCode}|lab-monitoring`, status: 'requested,ready,in-progress', _count: '20' }, { cache: 'no-cache' }).catch(() => [] as Task[]), [patient.id]);
  const reload = (): void => { orders.reload(); results.reload(); monitoring.reload(); };

  const open = async (d: DocumentReference): Promise<void> => {
    const url = d.content?.[0]?.attachment?.url;
    if (!url) return;
    try {
      const objectUrl = URL.createObjectURL(await medplum.download(url));
      window.open(objectUrl, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not open the result', message: normalizeErrorString(err) });
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <Section
          title="Results"
          loaded={results}
          actions={<Button size="xs" variant="light" leftSection={<IconUpload size={14} />} onClick={() => setUploading(true)}>Add result</Button>}
          isEmpty={(l) => l.length === 0}
          empty={{ icon: <IconFlask size={22} />, title: 'No results yet', text: 'Upload a PDF result, or file a faxed result from Documents & fax. Each result goes to the provider to review.' }}
        >
          {(list) => (
            <Table verticalSpacing="sm">
              <Table.Thead><Table.Tr><Table.Th>Result</Table.Th><Table.Th>Received</Table.Th><Table.Th>Review</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {list.map((d) => {
                  const r = reviewOf(d);
                  return (
                    <Table.Tr key={d.id}>
                      <Table.Td>
                        <Text size="sm" fw={600}>{d.description ?? d.content?.[0]?.attachment?.title}</Text>
                        {r?.comment && <Text size="xs" c="dimmed">{r.comment}</Text>}
                      </Table.Td>
                      <Table.Td className="tm-num">{formatDate(d.date?.slice(0, 10))}</Table.Td>
                      <Table.Td>
                        {r ? (
                          <Group gap={4}>
                            <Badge color={r.abnormal ? 'red' : 'green'} variant="light">{r.abnormal ? 'Abnormal' : 'Reviewed'}</Badge>
                            <Text size="xs" c="dimmed">{formatDate(r.at?.slice(0, 10))}</Text>
                          </Group>
                        ) : (
                          <Badge color="orange" variant="light">To review</Badge>
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Button size="xs" variant="subtle" onClick={() => open(d)}>Open</Button>
                          {!r && isProvider && <Button size="xs" onClick={() => setReviewing(d)}>Review</Button>}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}
        </Section>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="lg">
          {(monitoring.data?.length ?? 0) > 0 && (
            <Alert color="blue" variant="light" icon={<IconFlask size={16} />} title="Monitoring due">
              {monitoring.data?.map((t) => <Text key={t.id} size="sm">{t.description}</Text>)}
            </Alert>
          )}
          <Section
            title="Lab orders"
            loaded={orders}
            actions={isProvider ? <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setOrdering(true)}>Order labs</Button> : undefined}
            isEmpty={(l) => l.length === 0}
            empty={{ icon: <IconFlask size={22} />, title: 'No lab orders', text: isProvider ? 'Order labs and print the requisition for the patient to take to the lab.' : 'Lab orders written by the provider appear here.' }}
          >
            {(list) => (
              <Table verticalSpacing="xs">
                <Table.Tbody>
                  {list.map((o) => (
                    <Table.Tr key={o.id}>
                      <Table.Td>
                        <Text size="sm" fw={600}>{o.code?.text}</Text>
                        <Text size="xs" c="dimmed">{o.performer?.[0]?.display} · ordered {formatDate(o.authoredOn?.slice(0, 10))}</Text>
                      </Table.Td>
                      <Table.Td><Badge variant="light" color={o.status === 'completed' ? 'green' : o.status === 'active' ? 'blue' : 'gray'}>{o.status === 'active' ? 'Awaiting result' : o.status}</Badge></Table.Td>
                      <Table.Td ta="right"><Button size="xs" variant="subtle" leftSection={<IconPrinter size={12} />} onClick={() => printRequisition(patientName(patient), patient.birthDate, [o])}>Print</Button></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Section>
        </Stack>
      </Grid.Col>
      <OrderModal key={`order:${patient.id}:${ordering}`} opened={ordering} onClose={() => setOrdering(false)} onDone={() => { setOrdering(false); reload(); }} />
      <ResultUploadModal key={`upload:${patient.id}:${uploading}`} opened={uploading} orders={(orders.data ?? []).filter((o) => o.status === 'active')} onClose={() => setUploading(false)} onDone={() => { setUploading(false); reload(); }} />
      <ReviewModal key={reviewing?.id ?? 'closed'} doc={reviewing} onClose={() => setReviewing(undefined)} onDone={() => { setReviewing(undefined); reload(); }} />
    </Grid>
  );
}

function OrderModal({ opened, onClose, onDone }: { readonly opened: boolean; readonly onClose: () => void; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [tests, setTests] = useState<string[]>([]);
  const [lab, setLab] = useState<string>(LABS[0]);
  const [note, setNote] = useState('');
  const [print, setPrint] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    if (busy || tests.length === 0) return;
    if (profile?.resourceType !== 'Practitioner') return setError('Only a provider can order labs.');
    setBusy(true);
    setError(undefined);
    try {
      const created = tests.map((key) => buildLabOrder({ patient: createReference(patient), requester: createReference(profile), test: findLabTest(key)!, lab, note }));
      await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: created.map((resource) => ({ resource, request: { method: 'POST', url: 'ServiceRequest' } })) });
      if (print) printRequisition(patientName(patient), patient.birthDate, created);
      notifications.show({ color: 'brand', message: `${created.length} lab order${created.length === 1 ? '' : 's'} created.` });
      setTests([]); setNote('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Order labs" size="lg">
      <Stack>
        <MultiSelect label="Tests" required searchable data={LAB_TESTS.map((t) => ({ value: t.key, label: t.label }))} value={tests} onChange={setTests} />
        <Select label="Lab" data={[...LABS]} value={lab} onChange={(v) => v && setLab(v)} allowDeselect={false} />
        <Textarea label="Note for the lab (optional)" autosize minRows={1} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Checkbox label="Print the requisition now" checked={print} onChange={(e) => setPrint(e.currentTarget.checked)} />
        <Text size="xs" c="dimmed">Electronic ordering is not connected (no lab interface is contracted). The patient takes the printed requisition to the lab, and results come back by fax or upload.</Text>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} disabled={tests.length === 0} onClick={save}>Create orders</Button></Group>
      </Stack>
    </Modal>
  );
}

function ResultUploadModal({ opened, orders, onClose, onDone }: { readonly opened: boolean; readonly orders: ServiceRequest[]; readonly onClose: () => void; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [order, setOrder] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadDocument(medplum, { patient, file, category: 'lab-report', title: title || file.name, related: order ? { reference: order } : undefined });
      notifications.show({ color: 'brand', message: 'Result added; the provider has it to review.' });
      setFile(null); setTitle(''); setOrder(null);
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Add lab result">
      <Stack>
        <FileInput label="Result (PDF or image)" required accept="application/pdf,image/*" value={file} onChange={setFile} />
        <TextInput label="Title" placeholder="e.g. Quest lithium level" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        {orders.length > 0 && <Select label="Answers lab order (optional)" clearable data={orders.map((o) => ({ value: `ServiceRequest/${o.id}`, label: `${o.code?.text} · ${formatDate(o.authoredOn?.slice(0, 10))}` }))} value={order} onChange={setOrder} />}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!file} onClick={save}>Add result</Button></Group>
      </Stack>
    </Modal>
  );
}

function ReviewModal({ doc, onClose, onDone }: { readonly doc?: DocumentReference; readonly onClose: () => void; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [abnormal, setAbnormal] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const save = async (): Promise<void> => {
    if (!doc || !profile) return;
    try {
      await medplum.updateResource<DocumentReference>({
        ...doc,
        extension: [...(doc.extension ?? []), {
          url: EXT.resultReview,
          extension: [
            { url: 'by', valueReference: { reference: getReferenceString(profile) as string } },
            { url: 'at', valueDateTime: new Date().toISOString() },
            { url: 'abnormal', valueBoolean: abnormal },
            ...(comment.trim() ? [{ url: 'comment', valueString: comment.trim() }] : []),
          ],
        }],
      }, { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: 'Review recorded.' });
      setAbnormal(false); setComment('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened={!!doc} onClose={onClose} title="Review result">
      <Stack>
        <Text size="sm" fw={600}>{doc?.description}</Text>
        <Checkbox label="Abnormal or needs follow-up" checked={abnormal} onChange={(e) => setAbnormal(e.currentTarget.checked)} />
        <Textarea label="Comment" placeholder={abnormal ? 'e.g. Lithium 1.3 – hold dose, recheck in 5 days' : 'e.g. Within range'} autosize minRows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        {abnormal && !comment.trim() && <Text size="xs" c="red">Add what happens next for an abnormal result.</Text>}
        <Text size="xs" c="dimmed">A review is final once recorded. Act on abnormal results with a task, a message or a prescription change.</Text>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>Cancel</Button><Button disabled={abnormal && !comment.trim()} onClick={save}>Record review</Button></Group>
      </Stack>
    </Modal>
  );
}

/** Prints a lab requisition in a new window (no PHI is sent to any service). */
function printRequisition(name: string, birthDate: string | undefined, orders: ServiceRequest[]): void {
  const w = window.open('', '_blank', 'width=720,height=900');
  if (!w) return;
  const esc = (s: string | undefined): string => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const rows = orders.map((o) => `<tr><td>${esc(o.code?.text)}</td><td>${esc(o.code?.coding?.[0]?.code)}</td><td>${esc(o.patientInstruction)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><title>Lab requisition</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;text-align:left;font-size:13px}h1{font-size:20px}</style></head><body>
    <h1>Laboratory requisition</h1><p><b>Patient:</b> ${esc(name)} &nbsp; <b>DOB:</b> ${esc(birthDate)}</p>
    <p><b>Lab:</b> ${esc(orders[0]?.performer?.[0]?.display)} &nbsp; <b>Ordered:</b> ${esc(orders[0]?.authoredOn?.slice(0, 10))}</p>
    <table><thead><tr><th>Test</th><th>LOINC</th><th>Instructions</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="margin-top:24px">${esc(orders[0]?.note?.[0]?.text)}</p><p style="margin-top:48px">Ordering provider signature: ____________________</p>
    <script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
}
