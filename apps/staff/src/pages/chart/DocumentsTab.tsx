import { Alert, Badge, Button, Checkbox, Chip, FileInput, Group, Modal, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Communication, DocumentReference } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconDownload, IconFileText, IconPrinter, IconUpload } from '@tabler/icons-react';
import type { DocumentCategoryCode } from '@teleemon/core';
import { CODE_SYSTEMS, DOCUMENT_CATEGORIES, EXT } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { ACCEPTED_TYPES, documentCategory, uploadDocument } from '../../fhir/documents';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';
import type { LetterKind } from './letters';
import { LETTER_TEMPLATES, letterText, saveLetter } from './letters';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// P17 Documents.
export function DocumentsTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [category, setCategory] = useState<string>('all');
  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [faxing, setFaxing] = useState<DocumentReference>();
  const docs = useLoader(() => medplum.searchResources('DocumentReference', { subject: `Patient/${patient.id}`, _sort: '-date', _count: '200' }, { cache: 'no-cache' }), [patient.id]);

  const open = async (doc: DocumentReference): Promise<void> => {
    const url = doc.content?.[0]?.attachment?.url;
    if (!url) return;
    try {
      // Downloading through the API records an AuditEvent for the read.
      const blob = await medplum.download(url);
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not open the file', message: normalizeErrorString(err) });
    }
  };

  return (
    <>
      <Section
        title="Documents"
        loaded={docs}
        actions={
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconFileText size={14} />} onClick={() => setWriting(true)}>
              New letter
            </Button>
            <Button size="xs" leftSection={<IconUpload size={14} />} onClick={() => setUploading(true)}>
              Upload
            </Button>
          </Group>
        }
        isEmpty={(l) => l.length === 0}
        empty={{ icon: <IconFileText size={22} />, title: 'No documents yet', text: 'Uploads, filed faxes and portal uploads appear here by category.' }}
      >
        {(list) => {
          const counts = new Map<string, number>();
          list.forEach((d) => counts.set(documentCategory(d) ?? 'other', (counts.get(documentCategory(d) ?? 'other') ?? 0) + 1));
          const shown = list.filter((d) => category === 'all' || (documentCategory(d) ?? 'other') === category);
          return (
            <Stack gap="md">
              <Chip.Group value={category} onChange={(v) => setCategory(v as string)}>
                <Group gap={6}>
                  <Chip value="all" size="xs">
                    All ({list.length})
                  </Chip>
                  {DOCUMENT_CATEGORIES.filter((c) => counts.has(c.code)).map((c) => (
                    <Chip key={c.code} value={c.code} size="xs">
                      {c.display} ({counts.get(c.code)})
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
              <Table.ScrollContainer minWidth={600}>
                <Table verticalSpacing="sm" highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Document</Table.Th>
                      <Table.Th>Category</Table.Th>
                      <Table.Th>Date</Table.Th>
                      <Table.Th>Added by</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {shown.map((d) => (
                      <Table.Tr key={d.id}>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {d.content?.[0]?.attachment?.title ?? d.description}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {d.content?.[0]?.attachment?.contentType} {formatSize(d.content?.[0]?.attachment?.size)}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge variant="light" color="gray">
                            {d.category?.[0]?.coding?.[0]?.display ?? 'Other'}
                          </Badge>
                        </Table.Td>
                        <Table.Td className="tm-num">{formatDate(d.date?.slice(0, 10))}</Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {d.meta?.author?.display ?? '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />} onClick={() => open(d)} disabled={!d.content?.[0]?.attachment?.url}>
                              Open
                            </Button>
                            <Button size="xs" variant="subtle" color="gray" leftSection={<IconPrinter size={14} />} onClick={() => setFaxing(d)} disabled={!d.content?.[0]?.attachment?.url}>
                              Fax
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
              <Text size="xs" c="dimmed">
                Every file open is recorded in the audit log. Use New letter for school notes, work notes and records-release authorizations.
              </Text>
            </Stack>
          );
        }}
      </Section>
      <FaxSendModal doc={faxing} onClose={() => setFaxing(undefined)} />
      {writing && <LetterModal onClose={() => setWriting(false)} onSaved={() => { setWriting(false); docs.reload(); }} />}
      {uploading && <UploadModal onClose={() => setUploading(false)} onSaved={() => { setUploading(false); docs.reload(); }} />}
    </>
  );
}

function UploadModal({ onClose, onSaved }: { readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState<DocumentCategoryCode | null>(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (): Promise<void> => {
    if (!category || files.length === 0) {
      setError('Choose at least one file and a category.');
      return;
    }
    const bad = files.find((f) => f.type && !ACCEPTED_TYPES.includes(f.type));
    if (bad) {
      setError(`${bad.name}: only PDF and image files are accepted.`);
      return;
    }
    setSaving(true);
    try {
      for (const file of files) {
        await uploadDocument(medplum, { patient, file, category, title: files.length === 1 ? title : undefined });
      }
      notifications.show({ color: 'brand', message: `${files.length} document${files.length > 1 ? 's' : ''} uploaded.` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title="Upload documents" centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <FileInput label="Files" description="PDF or images, up to 20 MB each" multiple accept={ACCEPTED_TYPES.join(',')} value={files} onChange={setFiles} placeholder="Choose files" clearable />
        <Select label="Category" required data={DOCUMENT_CATEGORIES.map((c) => ({ value: c.code, label: c.display }))} value={category} onChange={(v) => setCategory(v as DocumentCategoryCode)} />
        {files.length <= 1 && <TextInput label="Title" placeholder="Defaults to the file name" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={save} leftSection={<IconUpload size={16} />}>
            Upload
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Queues an outbound fax of this document (P28); the worker sends it and failures become tasks. */
function FaxSendModal({ doc, onClose }: { readonly doc?: DocumentReference; readonly onClose: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [to, setTo] = useState('');
  const [name, setName] = useState('');
  const [cover, setCover] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string>();
  const digits = to.replace(/\D/g, '');
  const send = async (): Promise<void> => {
    if (!doc) return;
    try {
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'preparation',
        category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'fax-outbound', display: 'Outbound fax' }] }],
        medium: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: 'FAXWRIT' }] }],
        subject: createReference(patient),
        sender: profile ? { reference: getReferenceString(profile) as string } : undefined,
        recipient: [{ display: name.trim() }],
        about: [createReference(doc)],
        payload: [{ contentReference: createReference(doc) }, ...(cover.trim() ? [{ contentString: cover.trim() }] : [])],
        extension: [{ url: EXT.faxTo, valueString: to.trim() }],
      });
      notifications.show({ color: 'brand', message: `Fax to ${name.trim()} queued. Track it under Documents & fax, Sent faxes.` });
      setTo(''); setName(''); setCover(''); setAuthorized(false);
      onClose();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened={!!doc} onClose={onClose} title="Fax document">
      <Stack>
        <Text size="sm" fw={600}>{doc?.description ?? doc?.content?.[0]?.attachment?.title}</Text>
        <TextInput label="Recipient" placeholder="e.g. Dr. Rivera, Eastside Primary Care" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <TextInput label="Fax number" placeholder="(425) 555-0100" required value={to} onChange={(e) => setTo(e.currentTarget.value)} error={to && digits.length !== 10 ? 'Enter a 10-digit US fax number' : undefined} />
        <Textarea label="Cover note" autosize minRows={2} value={cover} onChange={(e) => setCover(e.currentTarget.value)} description="Keep it brief; the cover page carries the standard confidentiality notice." />
        <Checkbox label="I verified the number, and this disclosure is for treatment, payment or operations, or a release is on file" checked={authorized} onChange={(e) => setAuthorized(e.currentTarget.checked)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>Cancel</Button><Button disabled={!authorized || digits.length !== 10 || !name.trim()} onClick={send}>Send fax</Button></Group>
      </Stack>
    </Modal>
  );
}

/** Write a letter from a template, save it to the chart and open it for printing. */
function LetterModal({ onClose, onSaved }: { readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const signer = [profile?.name?.[0]?.given?.join(' '), profile?.name?.[0]?.family, ...(profile?.name?.[0]?.suffix ?? [])].filter(Boolean).join(' ') || 'Teleemon Behavioral Health';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const [kind, setKind] = useState<LetterKind>('school');
  const [body, setBody] = useState(() => letterText('school', patient, signer, today));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const choose = (k: LetterKind): void => {
    setKind(k);
    setBody(letterText(k, patient, signer, today));
  };
  const save = async (): Promise<void> => {
    if (body.includes('[')) {
      setError('Fill in or remove every [bracketed] placeholder before saving.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const { html } = await saveLetter(medplum, patient, kind, body);
      const w = window.open('', '_blank', 'width=800,height=1000');
      if (w) {
        w.document.write(html);
        w.document.close();
      }
      notifications.show({ color: 'brand', message: 'Letter saved to Documents.' });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="New letter" size="lg" centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <Select label="Template" data={LETTER_TEMPLATES.map((t) => ({ value: t.kind, label: t.label }))} value={kind} onChange={(v) => v && choose(v as LetterKind)} allowDeselect={false} />
        <Textarea label="Letter" autosize minRows={10} value={body} onChange={(e) => setBody(e.currentTarget.value)} description="Edit the text. School and work notes should not state a diagnosis." />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={() => void save()}>Save and print</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
