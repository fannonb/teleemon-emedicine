import { Alert, Badge, Button, Card, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MedicationRequest, MedicationStatement, Task } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconPill } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT, RENEWAL_SLA_BUSINESS_DAYS } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { Empty, Show, useLoader } from '../components/states';
import { loadPatient } from '../data';
import { useMe, useSession } from '../session';

interface Med {
  readonly name: string;
  readonly prescription?: MedicationRequest;
  readonly prescriber?: string;
}

const medName = (m: MedicationStatement | MedicationRequest): string => m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? 'Medication';
const medicationOf = (t: Task): string => t.input?.find((i) => i.type.text === 'medication')?.valueString ?? '';
const STATUS: Record<string, { label: string; color: string }> = {
  requested: { label: 'Sent', color: 'blue' }, received: { label: 'Received', color: 'blue' }, accepted: { label: 'In review', color: 'blue' }, 'in-progress': { label: 'In review', color: 'blue' },
  completed: { label: 'Answered', color: 'green' }, rejected: { label: 'Not renewed: call us', color: 'orange' }, cancelled: { label: 'Closed', color: 'gray' },
};

// X07 Refill requests: become the same renewal Tasks as phone and pharmacy requests (P26), answered within the SLA.
export function RefillsPage(): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const data = useLoader(async () => {
    const [statements, prescriptions, requests, patient] = await Promise.all([
      medplum.searchResources('MedicationStatement', { subject: me.patientRef, status: 'active', _count: '100' }, { cache: 'no-cache' }),
      medplum.searchResources('MedicationRequest', { subject: me.patientRef, status: 'active', _count: '100', _sort: '-authoredon' }, { cache: 'no-cache' }),
      medplum.searchResources('Task', { patient: me.patientRef, code: `${CODE_SYSTEMS.taskCode}|rx-renewal`, _sort: '-authored-on', _count: '50' }, { cache: 'no-cache' }),
      loadPatient(medplum, me),
    ]);
    const meds = new Map<string, Med>();
    for (const rx of prescriptions) meds.set(medName(rx).toLowerCase(), { name: medName(rx), prescription: rx, prescriber: rx.requester?.reference });
    for (const s of statements) if (!meds.has(medName(s).toLowerCase())) meds.set(medName(s).toLowerCase(), { name: medName(s) });
    return { meds: [...meds.values()], requests, pcp: patient.generalPractitioner?.find((g) => g.reference?.startsWith('Practitioner/'))?.reference, pharmacy: patient.extension?.find((e) => e.url === EXT.preferredPharmacy)?.valueString };
  }, [medplum, me.patientRef]);
  const [asking, setAsking] = useState<Med>();

  return (
    <Page title="Refills" subtitle={`Request a refill at least ${RENEWAL_SLA_BUSINESS_DAYS + 1} business days before you run out.`}>
      <Show loaded={data}>
        {(d) => (
          <Stack gap="lg">
            {d.meds.length === 0 ? (
              <Empty title="No current medications" text="Medications your provider prescribes appear here." />
            ) : (
              <Stack gap="sm">
                {d.meds.map((m) => {
                  const open = d.requests.find((t) => medicationOf(t).toLowerCase() === m.name.toLowerCase() && ['requested', 'received', 'accepted', 'in-progress'].includes(t.status));
                  return (
                    <Card key={m.name} padding="md">
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap="sm" wrap="nowrap"><IconPill size={20} /><Text fw={600}>{m.name}</Text></Group>
                        {open ? <Badge color="blue">Request sent</Badge> : <Button variant="light" onClick={() => setAsking(m)} disabled={!m.prescriber && !d.pcp}>Request refill</Button>}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            )}
            {d.requests.length > 0 && (
              <Stack gap="xs">
                <Text fw={650}>Your requests</Text>
                {d.requests.map((t) => (
                  <Stack key={t.id} gap={2} py={6} style={{ borderBottom: '1px solid var(--tm-border)' }}>
                    <Group justify="space-between">
                      <Text size="sm">{medicationOf(t)} · {t.authoredOn ? new Date(t.authoredOn).toLocaleDateString() : ''}</Text>
                      <Badge color={STATUS[t.status]?.color ?? 'gray'}>{STATUS[t.status]?.label ?? t.status}</Badge>
                    </Group>
                    {t.statusReason?.text && <Text size="sm" c="dimmed">{t.statusReason.text}</Text>}
                  </Stack>
                ))}
              </Stack>
            )}
            <RequestModal med={asking} owner={asking?.prescriber ?? d.pcp} pharmacy={d.pharmacy} onClose={() => setAsking(undefined)} onSent={() => { setAsking(undefined); data.reload(); }} />
          </Stack>
        )}
      </Show>
    </Page>
  );
}

function RequestModal({ med, owner, pharmacy, onClose, onSent }: { readonly med?: Med; readonly owner?: string; readonly pharmacy?: string; readonly onClose: () => void; readonly onSent: () => void }): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (): Promise<void> => {
    if (!med || !owner) return;
    setBusy(true);
    setError(undefined);
    try {
      await medplum.createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'rx-renewal' }], text: 'Renewal request' },
        for: { reference: me.patientRef },
        requester: { reference: me.actor, display: `Patient portal: ${me.actorName}` },
        owner: { reference: owner },
        focus: med.prescription ? { reference: `MedicationRequest/${med.prescription.id}` } : undefined,
        // Task.note is staff-only (hidden from portal reads), so the patient's words travel as an input.
        input: [{ type: { text: 'medication' }, valueString: med.name }, ...(note.trim() ? [{ type: { text: 'patient note' }, valueString: note.trim().slice(0, 1000) }] : [])],
      });
      notifications.show({ color: 'brand', message: `Refill request for ${med.name} sent.` });
      setNote('');
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={!!med} onClose={onClose} title={`Refill ${med?.name ?? ''}`} centered>
      <Stack>
        <Text size="sm">Pharmacy: {pharmacy ?? 'the pharmacy on your last prescription'}. Change it in your profile.</Text>
        <Textarea label="Anything your provider should know? (optional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={1000} />
        <Text size="xs" c="dimmed">Controlled medications may need a visit before they can be renewed.</Text>
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void send()}>Send request</Button></Group>
      </Stack>
    </Modal>
  );
}
