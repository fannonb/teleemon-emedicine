import { Alert, Badge, Card, Group, SegmentedControl, Stack, Table, Text, Tooltip } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { MedicationRequest, Patient, Resource, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconPrescription, IconShieldCheck } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT, PDMP_RESULTS, SCHEDULE_LABEL, erxStatus, pdmpCheckedAt, pdmpState, readRx, rxSchedule } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../components/PageHeader';
import { Section } from '../components/Section';
import { patientName } from '../fhir/patient';
import { useLoader } from '../hooks/useLoader';
import { formatAge, formatDate } from '../utils/format';
import { ERX_LIVE, rxDisplay } from './rx';

type View = 'attention' | 'sent' | 'pdmp';

async function withPatients<T extends Resource>(bundle: { entry?: { resource?: Resource }[] }, type: T['resourceType']): Promise<{ item: T; patient?: Patient }[]> {
  const patients = new Map<string, Patient>();
  const items: T[] = [];
  for (const e of bundle.entry ?? []) {
    if (e.resource?.resourceType === 'Patient') patients.set(`Patient/${e.resource.id}`, e.resource);
    else if (e.resource?.resourceType === type) items.push(e.resource as T);
  }
  const subjectOf = (r: Resource): string | undefined => (r.resourceType === 'Task' ? r.for?.reference : r.resourceType === 'MedicationRequest' ? r.subject?.reference : undefined);
  return items.map((item) => ({ item, patient: patients.get(subjectOf(item) ?? '') }));
}

// P25 E-prescribing: the prescriber's outgoing queue and PDMP checks. Prescriptions are written
// from the chart (Medications) or the visit (Prescribe), where the patient context is.
export function ErxPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('attention');
  const me = profile ? getReferenceString(profile) : '';
  const since = new Date(Date.now() - 7 * 86400000).toISOString();

  const rx = useLoader(async () => {
    const bundle = await medplum.search('MedicationRequest', new URLSearchParams([['requester', me], ['_lastUpdated', `ge${since.slice(0, 10)}`], ['_sort', '-_lastUpdated'], ['_count', '200'], ['_include', 'MedicationRequest:subject']] as [string, string][]), { cache: 'no-cache' });
    return withPatients<MedicationRequest>(bundle, 'MedicationRequest');
  }, [me], 10000);
  const pdmp = useLoader(async () => {
    const bundle = await medplum.search('Task', new URLSearchParams([['owner', me], ['code', `${CODE_SYSTEMS.taskCode}|pdmp-check`], ['_sort', '-_lastUpdated'], ['_count', '100'], ['_include', 'Task:subject']] as [string, string][]), { cache: 'no-cache' });
    return withPatients<Task>(bundle, 'Task');
  }, [me]);

  const rows = (rx.data ?? []).filter(({ item }) => item.status !== 'entered-in-error');
  const attention = rows.filter(({ item }) => item.status === 'draft' || ['failed', 'queued', 'sending', 'cancel-requested'].includes(erxStatus(item) ?? ''));
  const sent = rows.filter(({ item }) => ['sent', 'cancelled'].includes(erxStatus(item) ?? ''));
  const open = (p?: Patient): void => { if (p) navigate(`/patients/${p.id}/medications`); };

  const rxTable = (list: typeof rows): JSX.Element => (
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Prescription</Table.Th><Table.Th>Written</Table.Th><Table.Th>Status</Table.Th></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.map(({ item, patient }) => {
            const r = readRx(item);
            const schedule = rxSchedule(item);
            const d = rxDisplay(item);
            return (
              <Table.Tr key={item.id} style={{ cursor: 'pointer' }} onClick={() => open(patient)}>
                <Table.Td fw={600}>{patientName(patient)}</Table.Td>
                <Table.Td>
                  <Group gap={6}><Text size="sm">{r.medication}</Text>{schedule && <Badge color="red" variant="light">{SCHEDULE_LABEL[schedule]}</Badge>}</Group>
                  <Text size="xs" c="dimmed">{r.sig} · #{r.quantity} · {r.pharmacy}</Text>
                </Table.Td>
                <Table.Td className="tm-num">{formatDate(item.authoredOn?.slice(0, 10))}</Table.Td>
                <Table.Td>
                  <Tooltip label={erxStatus(item) === 'failed' ? item.extension?.find((e) => e.url === EXT.erxError)?.valueString ?? d.hint : d.hint}>
                    <Badge color={d.color} variant="light">{d.label}</Badge>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );

  return (
    <PageBody>
      <PageHeader eyebrow="P25 · Clinical work" title="E-prescribing" subtitle="Your prescriptions from the last 7 days and your PDMP checks. Write prescriptions from a patient’s Medications tab or from the visit." />
      <Stack gap="lg">
        {!ERX_LIVE && (
          <Alert color="blue" variant="light" title="Sandbox: no e-prescribing vendor connected">
            Every prescribing rule is enforced, but a mock vendor records prescriptions and no pharmacy receives them. EPCS two-factor signing, the pharmacy directory, drug database and PMP Gateway arrive with the vendor integration.
          </Alert>
        )}
        <SegmentedControl
          value={view}
          onChange={(v) => setView(v as View)}
          data={[
            { value: 'attention', label: `Needs attention${attention.length ? ` (${attention.length})` : ''}` },
            { value: 'sent', label: 'Sent' },
            { value: 'pdmp', label: 'PDMP checks' },
          ]}
          style={{ alignSelf: 'flex-start' }}
        />
        {view !== 'pdmp' ? (
          <Section
            loaded={rx}
            padding="md"
            isEmpty={() => (view === 'attention' ? attention : sent).length === 0}
            empty={view === 'attention'
              ? { icon: <IconPrescription size={22} />, title: 'Nothing waiting', text: 'Drafts, prescriptions being sent and failed transmissions appear here.' }
              : { icon: <IconPrescription size={22} />, title: 'No prescriptions sent this week', text: 'Sent and cancelled prescriptions from the last 7 days appear here.' }}
          >
            {() => <Card padding={0} withBorder={false}>{rxTable(view === 'attention' ? attention : sent)}</Card>}
          </Section>
        ) : (
          <Section loaded={pdmp} padding="md" isEmpty={(l) => l.length === 0} empty={{ icon: <IconShieldCheck size={22} />, title: 'No PDMP checks recorded', text: 'Checks are recorded from the prescribe form when a controlled substance is chosen.' }}>
            {(list) => (
              <Table.ScrollContainer minWidth={620}>
                <Table verticalSpacing="sm" highlightOnHover>
                  <Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>State</Table.Th><Table.Th>Checked</Table.Th><Table.Th>Result</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {list.map(({ item, patient }) => (
                      <Table.Tr key={item.id} style={{ cursor: 'pointer', opacity: item.status === 'entered-in-error' ? 0.5 : 1 }} onClick={() => open(patient)}>
                        <Table.Td fw={600}>{patientName(patient)}</Table.Td>
                        <Table.Td>{pdmpState(item)}</Table.Td>
                        <Table.Td className="tm-num">{formatAge(pdmpCheckedAt(item))} ago</Table.Td>
                        <Table.Td>
                          <Text size="sm">{item.status === 'entered-in-error' ? 'Entered in error' : PDMP_RESULTS.find((r) => r.value === item.extension?.find((e) => e.url === EXT.pdmpResult)?.valueCode)?.label}</Text>
                          {item.note?.[0]?.text && <Text size="xs" c="dimmed">{item.note[0].text}</Text>}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Section>
        )}
      </Stack>
    </PageBody>
  );
}
