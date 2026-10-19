import { Badge, Button, Group, Menu, Modal, Table, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Encounter, MedicationRequest, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconDots, IconPrescription } from '@tabler/icons-react';
import { EXT, SCHEDULE_LABEL, erxStatus, readRx, rxSchedule } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../components/Section';
import { useLoader } from '../hooks/useLoader';
import { formatDate } from '../utils/format';
import { PrescribeModal } from './PrescribeModal';
import { loadPrescriptions, rxDisplay } from './rx';

const withErx = (mr: MedicationRequest, status: string, rxStatus?: MedicationRequest['status']): MedicationRequest => ({
  ...mr,
  status: rxStatus ?? mr.status,
  extension: [...(mr.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: status }],
});

/** Prescriptions on the chart (P14/P25): drafts, sending, sent, failed and cancelled, with actions. */
export function PrescriptionsCard({ patient, encounter, canPrescribe, onChange }: { readonly patient: Patient; readonly encounter?: Encounter; readonly canPrescribe: boolean; readonly onChange?: () => void }): JSX.Element {
  const medplum = useMedplum();
  const list = useLoader(() => loadPrescriptions(medplum, patient), [patient.id], 8000);
  const [modal, setModal] = useState<{ draft?: MedicationRequest; renewFrom?: MedicationRequest }>();

  const update = async (mr: MedicationRequest, next: MedicationRequest, done: string): Promise<void> => {
    try {
      await medplum.updateResource(next, { headers: { 'If-Match': `W/"${mr.meta?.versionId}"` } });
      notifications.show({ color: 'gray', title: done, message: readRx(mr).medication });
      list.reload();
      onChange?.();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not changed', message: normalizeErrorString(err) });
    }
  };
  const [cancelling, setCancelling] = useState<MedicationRequest>();

  return (
    <>
      <Section
        title="Prescriptions"
        loaded={list}
        actions={canPrescribe ? <Button size="xs" leftSection={<IconPrescription size={14} />} onClick={() => setModal({})}>Prescribe</Button> : undefined}
        isEmpty={(l) => l.filter((m) => m.status !== 'entered-in-error').length === 0}
        empty={{ icon: <IconPrescription size={22} />, title: 'No prescriptions yet', text: canPrescribe ? 'Prescriptions you send appear here and on the medication list.' : 'Prescriptions sent by the provider appear here.' }}
      >
        {(rows) => (
          <Table.ScrollContainer minWidth={620}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Prescription</Table.Th>
                  <Table.Th>Written</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.filter((m) => m.status !== 'entered-in-error').map((mr) => {
                  const rx = readRx(mr);
                  const schedule = rxSchedule(mr);
                  const display = rxDisplay(mr);
                  const state = erxStatus(mr);
                  return (
                    <Table.Tr key={mr.id}>
                      <Table.Td>
                        <Group gap={6}>
                          <Text size="sm" fw={600}>{rx.medication}</Text>
                          {schedule && <Badge color="red" variant="light">{SCHEDULE_LABEL[schedule]}</Badge>}
                        </Group>
                        <Text size="xs" c="dimmed">{rx.sig} · #{rx.quantity} {rx.unit} · {rx.daysSupply} days · {rx.refills} refill{rx.refills === 1 ? '' : 's'}</Text>
                        <Text size="xs" c="dimmed">{rx.pharmacy}{rx.state ? ` · patient in ${rx.state}` : ''}</Text>
                      </Table.Td>
                      <Table.Td className="tm-num">{formatDate(mr.authoredOn?.slice(0, 10))}</Table.Td>
                      <Table.Td>
                        <Tooltip label={state === 'failed' ? mr.extension?.find((e) => e.url === EXT.erxError)?.valueString ?? display.hint : display.hint}>
                          <Badge color={display.color} variant="light">{display.label}</Badge>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td ta="right">
                        {canPrescribe && (
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            {mr.status === 'draft' && <Button size="xs" variant="light" onClick={() => setModal({ draft: mr })}>Review & send</Button>}
                            {state === 'failed' && <Button size="xs" variant="light" onClick={() => update(mr, withErx(mr, 'queued'), 'Retry queued')}>Retry</Button>}
                            <Menu position="bottom-end" withinPortal>
                              <Menu.Target>
                                <Button size="xs" variant="subtle" color="gray" px={6} aria-label="More actions"><IconDots size={14} /></Button>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {mr.status !== 'draft' && <Menu.Item onClick={() => setModal({ renewFrom: mr })}>Renew (new prescription)</Menu.Item>}
                                {mr.status === 'draft' && <Menu.Item color="red" onClick={() => update(mr, { ...mr, status: 'entered-in-error' }, 'Draft discarded')}>Discard draft</Menu.Item>}
                                {mr.status === 'active' && state !== 'cancel-requested' && <Menu.Item color="red" onClick={() => setCancelling(mr)}>Cancel prescription</Menu.Item>}
                              </Menu.Dropdown>
                            </Menu>
                          </Group>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Section>
      <Modal opened={!!cancelling} onClose={() => setCancelling(undefined)} title="Cancel prescription?">
        <Text size="sm">Request cancellation of {cancelling ? readRx(cancelling).medication : ''}. This sandbox records the cancellation locally; no pharmacy is contacted.</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setCancelling(undefined)}>Keep</Button>
          <Button color="red" onClick={() => { const mr = cancelling as MedicationRequest; setCancelling(undefined); void update(mr, withErx(mr, 'cancel-requested', 'cancelled'), 'Cancellation requested'); }}>Cancel prescription</Button>
        </Group>
      </Modal>
      <PrescribeModal
        opened={!!modal}
        onClose={() => setModal(undefined)}
        patient={patient}
        encounter={encounter}
        draft={modal?.draft}
        renewFrom={modal?.renewFrom}
        onDone={() => { setModal(undefined); list.reload(); onChange?.(); }}
      />
    </>
  );
}
