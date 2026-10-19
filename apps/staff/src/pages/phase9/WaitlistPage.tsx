import { Alert, Button, Card, Grid, Group, Modal, Select, Stack, Table, Tabs, Text, TextInput, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconCalendarTime, IconClock, IconRefresh, IconSearch, IconUserPlus } from '@tabler/icons-react';
import { ACTIVE_STATUSES, PRACTICE_TIME_ZONE, VISIT_TYPES, availableStarts, busyIntervals, findVisitType, readSettings, zonedDate, zonedTime } from '@teleemon/core';
import type { RecallChannel, WaitlistDraft } from '@teleemon/core';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { loadRecalls, saveRecallTask, completeRecallTask } from '../../operations/recalls';
import type { RecallRow } from '../../operations/recalls';
import { loadWaitlist, promoteWaitlistAppointment, saveWaitlistAppointment, waitlistCandidates } from '../../operations/waitlist';
import type { WaitlistRow } from '../../operations/waitlist';
import { searchPatients } from '../../fhir/patientSearch';
import { loadProviders, loadRange, practiceParts } from '../../fhir/scheduling';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { patientName } from '../../fhir/patient';
import { formatDate, formatTime } from '../../utils/format';
import { StatusBadge, formatTimestamp } from './phase9Format';

const CHANNELS: { value: RecallChannel; label: string }[] = [
  { value: 'consent-review', label: 'Review consent first' },
  { value: 'phone', label: 'Phone (staff handled)' },
  { value: 'portal', label: 'Portal (staff handled)' },
  { value: 'sms', label: 'SMS (consent required)' },
  { value: 'email', label: 'Email (consent required)' },
];

function appointmentPatientRef(appointment: Appointment): string | undefined {
  return appointment.participant.find((part) => part.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
}

function providerName(row: WaitlistRow): string {
  const given = row.provider?.name?.[0]?.given?.join(' ');
  return row.provider ? `${given ? `${given} ` : ''}${row.provider.name?.[0]?.family ?? ''}`.trim() || 'Provider preference' : 'Any available provider';
}

function reasonLabel(row: RecallRow): string {
  return row.task.description ?? row.reasonCode ?? row.task.code?.text ?? 'Follow-up';
}

export function WaitlistPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { roles } = useRoles();
  const allowed = roles.some((role) => ['provider', 'frontdesk', 'admin'].includes(role));
  const waitlist = useLoader(() => allowed ? loadWaitlist(medplum) : Promise.resolve({ rows: [], total: 0 }), [medplum, allowed], 60000);
  const recalls = useLoader(() => allowed ? loadRecalls(medplum) : Promise.resolve([]), [medplum, allowed], 60000);
  const providers = useLoader(() => allowed ? loadProviders(medplum) : Promise.resolve([]), [medplum, allowed], 60000);
  const settings = useLoader(() => allowed ? readSettings(medplum, 'practice') : Promise.resolve({ hours: {}, closures: [] }), [medplum, allowed], 60000);
  const [tab, setTab] = useState<string | null>('waitlist');
  const [search, setSearch] = useState('');
  const [patientQuery, setPatientQuery] = useState('');
  const [patients, setPatients] = useState<Awaited<ReturnType<typeof searchPatients>>>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [searchingPatients, setSearchingPatients] = useState(false);
  const [patientSearchError, setPatientSearchError] = useState('');
  const [visitCode, setVisitCode] = useState('med-mgmt');
  const [preferredProviderId, setPreferredProviderId] = useState<string | null>(null);
  const [modality, setModality] = useState<'video' | 'phone' | 'office'>('video');
  const [preferredDate, setPreferredDate] = useState('');
  const [preferredFrom, setPreferredFrom] = useState('');
  const [preferredTo, setPreferredTo] = useState('');
  const [waitlistNote, setWaitlistNote] = useState('');
  const [savingWaitlist, setSavingWaitlist] = useState(false);
  const [waitlistError, setWaitlistError] = useState('');
  const [selectedRow, setSelectedRow] = useState<WaitlistRow>();
  const [promoteDate, setPromoteDate] = useState(() => zonedDate(new Date()));
  const [promoteProviderId, setPromoteProviderId] = useState<string | null>(null);
  const [promoteModality, setPromoteModality] = useState<'video' | 'phone' | 'office'>('video');
  const [promoteTime, setPromoteTime] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');
  const [recallDue, setRecallDue] = useState(() => zonedDate(new Date()));
  const [recallReason, setRecallReason] = useState('routine-follow-up');
  const [recallChannel, setRecallChannel] = useState<RecallChannel>('consent-review');
  const [savingRecall, setSavingRecall] = useState(false);
  const [recallError, setRecallError] = useState('');
  const [completingId, setCompletingId] = useState<string>();

  const selectedPatient = patients.find((patient) => patient.id === selectedPatientId);
  const providerOptions = (providers.data ?? []).map((item) => ({ value: item.practitioner.id as string, label: [item.practitioner.name?.[0]?.given?.join(' '), item.practitioner.name?.[0]?.family].filter(Boolean).join(' ') || 'Provider' }));
  const visitType = findVisitType(visitCode);
  const filteredWaitlist = useMemo(() => (waitlist.data?.rows ?? []).filter((row) => {
    const term = search.trim().toLowerCase();
    const appointment = row.appointment;
    const type = appointment.appointmentType?.text ?? appointment.appointmentType?.coding?.[0]?.display ?? '';
    const preferred = appointment.requestedPeriod?.[0];
    const date = preferred?.start ? formatDate(practiceParts(preferred.start).ymd) : '';
    return !term || `${row.patient ? patientName(row.patient) : appointmentPatientRef(appointment)} ${type} ${providerName(row)} ${date}`.toLowerCase().includes(term);
  }), [waitlist.data, search]);
  const filteredRecalls = useMemo(() => (recalls.data ?? []).filter((row) => {
    const term = search.trim().toLowerCase();
    return !term || `${row.patient ? patientName(row.patient) : row.task.for?.reference} ${reasonLabel(row)} ${row.channel}`.toLowerCase().includes(term);
  }), [recalls.data, search]);

  const refreshPatients = async (): Promise<void> => {
    if (!patientQuery.trim()) { setPatientSearchError('Enter a patient name, date of birth, phone, email or chart number.'); return; }
    setSearchingPatients(true);
    setPatientSearchError('');
    setSelectedPatientId(null);
    try {
      const found = await searchPatients(medplum, patientQuery, 25);
      setPatients(found);
      if (!found.length) setPatientSearchError('No patient matched that search. Try another name or identifier.');
    } catch (error) {
      setPatients([]);
      setPatientSearchError(error instanceof Error ? error.message : 'Patient search failed.');
    } finally { setSearchingPatients(false); }
  };

  const saveWaitlist = async (): Promise<void> => {
    if (!selectedPatient?.id || !visitType || savingWaitlist) return;
    setSavingWaitlist(true);
    setWaitlistError('');
    try {
      const draft: WaitlistDraft = {
        patient: { reference: `Patient/${selectedPatient.id}`, display: patientName(selectedPatient) },
        visitTypeCode: visitType.code,
        visitTypeLabel: visitType.label,
        ...(preferredProviderId ? { provider: { reference: `Practitioner/${preferredProviderId}` } } : {}),
        modality,
        ...(preferredDate && preferredFrom ? { preferredStart: zonedTime(preferredDate, Number(preferredFrom.slice(0, 2)), Number(preferredFrom.slice(3, 5)), PRACTICE_TIME_ZONE).toISOString() } : {}),
        ...(preferredDate && preferredTo ? { preferredEnd: zonedTime(preferredDate, Number(preferredTo.slice(0, 2)), Number(preferredTo.slice(3, 5)), PRACTICE_TIME_ZONE).toISOString() } : {}),
        note: waitlistNote,
      };
      await saveWaitlistAppointment(medplum, draft);
      notifications.show({ color: 'brand', message: 'Patient added to the waitlist.' });
      setSelectedPatientId(null); setPreferredDate(''); setPreferredFrom(''); setPreferredTo(''); setWaitlistNote('');
      waitlist.reload();
    } catch (error) {
      setWaitlistError(error instanceof Error ? error.message : 'The waitlist request could not be saved.');
    } finally { setSavingWaitlist(false); }
  };

  const openPromotion = (row: WaitlistRow): void => {
    setSelectedRow(row);
    setPromoteDate(zonedDate(new Date()));
    const providerId = row.provider?.id ?? providers.data?.[0]?.practitioner.id ?? null;
    setPromoteProviderId(providerId);
    const storedModality = row.appointment.extension?.find((extension) => extension.url === 'https://fhir.teleemon.com/StructureDefinition/visit-modality')?.valueCode;
    const rowVisitType = findVisitType(row.appointment.appointmentType?.coding?.find((coding) => coding.code)?.code);
    const defaultModality = storedModality === 'phone' || storedModality === 'office' ? storedModality : rowVisitType?.modality ?? 'video';
    setPromoteModality(defaultModality);
    setPromoteTime(null);
    setPromoteError('');
  };

  const promoteProvider = providers.data?.find((item) => item.practitioner.id === promoteProviderId);
  const promotionVisitCode = selectedRow?.appointment.appointmentType?.coding?.find((coding) => coding.code)?.code;
  const promotionVisitType = findVisitType(promotionVisitCode) ?? visitType;
  const availability = useLoader(async () => {
    if (!selectedRow || !promoteProvider || !promotionVisitType) return { starts: [] as string[], error: undefined as string | undefined };
    const start = zonedTime(promoteDate, 0, 0, PRACTICE_TIME_ZONE).toISOString();
    const end = zonedTime(promoteDate, 23, 59, PRACTICE_TIME_ZONE).toISOString();
    const { items, blocked } = await loadRange(medplum, start, end);
    const providerRef = `Practitioner/${promoteProvider.practitioner.id}`;
    const mine = items.filter((item) => item.practitionerRef === providerRef && ACTIVE_STATUSES.includes(item.appointment.status)).map((item) => item.appointment);
    const scheduleRef = `Schedule/${promoteProvider.schedule.id}`;
    const blocks = blocked.filter((slot) => slot.schedule.reference === scheduleRef);
    const busy = busyIntervals(mine, blocks);
    const closures = (settings.data?.closures ?? []).map((closure) => closure.date);
    const starts = availableStarts(promoteDate, promotionVisitType.minutes, busy, { hours: settings.data?.hours, closures });
    return {
      starts: starts.filter((slotStart) => {
        const interval = { start: slotStart, end: new Date(Date.parse(slotStart) + promotionVisitType.minutes * 60000).toISOString() };
        return waitlistCandidates([selectedRow], interval, { providerRef, modality: promoteModality }).length > 0;
      }),
      error: undefined as string | undefined,
    };
  }, [medplum, selectedRow?.appointment.id, promoteDate, promoteProviderId, promoteModality, promotionVisitType?.minutes, settings.data], 0);

  const schedulePatient = async (): Promise<void> => {
    if (!selectedRow?.appointment.id || !promoteProviderId || !promoteTime || !promotionVisitType || promoting) return;
    setPromoting(true);
    setPromoteError('');
    const start = zonedTime(promoteDate, Number(promoteTime.slice(0, 2)), Number(promoteTime.slice(3, 5)), PRACTICE_TIME_ZONE).toISOString();
    const end = new Date(Date.parse(start) + promotionVisitType.minutes * 60000).toISOString();
    try {
      await promoteWaitlistAppointment(medplum, selectedRow.appointment.id, { start, end }, { reference: `Practitioner/${promoteProviderId}` }, promoteModality);
      notifications.show({ color: 'brand', message: 'Appointment booked. No patient message was sent.' });
      setSelectedRow(undefined); waitlist.reload();
    } catch (error) {
      setPromoteError(error instanceof Error ? error.message : 'The slot could not be booked. Refresh availability and try again.');
      availability.reload();
    } finally { setPromoting(false); }
  };

  const createRecall = async (): Promise<void> => {
    if (!selectedPatient?.id || savingRecall) return;
    setSavingRecall(true); setRecallError('');
    try {
      const reasonLabel = recallReason === 'measure-recheck' ? 'Measure recheck' : recallReason === 'medication-monitoring' ? 'Medication monitoring' : 'Routine follow-up';
      await saveRecallTask(medplum, {
        patient: createReference(selectedPatient),
        dueDate: recallDue,
        reasonCode: recallReason,
        reasonLabel,
        channel: recallChannel,
        ...(profile?.resourceType === 'Practitioner' ? { requester: createReference(profile) } : {}),
      });
      notifications.show({ color: 'brand', message: 'Follow-up task created. No message was sent to the patient.' });
      recalls.reload(); setSelectedPatientId(null);
    } catch (error) {
      setRecallError(error instanceof Error ? error.message : 'The follow-up task could not be saved.');
    } finally { setSavingRecall(false); }
  };

  const completeRecall = async (row: RecallRow): Promise<void> => {
    if (!row.task.id || completingId) return;
    setCompletingId(row.task.id);
    try {
      await completeRecallTask(medplum, row.task.id);
      notifications.show({ color: 'brand', message: 'Follow-up task completed.' });
      recalls.reload();
    } catch (error) {
      notifications.show({ color: 'red', message: error instanceof Error ? error.message : 'Could not complete the task.' });
    } finally { setCompletingId(undefined); }
  };

  const patientSearchControls = <Group align="flex-end" wrap="wrap">
    <TextInput label="Find patient" placeholder="Name, DOB, phone or chart number" leftSection={<IconSearch size={15} />} value={patientQuery} onChange={(event) => setPatientQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void refreshPatients(); }} />
    <Button variant="default" onClick={() => void refreshPatients()} loading={searchingPatients}>Search</Button>
    {patients.length > 0 && <Select label="Choose patient" placeholder="Select a patient" data={patients.map((patient) => ({ value: patient.id as string, label: `${patientName(patient)}${patient.birthDate ? ` · DOB ${formatDate(patient.birthDate)}` : ''}` }))} value={selectedPatientId} onChange={setSelectedPatientId} searchable clearable w={300} />}
  </Group>;

  return (
    <PageBody wide>
      <PageHeader eyebrow="P06 · Daily work" title="Waitlist & recalls" subtitle="Fill open appointment slots and keep follow-up work visible. Patient contact remains staff-handled." actions={<Button variant="default" leftSection={<IconRefresh size={15} />} onClick={() => { waitlist.reload(); recalls.reload(); }} loading={waitlist.loading || recalls.loading}>Refresh</Button>} />
      {!allowed ? <Alert color="red" variant="light" title="Access unavailable">This worklist is limited to providers, front desk and administrators.</Alert> : (
        <Stack gap="lg">
          <Alert color="blue" variant="light" icon={<IconClock size={16} />} title="No automatic outreach">Adding to the waitlist or creating a recall does not send email, SMS, portal, or phone messages. Booking into an offered slot changes the appointment; the provider schedule and server checks still apply.</Alert>
          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List><Tabs.Tab value="waitlist" leftSection={<IconCalendarTime size={15} />}>Waitlist</Tabs.Tab><Tabs.Tab value="recalls" leftSection={<IconClock size={15} />}>Follow-up tasks</Tabs.Tab></Tabs.List>
            <Tabs.Panel value="waitlist" pt="md">
              <Stack gap="md">
                <Card>
                  <Stack gap="md">
                    <div><Title order={2}>Add a patient to the waitlist</Title><Text size="sm" c="dimmed" mt={3}>A preferred time range is optional. The patient must have no future booked visit before a request can be saved.</Text></div>
                    {patientSearchControls}
                    {patientSearchError && <Text size="sm" c={patientSearchError.startsWith('No patient') ? 'dimmed' : 'red'}>{patientSearchError}</Text>}
                    <Grid gutter="sm" align="flex-end">
                      <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Visit type" data={VISIT_TYPES.map((item) => ({ value: item.code, label: `${item.label} · ${item.minutes} min` }))} value={visitCode} onChange={(value) => { const next = VISIT_TYPES.find((item) => item.code === value); if (next) { setVisitCode(next.code); setModality(next.modality); } }} allowDeselect={false} /></Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Preferred provider" placeholder="Any provider" data={providerOptions} value={preferredProviderId} onChange={setPreferredProviderId} clearable searchable /></Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Modality" data={[{ value: 'video', label: 'Video' }, { value: 'phone', label: 'Phone' }, { value: 'office', label: 'Office' }]} value={modality} onChange={(value) => setModality((value as typeof modality | null) ?? 'video')} allowDeselect={false} /></Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 4 }}><TextInput type="date" label="Preferred date (optional)" value={preferredDate} onChange={(event) => setPreferredDate(event.currentTarget.value)} /></Grid.Col>
                      <Grid.Col span={{ base: 6, sm: 4 }}><TextInput type="time" label="Earliest time" value={preferredFrom} onChange={(event) => setPreferredFrom(event.currentTarget.value)} disabled={!preferredDate} /></Grid.Col>
                      <Grid.Col span={{ base: 6, sm: 4 }}><TextInput type="time" label="Latest time" value={preferredTo} onChange={(event) => setPreferredTo(event.currentTarget.value)} disabled={!preferredDate} /></Grid.Col>
                    </Grid>
                    <Textarea label="Staff note (optional)" maxLength={500} value={waitlistNote} onChange={(event) => setWaitlistNote(event.currentTarget.value)} />
                    {waitlistError && <Alert color="red" variant="light">{waitlistError}</Alert>}
                    <Group justify="flex-end"><Button leftSection={<IconUserPlus size={15} />} onClick={() => void saveWaitlist()} loading={savingWaitlist} disabled={!selectedPatient}>Add to waitlist</Button></Group>
                  </Stack>
                </Card>
                <Card>
                  <Group justify="space-between" align="flex-end" wrap="wrap" mb="md"><div><Title order={2}>Current waitlist</Title><Text size="sm" c="dimmed" mt={3}>{waitlist.data?.total ?? 0} requests · oldest first for eligible slot matching</Text></div><TextInput label="Filter list" placeholder="Patient, visit type or provider" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></Group>
                  {waitlist.error ? <ErrorState error={waitlist.error} onRetry={waitlist.reload} /> : waitlist.loading && !waitlist.data ? <RowsSkeleton rows={6} /> : !filteredWaitlist.length ? <EmptyState icon={<IconCalendarTime size={20} />} title="No waitlist requests">Add a patient above to keep their preferred visit visible.</EmptyState> : (
                    <Table.ScrollContainer minWidth={850}><Table striped highlightOnHover verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Visit</Table.Th><Table.Th>Preference</Table.Th><Table.Th>Added</Table.Th><Table.Th>Status</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
                      {filteredWaitlist.map((row) => {
                        const appointment = row.appointment;
                        const period = appointment.requestedPeriod?.[0];
                        const start = period?.start ? formatTimestamp(period.start) : 'Any time';
                        const type = appointment.appointmentType?.text ?? appointment.appointmentType?.coding?.[0]?.display ?? 'Visit';
                        return <Table.Tr key={appointment.id}><Table.Td><Text fw={600}>{row.patient ? patientName(row.patient) : appointmentPatientRef(appointment) ?? 'Patient not linked'}</Text></Table.Td><Table.Td>{type}</Table.Td><Table.Td><Text size="sm">{providerName(row)}</Text><Text size="xs" c="dimmed">{start}{period?.end ? ` – ${formatTimestamp(period.end)}` : ''}</Text></Table.Td><Table.Td className="tm-num">{appointment.created ? formatDate(appointment.created.slice(0, 10)) : '—'}</Table.Td><Table.Td>{row.futureVisitBooked ? <StatusBadge status="pending" label="Upcoming visit already booked" /> : <StatusBadge status="waitlist" label="Waiting" />}</Table.Td><Table.Td ta="right"><Button size="xs" onClick={() => openPromotion(row)} disabled={!appointment.id || !row.patient || row.futureVisitBooked || !providers.data?.length}>Book a free slot</Button></Table.Td></Table.Tr>;
                      })}
                    </Table.Tbody></Table></Table.ScrollContainer>
                  )}
                </Card>
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="recalls" pt="md">
              <Stack gap="md">
                <Card>
                  <Stack gap="md">
                    <div><Title order={2}>Create a follow-up task</Title><Text size="sm" c="dimmed" mt={3}>Tasks are internal reminders. The system rechecks upcoming appointments and consent before saving.</Text></div>
                    {patientSearchControls}
                    {patientSearchError && <Text size="sm" c={patientSearchError.startsWith('No patient') ? 'dimmed' : 'red'}>{patientSearchError}</Text>}
                    <Grid gutter="sm" align="flex-end">
                      <Grid.Col span={{ base: 12, sm: 3 }}><TextInput type="date" label="Due date" value={recallDue} onChange={(event) => setRecallDue(event.currentTarget.value)} /></Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Reason" data={[{ value: 'routine-follow-up', label: 'Routine follow-up' }, { value: 'measure-recheck', label: 'Measure recheck' }, { value: 'medication-monitoring', label: 'Medication monitoring' }]} value={recallReason} onChange={(value) => setRecallReason(value ?? 'routine-follow-up')} allowDeselect={false} /></Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 5 }}><Select label="Intended channel" data={CHANNELS} value={recallChannel} onChange={(value) => setRecallChannel((value as RecallChannel | null) ?? 'consent-review')} allowDeselect={false} /></Grid.Col>
                    </Grid>
                    <Alert color="orange" variant="light" title="Staff follow-up only">Choose “Review consent first” when current channel consent is unknown. SMS, email, phone and portal tasks never send a message from this screen; the save operation rechecks consent and contact details.</Alert>
                    {recallError && <Alert color="red" variant="light">{recallError}</Alert>}
                    <Group justify="flex-end"><Button onClick={() => void createRecall()} loading={savingRecall} disabled={!selectedPatient}>Create task</Button></Group>
                  </Stack>
                </Card>
                <Card>
                  <Group justify="space-between" align="flex-end" wrap="wrap" mb="md"><div><Title order={2}>Open follow-ups</Title><Text size="sm" c="dimmed" mt={3}>Patients with a future booked visit are excluded from this list.</Text></div><TextInput label="Filter list" placeholder="Patient, reason or channel" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></Group>
                  {recalls.error ? <ErrorState error={recalls.error} onRetry={recalls.reload} /> : recalls.loading && !recalls.data ? <RowsSkeleton rows={6} /> : !filteredRecalls.length ? <EmptyState icon={<IconClock size={20} />} title="No open follow-up tasks">Create an internal task for a patient who is due to return.</EmptyState> : (
                    <Table.ScrollContainer minWidth={820}><Table striped highlightOnHover verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>Patient</Table.Th><Table.Th>Due</Table.Th><Table.Th>Reason</Table.Th><Table.Th>Channel</Table.Th><Table.Th>Consent</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
                      {filteredRecalls.map((row) => <Table.Tr key={row.task.id}><Table.Td>{row.patient ? patientName(row.patient) : row.task.for?.reference ?? 'Patient not linked'}</Table.Td><Table.Td className="tm-num">{formatDate((row.task.executionPeriod?.end ?? row.task.authoredOn ?? '').slice(0, 10))}</Table.Td><Table.Td>{reasonLabel(row)}</Table.Td><Table.Td>{CHANNELS.find((channel) => channel.value === row.channel)?.label ?? row.channel}</Table.Td><Table.Td><StatusBadge status={row.consent} /></Table.Td><Table.Td ta="right"><Button size="xs" variant="default" onClick={() => void completeRecall(row)} loading={completingId === row.task.id} disabled={!row.task.id}>Mark done</Button></Table.Td></Table.Tr>)}
                    </Table.Tbody></Table></Table.ScrollContainer>
                  )}
                </Card>
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}

      <Modal opened={!!selectedRow} onClose={() => !promoting && setSelectedRow(undefined)} title="Book this patient into a free slot" size="lg" centered>
        {selectedRow && <Stack>
          <Alert color="blue" variant="light" title="The patient will be booked">This action changes the appointment status after you select an available provider and time. The server performs its own conflict and licensure checks. No patient notification is sent.</Alert>
          <Text fw={600}>{selectedRow.patient ? patientName(selectedRow.patient) : appointmentPatientRef(selectedRow.appointment)}</Text>
          <Grid gutter="sm" align="flex-end">
            <Grid.Col span={{ base: 12, sm: 4 }}><TextInput type="date" label="Date" value={promoteDate} onChange={(event) => { setPromoteDate(event.currentTarget.value); setPromoteTime(null); }} /></Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Provider" data={providerOptions} value={promoteProviderId} onChange={(value) => { setPromoteProviderId(value); setPromoteTime(null); }} searchable allowDeselect={false} /></Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Modality" data={[{ value: 'video', label: 'Video' }, { value: 'phone', label: 'Phone' }, { value: 'office', label: 'Office' }]} value={promoteModality} onChange={(value) => { setPromoteModality((value as typeof promoteModality | null) ?? 'video'); setPromoteTime(null); }} allowDeselect={false} /></Grid.Col>
            <Grid.Col span={12}><Select label={`Available start time · ${promotionVisitType?.minutes ?? 30} minutes`} placeholder={availability.loading ? 'Checking free times…' : 'Select a free time'} data={(availability.data?.starts ?? []).map((start) => ({ value: practiceParts(start).hhmm, label: `${formatTime(start)} · ${formatDate(practiceParts(start).ymd)}` }))} value={promoteTime} onChange={setPromoteTime} searchable disabled={availability.loading || !availability.data?.starts.length} /></Grid.Col>
          </Grid>
          {availability.error && <ErrorState error={availability.error} onRetry={availability.reload} />}
          {!availability.loading && !availability.error && availability.data && !availability.data.starts.length && <Text size="sm" c="dimmed">No free time on this date matches the request and appointment duration. Try another day or provider.</Text>}
          {promoteError && <Alert color="red" variant="light">{promoteError}</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={() => setSelectedRow(undefined)} disabled={promoting}>Cancel</Button><Button onClick={() => void schedulePatient()} loading={promoting} disabled={!promoteTime || !promoteProviderId}>Book appointment</Button></Group>
        </Stack>}
      </Modal>
    </PageBody>
  );
}
