import { Alert, Badge, Button, Checkbox, Divider, Group, List, Modal, NumberInput, Paper, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { createReference, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Bundle, Encounter, MedicationRequest, Patient, Task } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconPrescription, IconShieldCheck } from '@tabler/icons-react';
import type { PdmpResult, RxDraft } from '@teleemon/core';
import {
  EXT, MEDICATIONS, PDMP_RESULTS, PDMP_WINDOW_HOURS, SCHEDULE_LABEL, US_STATES, buildMedicationRequest, buildPdmpTask, currentPdmpCheck,
  findMedication, pdmpCheckedAt, prescriptionProblems, readRx,
} from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName, patientState } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { formatAge } from '../utils/format';
import { ERX_LIVE, loadPdmpChecks, loadPrescriber } from './rx';

const UNITS = ['tablet', 'capsule', 'film', 'patch', 'mL'];
const MED_OPTIONS = [
  { group: 'Controlled substances', items: MEDICATIONS.filter((m) => m.schedule).map((m) => ({ value: m.name, label: `${m.name} · ${SCHEDULE_LABEL[m.schedule!]}` })) },
  { group: 'Other medications', items: MEDICATIONS.filter((m) => !m.schedule).map((m) => ({ value: m.name, label: m.name })) },
];

export interface PrescribeProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly patient: Patient;
  /** Visit context: the patient's location for this visit sets the default state. */
  readonly encounter?: Encounter;
  /** An existing draft to continue, or a prescription to renew (its content is copied). */
  readonly draft?: MedicationRequest;
  readonly renewFrom?: MedicationRequest;
  /** Medication named in a renewal request when there is no prior prescription on file. */
  readonly medication?: string;
  /** A renewal request (P26) completed by sending this prescription. */
  readonly renewalTask?: Task;
  readonly onDone: (sent?: MedicationRequest) => void;
}

// P25 Prescribe. The same rules run here (to explain) and in the prescription-rules Bot (to enforce).
export function PrescribeModal(props: PrescribeProps): JSX.Element {
  return (
    <Modal opened={props.opened} onClose={props.onClose} size="xl" title={<Group gap="xs"><IconPrescription size={18} /><Text fw={650}>Prescribe for {patientName(props.patient)}</Text></Group>}>
      {props.opened && <PrescribeForm key={`${props.patient.id}:${props.draft?.id ?? props.renewFrom?.id ?? props.renewalTask?.id ?? 'new'}`} {...props} />}
    </Modal>
  );
}

function PrescribeForm({ patient, encounter, draft, renewFrom, medication, renewalTask, onDone, onClose }: PrescribeProps): JSX.Element {
  const medplum = useMedplum();
  const prescriber = useLoader(() => loadPrescriber(medplum), [medplum]);
  const pdmp = useLoader(() => loadPdmpChecks(medplum, patient), [patient.id]);
  const [busy, setBusy] = useState<'draft' | 'send' | 'pdmp'>();
  const [error, setError] = useState<string>();
  const [pdmpResult, setPdmpResult] = useState<PdmpResult | null>(null);
  const [pdmpNote, setPdmpNote] = useState('');

  const source = draft ?? renewFrom;
  const visitState = encounter ? (getExtensionValue(encounter, EXT.patientLocationState) as string | undefined) : undefined;
  const initial: RxDraft = source
    ? { ...readRx(source), state: visitState ?? readRx(source).state }
    : { medication: medication && findMedication(medication) ? (findMedication(medication)?.name as string) : '', sig: '', quantity: 30, unit: 'tablet', daysSupply: 30, refills: 0, pharmacy: '', state: visitState ?? patientState(patient) ?? '', substitutionAllowed: true, noteToPharmacy: '' };
  const form = useForm<RxDraft>({ initialValues: initial });
  const rx = form.values;
  const entry = findMedication(rx.medication);
  const now = new Date();
  const ownChecks = (pdmp.data ?? []).filter((task) => task.owner?.reference === `Practitioner/${prescriber.data?.id}`);
  const check = rx.state ? currentPdmpCheck(ownChecks, rx.state, now) : undefined;
  const problems = prescriber.data !== undefined || !prescriber.loading ? prescriptionProblems(rx, { practitioner: prescriber.data, pdmpChecks: ownChecks, now }) : [];

  const save = async (send: boolean): Promise<void> => {
    setError(undefined);
    if (!prescriber.data) return setError('Only a provider can prescribe.');
    setBusy(send ? 'send' : 'draft');
    try {
      const resource = buildMedicationRequest(rx, {
        patient: createReference(patient), requester: createReference(prescriber.data), encounter: encounter ? createReference(encounter) : undefined,
        send, pdmpTaskId: entry?.schedule ? check?.id : undefined, base: draft, basedOn: renewFrom ? createReference(renewFrom) : undefined,
      });
      let saved: MedicationRequest;
      if (send && renewalTask) {
        const fullUrl = draft?.id ? `MedicationRequest/${draft.id}` : `urn:uuid:${crypto.randomUUID()}`;
        const transaction: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [
          { fullUrl, resource, request: draft?.id ? { method: 'PUT', url: fullUrl, ifMatch: `W/"${draft.meta?.versionId}"` } : { method: 'POST', url: 'MedicationRequest' } },
          { resource: { ...renewalTask, status: 'completed', businessStatus: { text: 'Approved' }, lastModified: new Date().toISOString(), output: [{ type: { text: 'prescription' }, valueReference: { reference: fullUrl } }] }, request: { method: 'PUT', url: `Task/${renewalTask.id}`, ifMatch: `W/"${renewalTask.meta?.versionId}"` } },
        ] };
        const result = await medplum.executeBatch(transaction);
        const id = /MedicationRequest\/([^/]+)/.exec(result.entry?.[0]?.response?.location ?? '')?.[1] ?? draft?.id;
        if (!id) throw new Error('The renewal was saved. Refresh the prescription list before taking another action.');
        saved = await medplum.readResource('MedicationRequest', id);
      } else {
        saved = draft?.id
          ? await medplum.updateResource(resource, { headers: { 'If-Match': `W/"${draft.meta?.versionId}"` } })
          : await medplum.createResource(resource);
      }
      notifications.show({ color: send ? 'green' : 'gray', title: send ? 'Prescription queued' : 'Draft saved', message: send ? (ERX_LIVE ? 'Sending to the pharmacy.' : 'Sandbox: recorded by the mock vendor; no pharmacy receives it.') : 'Send it when ready.' });
      onDone(send ? saved : undefined);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(undefined);
    }
  };

  const recordPdmp = async (): Promise<void> => {
    if (!prescriber.data || !pdmpResult || !rx.state) return;
    setBusy('pdmp');
    try {
      await medplum.createResource(buildPdmpTask({ patient: createReference(patient), practitioner: createReference(prescriber.data), state: rx.state, result: pdmpResult, note: pdmpNote }));
      setPdmpResult(null); setPdmpNote('');
      pdmp.reload();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Stack gap="md">
      {!ERX_LIVE && (
        <Alert color="blue" variant="light" title="Sandbox e-prescribing">
          No e-prescribing vendor is connected yet. Prescriptions follow every rule but are recorded by a mock vendor and never reach a pharmacy. Use synthetic patients only.
        </Alert>
      )}
      {renewalTask && (
        <Alert color="brand" variant="light">Renewal request from {renewalTask.requester?.display ?? 'pharmacy'}. Sending this prescription approves the request.</Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label="Medication" placeholder="Search the catalogue" searchable data={MED_OPTIONS} required {...form.getInputProps('medication')} disabled={!!renewFrom}
          description={entry?.schedule ? undefined : 'Strength and NDC come from the vendor drug database once connected.'} />
        <Select label="Patient location (state)" required searchable data={US_STATES.map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }))} {...form.getInputProps('state')}
          description={visitState ? 'From this visit’s location check' : 'Where the patient is now; licensure and DEA follow the patient.'} />
      </SimpleGrid>
      {entry?.schedule && (
        <Group gap="xs">
          <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>{SCHEDULE_LABEL[entry.schedule]} controlled substance</Badge>
          <Text size="xs" c="dimmed">{entry.schedule === '2' ? 'No refills allowed.' : 'Up to 5 refills.'} PDMP check required within {PDMP_WINDOW_HOURS} hours.{ERX_LIVE ? ' Two-factor EPCS signing happens in the vendor screen.' : ''}</Text>
        </Group>
      )}
      <Textarea label="Directions (sig)" required autosize minRows={2} placeholder="Take 1 tablet by mouth every morning" {...form.getInputProps('sig')} />
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <NumberInput label="Quantity" min={1} required {...form.getInputProps('quantity')} />
        <Select label="Unit" data={UNITS} allowDeselect={false} {...form.getInputProps('unit')} />
        <NumberInput label="Days supply" min={1} max={90} required {...form.getInputProps('daysSupply')} />
        <NumberInput label="Refills" min={0} max={entry?.schedule === '2' ? 0 : entry?.schedule ? 5 : 11} {...form.getInputProps('refills')} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Pharmacy" required placeholder="Name and address, or NCPDP ID" description="The vendor pharmacy directory replaces this field once connected." {...form.getInputProps('pharmacy')} />
        <Textarea label="Note to pharmacy" autosize minRows={1} {...form.getInputProps('noteToPharmacy')} />
      </SimpleGrid>
      <Checkbox label="Substitution allowed (generic)" {...form.getInputProps('substitutionAllowed', { type: 'checkbox' })} />

      {entry?.schedule && rx.state && (
        <Paper withBorder p="md" radius="md">
          <Group gap="xs" mb="xs">
            <IconShieldCheck size={18} />
            <Text fw={650} size="sm">{rx.state} PDMP check</Text>
          </Group>
          {check ? (
            <Group gap="xs">
              <IconCircleCheck size={16} color="var(--mantine-color-green-7)" />
              <Text size="sm">
                Checked {formatAge(pdmpCheckedAt(check))} ago · {PDMP_RESULTS.find((r) => r.value === check.extension?.find((e) => e.url === EXT.pdmpResult)?.valueCode)?.label}
              </Text>
            </Group>
          ) : (
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                Review the {rx.state} prescription-monitoring database now{ERX_LIVE ? ' (PMP Gateway, through the vendor)' : ' (state PDMP website until the PMP Gateway is connected)'}, then record the result. A check must be recorded at the time it is done.
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select label="Result" data={PDMP_RESULTS} value={pdmpResult} onChange={(v) => setPdmpResult(v as PdmpResult | null)} />
                <TextInput label="Note (optional)" value={pdmpNote} onChange={(e) => setPdmpNote(e.currentTarget.value)} />
              </SimpleGrid>
              <Group justify="flex-end">
                <Button size="xs" variant="light" onClick={recordPdmp} loading={busy === 'pdmp'} disabled={!pdmpResult}>
                  I reviewed the {rx.state} PDMP now
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      )}

      <Divider />
      {problems.length > 0 ? (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title="Before sending">
          <List size="sm" spacing={2}>{problems.map((p) => <List.Item key={p}>{p}</List.Item>)}</List>
        </Alert>
      ) : (
        <Alert color="green" variant="light" icon={<IconCircleCheck size={16} />}>All prescribing checks pass. The server repeats them when you send.</Alert>
      )}
      {error && <Alert color="red" variant="light" title="Not saved">{error}</Alert>}

      <Group justify="space-between">
        <Button variant="subtle" color="gray" onClick={onClose}>Close</Button>
        <Group gap="xs">
          {!renewalTask && <Button variant="default" onClick={() => save(false)} loading={busy === 'draft'} disabled={!rx.medication}>Save draft</Button>}
          <Button leftSection={<IconPrescription size={16} />} onClick={() => save(true)} loading={busy === 'send'} disabled={problems.length > 0 || prescriber.loading}>
            Send prescription
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
