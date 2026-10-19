import { Alert, Badge, Button, Card, Group, Modal, SegmentedControl, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { BundleEntry, MedicationRequest, Patient, Practitioner, Reference, Resource, Task } from '@medplum/fhirtypes';
import { ResourceInput, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconInbox, IconPlus } from '@tabler/icons-react';
import { CODE_SYSTEMS, MEDICATIONS, RENEWAL_SLA_BUSINESS_DAYS, buildRenewalTask } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { formatAge, formatDate } from '../utils/format';
import { PrescribeModal } from './PrescribeModal';
import { useRoles } from '../session/roles';

interface Row { readonly task: Task; readonly patient?: Patient; readonly prior?: MedicationRequest }
type View = 'open' | 'done';

const medicationOf = (t: Task): string => t.input?.find((i) => i.type.text === 'medication')?.valueString ?? t.description ?? 'Medication';
/** Portal requests (X07) carry the patient's own words as an input, because Task.note is staff-only. */
const patientNote = (t: Task): string | undefined => t.input?.find((i) => i.type.text === 'patient note')?.valueString;
const overdue = (t: Task, now = Date.now()): boolean => !!t.restriction?.period?.end && Date.parse(t.restriction.period.end) < now;

// P26 Refill requests: pharmacy and patient renewal requests, answered or escalated within the SLA.
// Vendor RxRenewal messages arrive here once e-prescribing is connected; phone and fax requests are
// recorded by staff. Patient portal requests (X07) join in Phase 7.
export function RefillsPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const me = profile ? getReferenceString(profile) : '';
  const canPrescribe = useRoles().roles.includes('provider');
  const [view, setView] = useState<View>('open');
  const [recording, setRecording] = useState(false);
  const [approving, setApproving] = useState<Row>();
  const [denying, setDenying] = useState<Row>();

  const requests = useLoader(async () => {
    const entries: BundleEntry[] = [];
    for await (const page of medplum.searchResourcePages('Task', new URLSearchParams([
      ['code', `${CODE_SYSTEMS.taskCode}|rx-renewal`],
      ['status', view === 'open' ? 'requested,received,accepted,in-progress' : 'completed,rejected,cancelled'],
      ['_sort', view === 'open' ? 'authored-on' : '-_lastUpdated'], ['_count', '200'],
      ['_include', 'Task:subject'], ['_include', 'Task:focus'],
    ]), { cache: 'no-cache' })) entries.push(...(page.bundle.entry ?? []));
    const byRef = new Map<string, Resource>();
    const tasks: Task[] = [];
    for (const e of entries) {
      const r = e.resource;
      if (!r) continue;
      if (r.resourceType === 'Task' && e.search?.mode !== 'include') tasks.push(r);
      else byRef.set(`${r.resourceType}/${r.id}`, r);
    }
    return tasks.map((task): Row => ({ task, patient: byRef.get(task.for?.reference ?? '') as Patient | undefined, prior: byRef.get(task.focus?.reference ?? '') as MedicationRequest | undefined }));
  }, [view], 30000);

  const escalate = async (row: Row): Promise<void> => {
    try {
      await medplum.updateResource({ ...row.task, status: 'in-progress', priority: 'urgent', businessStatus: { text: 'Escalated' }, lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${row.task.meta?.versionId}"` } });
      notifications.show({ color: 'orange', title: 'Escalated', message: `${medicationOf(row.task)} for ${patientName(row.patient)}` });
      requests.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not changed', message: normalizeErrorString(err) });
    }
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow="P26 · Clinical work"
        title="Refill requests"
        subtitle={`Renewal requests from pharmacies and patients. Answer or escalate each within ${RENEWAL_SLA_BUSINESS_DAYS} business days.`}
        actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setRecording(true)}>Record request</Button>}
      />
      <Stack gap="lg">
        <SegmentedControl value={view} onChange={(v) => setView(v as View)} data={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Answered' }]} style={{ alignSelf: 'flex-start' }} />
        <Section
          loaded={requests}
          padding="md"
          isEmpty={(l) => l.length === 0}
          empty={{ icon: <IconInbox size={22} />, title: view === 'open' ? 'No open requests' : 'Nothing answered yet', text: 'Phone and fax renewal requests can be recorded with Record request. Electronic requests arrive here once the e-prescribing vendor is connected.' }}
        >
          {(rows) => (
            <Card padding={0} withBorder={false}>
              <Table.ScrollContainer minWidth={760}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr><Table.Th>Received</Table.Th><Table.Th>Patient</Table.Th><Table.Th>Request</Table.Th><Table.Th>{view === 'open' ? 'Due' : 'Outcome'}</Table.Th><Table.Th /></Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.map((row) => {
                      const t = row.task;
                      const late = view === 'open' && overdue(t);
                      return (
                        <Table.Tr key={t.id}>
                          <Table.Td className="tm-num"><Text size="sm">{formatAge(t.authoredOn)} ago</Text></Table.Td>
                          <Table.Td fw={600}>{patientName(row.patient)}</Table.Td>
                          <Table.Td>
                            <Text size="sm">{medicationOf(t)}</Text>
                            <Text size="xs" c="dimmed">From {t.requester?.display ?? 'unknown'}{(t.note?.[0]?.text ?? patientNote(t)) ? ` · ${t.note?.[0]?.text ?? patientNote(t)}` : ''}</Text>
                            {t.owner?.reference !== me && view === 'open' && <Text size="xs" c="dimmed">For another prescriber</Text>}
                          </Table.Td>
                          <Table.Td>
                            {view === 'open' ? (
                              <Group gap={6}>
                                <Text size="sm" c={late ? 'red' : undefined} className="tm-num">{formatDate(t.restriction?.period?.end?.slice(0, 10))}</Text>
                                {late && <Badge color="red" variant="light">Overdue</Badge>}
                                {t.businessStatus?.text === 'Escalated' && <Badge color="orange" variant="light">Escalated</Badge>}
                              </Group>
                            ) : (
                              <>
                                <Badge color={t.status === 'completed' ? 'green' : 'gray'} variant="light">{t.status === 'completed' ? 'Approved' : 'Denied'}</Badge>
                                {t.statusReason?.text && <Text size="xs" c="dimmed">{t.statusReason.text}</Text>}
                              </>
                            )}
                          </Table.Td>
                          <Table.Td ta="right">
                            {view === 'open' && (
                              <Group gap={4} justify="flex-end" wrap="nowrap">
                                <Button size="xs" onClick={() => setApproving(row)} disabled={!row.patient || t.owner?.reference !== me}>Approve…</Button>
                                <Button size="xs" variant="default" disabled={!canPrescribe || t.owner?.reference !== me} onClick={() => setDenying(row)}>Deny</Button>
                                {t.businessStatus?.text !== 'Escalated' && <Button size="xs" variant="subtle" color="orange" onClick={() => escalate(row)}>Escalate</Button>}
                              </Group>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          )}
        </Section>
      </Stack>

      {approving?.patient && (
        <PrescribeModal
          opened
          onClose={() => setApproving(undefined)}
          patient={approving.patient}
          renewFrom={approving.prior}
          medication={approving.prior ? undefined : medicationOf(approving.task)}
          renewalTask={approving.task}
          onDone={() => { setApproving(undefined); requests.reload(); }}
        />
      )}
      <DenyModal key={denying?.task.id ?? 'closed'} row={denying} onClose={() => setDenying(undefined)} onDone={() => { setDenying(undefined); requests.reload(); }} />
      <RecordRequestModal key={String(recording)} opened={recording} onClose={() => setRecording(false)} onDone={() => { setRecording(false); requests.reload(); }} />
    </PageBody>
  );
}

function DenyModal({ row, onClose, onDone }: { readonly row?: Row; readonly onClose: () => void; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const deny = async (): Promise<void> => {
    if (!row) return;
    try {
      await medplum.updateResource({ ...row.task, status: 'rejected', statusReason: { text: reason.trim() }, businessStatus: { text: 'Denied' }, lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${row.task.meta?.versionId}"` } });
      setReason('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened={!!row} onClose={onClose} title="Deny renewal request">
      <Stack>
        <Text size="sm">{row ? `${medicationOf(row.task)} for ${patientName(row.patient)}` : ''}</Text>
        <Textarea label="Reason" description="Sent back to the requester. For example: needs a visit first, or medication was stopped." required value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize minRows={2} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Back</Button>
          <Button color="red" onClick={deny} disabled={reason.trim().length < 5}>Deny request</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RecordRequestModal({ opened, onClose, onDone }: { readonly opened: boolean; readonly onClose: () => void; readonly onDone: () => void }): JSX.Element {
  const medplum = useMedplum();
  const canReadPrescriptions = useRoles().roles.includes('provider');
  const [patient, setPatient] = useState<Patient>();
  const [medication, setMedication] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const save = async (): Promise<void> => {
    setError(undefined);
    try {
      if (!patient || !medication) return;
      const owner = patient.generalPractitioner?.find((g) => g.reference?.startsWith('Practitioner/'));
      const profile = medplum.getProfile();
      const prescriber = owner ?? (profile?.resourceType === 'Practitioner' ? createReference(profile) : undefined);
      if (!prescriber) return setError('This patient has no assigned provider. Assign one in Demographics first.');
      const prior = (canReadPrescriptions ? await medplum.searchResources('MedicationRequest', { subject: `Patient/${patient.id}`, status: 'active,completed', _sort: '-_lastUpdated', _count: '50' }, { cache: 'no-cache' }) : [])
        .find((m) => m.medicationCodeableConcept?.text === medication);
      await medplum.createResource(buildRenewalTask({ patient: createReference(patient), prescriber: prescriber as Reference<Practitioner>, prior: prior ? createReference(prior) : undefined, medication, from: from.trim(), note }));
      setPatient(undefined); setMedication(null); setFrom(''); setNote('');
      onDone();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Record renewal request" size="lg">
      <Stack>
        <ResourceInput<Patient> resourceType="Patient" name="patient" label="Patient" required onChange={(p) => setPatient(p)} />
        <Select label="Medication" searchable required data={MEDICATIONS.map((m) => m.name)} value={medication} onChange={setMedication} />
        <TextInput label="Requested by" placeholder="e.g. CVS Pharmacy, Bellevue (fax) or patient by phone" required value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        <Textarea label="Details" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!patient || !medication || from.trim().length < 2}>Record request</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
