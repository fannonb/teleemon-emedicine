import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Group,
  Loader,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { createReference, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Appointment, Bundle, BundleEntry, Coverage, Patient, Practitioner, Reference, Slot } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertTriangle, IconCalendarCheck, IconPlayerPlay, IconCircleCheck, IconCopy, IconDownload, IconHistory, IconMapPin } from '@tabler/icons-react';
import type { Modality, Repeat } from '@teleemon/core';
import {
  CANCELLATION_REASONS,
  CODE_SYSTEMS,
  EXT,
  US_STATES,
  VISIT_TYPES,
  availableStarts,
  busyIntervals,
  checkLicensure,
  locationConfirmedExtension,
  findVisitType,
  hoursFor,
  overlaps,
  readSettings,
  repeatStarts,
  zonedTime,
  zonedDate,
  PRACTICE_TIME_ZONE,
  US_STATE_TIME_ZONES,
  formatCents,
  visitFeeCents,
} from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { STATUS_DISPLAY } from '../../fhir/appointments';
import { isSelfPay, patientName, patientState } from '../../fhir/patient';
import { searchPatients } from '../../fhir/patientSearch';
import type { Provider } from '../../fhir/scheduling';
import { downloadIcs, loadRange, practiceParts, toItem } from '../../fhir/scheduling';
import { startVisit } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime, timeZoneAbbrev } from '../../utils/format';
import { latestEligibility } from '../../billing/eligibility';
import { ledgerApi } from '../../billing/ledgerApi';
import { useRoles } from '../../session/roles';

interface Props {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly appointmentId?: string;
  /** Prefill for a new booking (ISO instant), e.g. from clicking an empty calendar slot. */
  readonly initialStart?: string;
  readonly providers: Provider[];
  readonly onSaved: () => void;
}

const BOOKING: Appointment['status'][] = ['proposed', 'pending', 'booked'];

export function AppointmentDrawer({ opened, onClose, appointmentId, initialStart, providers, onSaved }: Props): JSX.Element {
  const medplum = useMedplum();
  const existing = useLoader(async () => {
    if (!appointmentId) return undefined;
    const appt = await medplum.readResource('Appointment', appointmentId, { cache: 'no-cache' });
    const patientRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const patient = patientRef ? await medplum.readReference<Patient>({ reference: patientRef }) : undefined;
    return { appt, patient };
  }, [appointmentId, opened]);

  const title = appointmentId ? 'Appointment' : 'New appointment';
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size={540} title={<Text fw={700}>{title}</Text>} padding="lg" closeButtonProps={{ 'aria-label': 'Close' }}>
      {appointmentId && existing.loading && !existing.data ? (
        <Group justify="center" py="xl">
          <Loader color="brand" />
        </Group>
      ) : existing.error ? (
        <Alert color="red">{normalizeErrorString(existing.error)}</Alert>
      ) : (
        <BookingForm
          key={`${appointmentId ?? 'new'}-${existing.data?.appt.meta?.versionId ?? ''}-${initialStart ?? ''}`}
          appointment={existing.data?.appt}
          initialPatient={existing.data?.patient}
          initialStart={initialStart}
          providers={providers}
          onSaved={() => {
            onSaved();
            existing.reload();
          }}
          onClose={onClose}
        />
      )}
    </Drawer>
  );
}

function BookingForm({
  appointment,
  initialPatient,
  initialStart,
  providers,
  onSaved,
  onClose,
}: {
  readonly appointment?: Appointment;
  readonly initialPatient?: Patient;
  readonly initialStart?: string;
  readonly providers: Provider[];
  readonly onSaved: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const medplum = useMedplum();
  const isNew = !appointment;
  const editable = isNew || BOOKING.includes(appointment.status);
  const startParts = practiceParts(appointment?.start ?? initialStart ?? new Date(Date.now() + 3600000).toISOString());

  const [patient, setPatient] = useState<Patient | undefined>(initialPatient);
  const [providerId, setProviderId] = useState<string>(
    appointment?.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference?.split('/')[1] ?? providers[0]?.practitioner.id ?? ''
  );
  const typeCode = appointment?.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code;
  const [visitCode, setVisitCode] = useState<string>(typeCode ?? 'med-mgmt');
  const [date, setDate] = useState(startParts.ymd);
  const [time, setTime] = useState<string | null>(initialStart || appointment ? startParts.hhmm : null);
  const [minutes, setMinutes] = useState<number>(appointment?.minutesDuration ?? findVisitType(visitCode)?.minutes ?? 30);
  const [modality, setModality] = useState<Modality>((appointment && (getExtensionValue(appointment, EXT.modality) as Modality)) || findVisitType(visitCode)?.modality || 'video');
  const [state, setState] = useState<string | null>((appointment && (getExtensionValue(appointment, EXT.patientLocationState) as string)) || patientState(initialPatient) || null);
  const [link, setLink] = useState((appointment && (getExtensionValue(appointment, EXT.telehealthUrl) as string)) || '');
  const [comment, setComment] = useState(appointment?.comment ?? '');
  const [repeat, setRepeat] = useState<Repeat>('none');
  const [repeatCount, setRepeatCount] = useState<number>(4);
  const [overbook, setOverbook] = useState(!!(appointment && getExtensionValue(appointment, EXT.overbookReason)));
  const [overbookReason, setOverbookReason] = useState((appointment && (getExtensionValue(appointment, EXT.overbookReason) as string)) || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<Appointment[]>();

  const provider = providers.find((p) => p.practitioner.id === providerId);
  const settings = useLoader(() => readSettings(medplum, 'practice'), [medplum]);
  const closures = useMemo(() => (settings.data?.closures ?? []).map((c) => c.date), [settings.data]);

  // The provider's day: appointments and blocked time, to offer only free times.
  const day = useLoader(async () => {
    const start = zonedTime(date, 0, 0, PRACTICE_TIME_ZONE).toISOString();
    const end = zonedTime(date, 23, 59, PRACTICE_TIME_ZONE).toISOString();
    const { items, blocked } = await loadRange(medplum, start, end);
    const mine = items.filter((i) => i.practitionerRef === `Practitioner/${providerId}`).map((i) => i.appointment);
    const myBlocks = blocked.filter((s: Slot) => s.schedule.reference === `Schedule/${provider?.schedule.id}`);
    return busyIntervals(mine, myBlocks, appointment?.id);
  }, [date, providerId, medplum]);

  const freeStarts = useMemo(
    () => (day.data ? availableStarts(date, minutes, day.data, { hours: settings.data?.hours, closures }) : []),
    [day.data, date, minutes, settings.data, closures]
  );
  const open = hoursFor(date, settings.data?.hours, closures);
  const allStarts = useMemo(() => {
    if (!open) return [];
    const out: string[] = [];
    for (let t = Date.parse(open.start); t + minutes * 60000 <= Date.parse(open.end); t += 15 * 60000) out.push(new Date(t).toISOString());
    return out;
  }, [open?.start, open?.end, minutes]);

  const startIso = time ? zonedTime(date, Number(time.slice(0, 2)), Number(time.slice(3, 5)), PRACTICE_TIME_ZONE).toISOString() : undefined;
  const endIso = startIso ? new Date(Date.parse(startIso) + minutes * 60000).toISOString() : undefined;
  const conflict = startIso && endIso && day.data?.find((b) => overlaps({ start: startIso, end: endIso }, b));
  const licence = provider ? checkLicensure(provider.practitioner, state ?? undefined, date) : undefined;
  const patientZone = state ? US_STATE_TIME_ZONES[state] : undefined;
  const repeats = isNew && startIso ? repeatStarts(startIso, repeat, repeatCount) : [];

  const coverage = useLoader(
    () => (patient ? medplum.searchOne('Coverage', { beneficiary: `Patient/${patient.id}`, status: 'active' }).catch(() => undefined) : Promise.resolve(undefined)),
    [patient?.id]
  );

  // Visit type sets the default duration and modality.
  const chooseVisitType = (code: string | null): void => {
    if (!code) return;
    setVisitCode(code);
    const vt = findVisitType(code);
    if (vt) {
      setMinutes(vt.minutes);
      setModality(vt.modality);
    }
  };

  const timeOptions = (overbook ? allStarts : freeStarts).map((iso) => {
    const { hhmm } = practiceParts(iso);
    return { value: hhmm, label: formatTime(iso) };
  });
  if (time && !timeOptions.some((o) => o.value === time) && startIso) {
    timeOptions.unshift({ value: time, label: `${formatTime(startIso)} (current)` });
  }

  const canSave = !!patient && !!provider && !!startIso && !!state && licence?.ok && (!conflict || (overbook && overbookReason.trim().length >= 5));

  const build = (start: string): Appointment => {
    const vt = findVisitType(visitCode);
    const managed: string[] = [EXT.modality, EXT.patientLocationState, EXT.telehealthUrl, EXT.overbookReason];
    const extension = (appointment?.extension ?? []).filter((e) => !managed.includes(e.url));
    extension.push({ url: EXT.modality, valueCode: modality }, { url: EXT.patientLocationState, valueCode: state as string });
    if (link.trim()) extension.push({ url: EXT.telehealthUrl, valueUrl: link.trim() });
    if (overbook && overbookReason.trim()) extension.push({ url: EXT.overbookReason, valueString: overbookReason.trim() });
    return {
      ...appointment,
      resourceType: 'Appointment',
      status: appointment?.status ?? 'booked',
      start,
      end: new Date(Date.parse(start) + minutes * 60000).toISOString(),
      minutesDuration: minutes,
      appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: visitCode, display: vt?.label }], text: vt?.label },
      comment: comment.trim() || undefined,
      created: appointment?.created ?? new Date().toISOString(),
      extension,
      participant: [
        { actor: createReference(patient as Patient), status: 'accepted' },
        { actor: createReference(provider?.practitioner as never), status: 'accepted' },
      ],
    };
  };

  const save = async (): Promise<void> => {
    if (!canSave || !startIso) return;
    setSaving(true);
    setError(undefined);
    try {
      if (isNew) {
        const entries: BundleEntry[] = repeats.map((s) => ({ resource: build(s), request: { method: 'POST', url: 'Appointment' } }));
        // All-or-nothing: if one repeat collides, none are booked.
        const result = await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries } satisfies Bundle);
        const created = (result.entry ?? []).map((e) => e.resource as Appointment).filter(Boolean);
        setSaved(created.length ? created : repeats.map((s) => build(s)));
      } else {
        const updated = await medplum.updateResource(build(startIso));
        notifications.show({ color: 'brand', message: 'Appointment updated. Every change is kept in its history.' });
        setSaved([updated]);
      }
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return <Confirmation appointments={saved} patient={patient} link={link} isNew={isNew} onClose={onClose} />;
  }

  return (
    <Tabs defaultValue="details" variant="outline" keepMounted={false}>
      {!isNew && (
        <Tabs.List mb="md">
          <Tabs.Tab value="details">Details</Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconHistory size={14} />}>
            History
          </Tabs.Tab>
        </Tabs.List>
      )}
      <Tabs.Panel value="details">
        <Stack gap="md">
          {appointment && <StatusBar appointment={appointment} patient={patient} onChanged={onSaved} />}
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Not saved">
              {error}
            </Alert>
          )}
          {!editable && (
            <Alert color="gray" variant="light">
              This visit is {STATUS_DISPLAY[appointment.status].label.toLowerCase()}, so its time and details are locked. Its history is kept.
            </Alert>
          )}

          <PatientPicker patient={patient} disabled={!isNew} onChange={(p) => { setPatient(p); setState(patientState(p) ?? null); }} />
          {patient && (
            <Group gap="xs">
              <Anchor component={Link} to={`/patients/${patient.id}`} size="xs">
                Open chart
              </Anchor>
              <Text size="xs" c="dimmed">
                ·{' '}
                {coverage.data?.payor?.[0]?.display ??
                  (isSelfPay(patient) ? `Self-pay · estimate $${findVisitType(visitCode)?.selfPay ?? '—'}` : 'No insurance on file')}
                {coverage.data && <EligibilityNote coverage={coverage.data} />}
              </Text>
            </Group>
          )}

          <SimpleGrid cols={2}>
            <Select label="Visit type" data={VISIT_TYPES.map((v) => ({ value: v.code, label: `${v.label} · ${v.minutes} min` }))} value={visitCode} onChange={chooseVisitType} disabled={!editable} allowDeselect={false} />
            <Select
              label="Provider"
              data={providers.map((p) => ({ value: p.practitioner.id as string, label: [p.practitioner.name?.[0]?.given?.[0], p.practitioner.name?.[0]?.family].join(' ') }))}
              value={providerId}
              onChange={(v) => v && setProviderId(v)}
              disabled={!editable || providers.length < 2}
              allowDeselect={false}
            />
            <TextInput label="Date" type="date" value={date} onChange={(e) => { setDate(e.currentTarget.value); setTime(null); }} disabled={!editable} />
            <Select
              label="Time"
              placeholder={day.loading ? 'Checking availability…' : !open ? 'Closed this day' : timeOptions.length ? 'Choose a time' : 'No free times'}
              data={timeOptions}
              value={time}
              onChange={setTime}
              disabled={!editable || !open}
              searchable
              maxDropdownHeight={260}
              nothingFoundMessage="No free times"
            />
            <NumberInput label="Length (minutes)" value={minutes} onChange={(v) => setMinutes(Number(v) || 15)} step={15} min={15} max={120} disabled={!editable} />
            <div>
              <Text size="sm" fw={500} mb={4}>
                Modality
              </Text>
              <SegmentedControl
                fullWidth
                value={modality}
                onChange={(v) => setModality(v as Modality)}
                disabled={!editable}
                data={[
                  { value: 'video', label: 'Video' },
                  { value: 'phone', label: 'Phone' },
                  { value: 'office', label: 'Office' },
                ]}
              />
            </div>
          </SimpleGrid>

          {!open && (
            <Text size="xs" c="orange.7">
              The practice is closed on {formatDate(date)}. Choose another day.
            </Text>
          )}
          {editable && (
            <Checkbox
              label="Show all times (overbook or book over blocked time)"
              checked={overbook}
              onChange={(e) => setOverbook(e.currentTarget.checked)}
              description={overbook ? 'Requires a reason; recorded on the appointment.' : undefined}
            />
          )}
          {conflict && (
            <Alert color={overbook ? 'orange' : 'red'} variant="light" icon={<IconAlertTriangle size={16} />}>
              {conflict.kind === 'blocked' ? 'This time is blocked.' : 'This time overlaps another appointment.'} {overbook ? 'Give a reason to overbook.' : 'Choose a free time, or tick “Show all times” to overbook.'}
            </Alert>
          )}
          {overbook && <TextInput label="Overbooking reason" required value={overbookReason} onChange={(e) => setOverbookReason(e.currentTarget.value)} placeholder="e.g. urgent same-day visit approved by the provider" />}

          <Divider label="Where the patient will be" labelPosition="left" />
          <SimpleGrid cols={2}>
            <Select
              label="Patient located in"
              description="Licensure follows the patient's physical location"
              leftSection={<IconMapPin size={16} />}
              data={US_STATES.map((s) => ({ value: s.code, label: s.name }))}
              value={state}
              onChange={setState}
              searchable
              disabled={!editable}
            />
            <div>
              {startIso && patientZone && timeZoneAbbrev(startIso, patientZone) !== timeZoneAbbrev(startIso, PRACTICE_TIME_ZONE) && (
                <>
                  <Text size="sm" fw={500} mt={4}>
                    Patient's local time
                  </Text>
                  <Text size="lg" fw={650} className="tm-num">
                    {formatTime(startIso, patientZone)} {timeZoneAbbrev(startIso, patientZone)}
                  </Text>
                </>
              )}
            </div>
          </SimpleGrid>
          {licence && state && (
            <Alert color={licence.ok ? 'green' : 'red'} variant="light" icon={licence.ok ? <IconCircleCheck size={16} /> : <IconAlertTriangle size={16} />}>
              {licence.ok ? `Licensed in ${state}${licence.credential?.end ? ` until ${formatDate(licence.credential.end.slice(0, 10))}` : ''}.` : licence.reason}
            </Alert>
          )}

          {modality !== 'office' && <TextInput label="Telehealth link" placeholder="https://… (from the telehealth platform)" value={link} onChange={(e) => setLink(e.currentTarget.value)} disabled={!editable} />}
          <Textarea label="Note for staff" autosize minRows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} disabled={!editable} />

          {isNew && (
            <SimpleGrid cols={2}>
              <Select
                label="Repeat"
                data={[
                  { value: 'none', label: 'Does not repeat' },
                  { value: 'weekly', label: 'Every week' },
                  { value: 'every-2-weeks', label: 'Every 2 weeks' },
                  { value: 'every-4-weeks', label: 'Every 4 weeks' },
                ]}
                value={repeat}
                onChange={(v) => setRepeat((v as Repeat) ?? 'none')}
                allowDeselect={false}
              />
              {repeat !== 'none' && <NumberInput label="Number of visits" value={repeatCount} onChange={(v) => setRepeatCount(Math.min(12, Math.max(2, Number(v) || 2)))} min={2} max={12} />}
            </SimpleGrid>
          )}
          {repeats.length > 1 && (
            <Text size="xs" c="dimmed">
              {repeats.map((r) => formatDate(practiceParts(r).ymd).slice(0, 5)).join(' · ')} at {startIso && formatTime(startIso)}. If any of these clashes, none are booked.
            </Text>
          )}

          {editable && (
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={save} loading={saving} disabled={!canSave} leftSection={<IconCalendarCheck size={16} />}>
                {isNew ? (repeats.length > 1 ? `Book ${repeats.length} visits` : 'Book appointment') : 'Save changes'}
              </Button>
            </Group>
          )}
        </Stack>
      </Tabs.Panel>
      {appointment && (
        <Tabs.Panel value="history">
          <History appointmentId={appointment.id as string} />
        </Tabs.Panel>
      )}
    </Tabs>
  );
}

function PatientPicker({ patient, disabled, onChange }: { readonly patient?: Patient; readonly disabled?: boolean; readonly onChange: (p: Patient) => void }): JSX.Element {
  const medplum = useMedplum();
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 250);
  const [results, setResults] = useState<Patient[]>([]);
  useEffect(() => {
    if (disabled || debounced.trim().length < 2) return;
    let cancelled = false;
    searchPatients(medplum, debounced, 10)
      .then((r) => !cancelled && setResults(r))
      .catch(() => !cancelled && setResults([]));
    return () => {
      cancelled = true;
    };
  }, [debounced, medplum, disabled]);
  const options = [...(patient ? [patient] : []), ...results.filter((r) => r.id !== patient?.id)].map((p) => ({
    value: p.id as string,
    label: `${patientName(p)} · DOB ${formatDate(p.birthDate)}`,
  }));
  return (
    <Select
      label="Patient"
      required
      placeholder="Search by name, DOB, phone or chart number"
      searchable
      data={options}
      value={patient?.id ?? null}
      searchValue={patient && !query ? undefined : query}
      onSearchChange={setQuery}
      onChange={(id) => {
        const p = [...results, ...(patient ? [patient] : [])].find((x) => x.id === id);
        if (p) {
          onChange(p);
          setQuery('');
        }
      }}
      disabled={disabled}
      filter={({ options: o }) => o}
      nothingFoundMessage={debounced.length >= 2 ? 'No match. Register the patient first (Patients → New patient).' : 'Type at least 2 characters'}
    />
  );
}

function StatusBar({ appointment, patient, onChanged }: { readonly appointment: Appointment; readonly patient?: Patient; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [action, setAction] = useState<'checkin' | 'cancel'>();
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();
  // The visit is completed by signing its note (P21/P23), so there is no "Complete" shortcut here.
  const beginVisit = async (): Promise<void> => {
    setStarting(true);
    try {
      const encounter = await startVisit(medplum, appointment);
      navigate(`/encounters/${encounter.id}`);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Visit not started', message: normalizeErrorString(err), autoClose: 10000 });
    } finally {
      setStarting(false);
    }
  };
  const status = STATUS_DISPLAY[appointment.status];
  const confirmed = getExtensionValue(appointment, EXT.confirmedAt) as string | undefined;
  const apptModality = getExtensionValue(appointment, EXT.modality) as Modality | undefined;

  const setStatus = async (next: Appointment['status'], extra: Partial<Appointment> = {}, message?: string): Promise<void> => {
    try {
      await medplum.updateResource<Appointment>({ ...appointment, status: next, ...extra });
      notifications.show({ color: 'brand', message: message ?? `Marked ${STATUS_DISPLAY[next].label.toLowerCase()}.` });
      setAction(undefined);
      onChanged();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not changed', message: normalizeErrorString(err) });
    }
  };

  return (
    <>
      <Group justify="space-between" p="sm" style={{ border: '1px solid var(--tm-border)', borderRadius: 'var(--mantine-radius-md)' }}>
        <Group gap={8}>
          <Badge color={status.color} variant="light" size="lg">
            {status.label}
          </Badge>
          {confirmed && (
            <Badge color="brand" variant="outline" leftSection={<IconCircleCheck size={11} />}>
              Confirmed by patient
            </Badge>
          )}
        </Group>
        <Group gap={6}>
          {BOOKING.includes(appointment.status) &&
            (apptModality === 'video' ? (
              <Button size="xs" variant="default" onClick={() => setAction('checkin')}>
                Check in on their behalf
              </Button>
            ) : (
              <Button size="xs" onClick={() => setAction('checkin')}>
                Check in
              </Button>
            ))}
          {['arrived', 'checked-in'].includes(appointment.status) && (
            <Button size="xs" color="brand" leftSection={<IconPlayerPlay size={13} />} loading={starting} onClick={beginVisit}>
              Start visit
            </Button>
          )}
          {[...BOOKING, 'arrived', 'checked-in'].includes(appointment.status) && (
            <>
              <Button size="xs" variant="default" onClick={() => setStatus('noshow', {}, 'Marked no-show.')}>
                No-show
              </Button>
              <Button size="xs" variant="subtle" color="red" onClick={() => setAction('cancel')}>
                Cancel visit
              </Button>
            </>
          )}
        </Group>
      </Group>
      {patient && isSelfPay(patient) && (appointment.status === 'noshow' || (appointment.status === 'cancelled' && appointment.cancelationReason?.coding?.some((c) => c.code === 'late-cancel'))) && (
        <VisitFeeAction appointment={appointment} />
      )}
      {action === 'checkin' && <CheckInModal appointment={appointment} onClose={() => setAction(undefined)} onConfirm={async (state) => {
        const providerRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor as Reference<Practitioner> | undefined;
        if (!providerRef || !appointment.start) {
          notifications.show({ color: 'red', title: 'Cannot check in', message: 'This visit is missing its provider or scheduled date.' });
          return;
        }
        try {
          const provider = await medplum.readReference(providerRef);
          const licensed = checkLicensure(provider, state, zonedDate(new Date(), PRACTICE_TIME_ZONE));
          if (!licensed.ok) {
            notifications.show({ color: 'red', title: 'Check-in blocked', message: licensed.reason ?? `The provider is not licensed in ${state}.` });
            return;
          }
          const profile = medplum.getProfile();
          const actorRef = profile ? createReference(profile).reference : appointment.meta?.author?.reference;
          if (!actorRef) {
            notifications.show({ color: 'red', title: 'Cannot record check-in', message: 'Your staff identity is unavailable. Refresh and try again.' });
            return;
          }
          const confirmedAt = new Date();
          await setStatus('arrived', { extension: [
            ...(appointment.extension ?? []).filter((e) => e.url !== EXT.patientLocationState && e.url !== EXT.locationConfirmed),
            { url: EXT.patientLocationState, valueCode: state },
            locationConfirmedExtension(actorRef, state, confirmedAt),
          ] }, 'Checked in. Current location and staff confirmation recorded.');
        } catch (err) {
          notifications.show({ color: 'red', title: 'Check-in blocked', message: normalizeErrorString(err) });
        }
      }} />}
      {action === 'cancel' && <CancelModal onClose={() => setAction(undefined)} onConfirm={(code, note) => setStatus('cancelled', { cancelationReason: { coding: [{ system: CODE_SYSTEMS.cancellationReason, code, display: CANCELLATION_REASONS.find((r) => r.code === code)?.label }], text: note || undefined } }, 'Visit cancelled. The time is free again.')} />}
    </>
  );
}

function CheckInModal({ appointment, onClose, onConfirm }: { readonly appointment: Appointment; readonly onClose: () => void; readonly onConfirm: (state: string) => void | Promise<void> }): JSX.Element {
  const item = toItem(appointment, new Map());
  const modality = item.modality ?? 'video';
  const office = modality === 'office';
  const video = modality === 'video';
  const bookedState = item.locationState;
  // A telehealth patient may have moved, so always ask. An in-person patient is at the office, so its
  // booked location is confirmed as-is unless none was recorded.
  const askState = !office || !bookedState;
  const [state, setState] = useState<string | null>(bookedState ?? null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const portalUrl = ((import.meta.env.VITE_PORTAL_URL as string | undefined) ?? 'http://localhost:3200').replace(/\/$/, '');
  const checkInUrl = `${portalUrl}/visit/${appointment.id}`;
  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(checkInUrl);
      notifications.show({ color: 'brand', message: 'Patient check-in link copied.' });
    } catch {
      notifications.show({ color: 'red', title: 'Copy failed', message: checkInUrl, autoClose: 8000 });
    }
  };
  const confirmedState = askState ? state : bookedState ?? null;
  return (
    <Modal opened onClose={onClose} title={office ? 'Check in the patient' : 'Check in for the patient'} centered>
      <Stack>
        {video && (
          <Alert color="blue" icon={<IconMapPin size={18} />} title="The patient normally checks in themselves">
            <Text size="sm">
              For a video visit the patient checks in from the patient portal and confirms the state they are physically in. Use this screen only to check them in on their behalf.
            </Text>
            <Button mt="xs" variant="light" size="xs" leftSection={<IconCopy size={13} />} onClick={() => void copyLink()}>
              Copy the patient's check-in link
            </Button>
          </Alert>
        )}
        <Text size="sm">
          {office
            ? 'Confirm the patient has arrived at the office. The provider must be licensed here to give care in person.'
            : 'Ask the patient where they are right now and record it below. The provider must be licensed in that state for the visit to go ahead.'}
        </Text>
        {askState ? (
          <Select label="Patient's current location" data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} value={state} onChange={setState} searchable required leftSection={<IconMapPin size={16} />} />
        ) : (
          <Text size="xs" c="dimmed">
            Location on the booking: {bookedState}. It is recorded as confirmed for this visit.
          </Text>
        )}
        <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} label={office ? 'The patient has arrived for their in-person visit.' : 'I asked the patient; this is where they are physically located right now.'} />
        {askState && state && bookedState && state !== bookedState && (
          <Text size="xs" c="orange.7">
            Different from the booked location ({bookedState}). The new location is recorded on the visit.
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Back
          </Button>
          <Button disabled={!confirmedState || !confirmed || saving} loading={saving} onClick={() => {
            if (!confirmedState) return;
            setSaving(true);
            Promise.resolve(onConfirm(confirmedState)).finally(() => setSaving(false));
          }}>
            Confirm check-in
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CancelModal({ onClose, onConfirm }: { readonly onClose: () => void; readonly onConfirm: (code: string, note: string) => void }): JSX.Element {
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <Modal opened onClose={onClose} title="Cancel visit" centered>
      <Stack>
        <Select label="Reason" required data={CANCELLATION_REASONS.map((r) => ({ value: r.code, label: r.label }))} value={code} onChange={setCode} />
        {code === 'late-cancel' && (
          <Text size="xs" c="dimmed">
            For a self-pay patient, a late-cancellation fee can be posted from the visit afterwards, if the practice charges one. It is never billed to insurance.
          </Text>
        )}
        <Textarea label="Note" value={note} onChange={(e) => setNote(e.currentTarget.value)} autosize />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Keep visit
          </Button>
          <Button color="red" disabled={!code} onClick={() => code && onConfirm(code, note.trim())}>
            Cancel visit
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function Confirmation({ appointments, patient, link, isNew, onClose }: { readonly appointments: Appointment[]; readonly patient?: Patient; readonly link: string; readonly isNew: boolean; readonly onClose: () => void }): JSX.Element {
  return (
    <Stack align="center" ta="center" py="lg" gap="sm">
      <ThemeIcon size={52} radius="xl" color="brand" variant="light">
        <IconCalendarCheck size={28} />
      </ThemeIcon>
      <Text fw={700} fz="lg">
        {isNew ? (appointments.length > 1 ? `${appointments.length} visits booked` : 'Appointment booked') : 'Appointment updated'}
      </Text>
      <Text size="sm" c="dimmed">
        {patientName(patient)} · {appointments.map((a) => `${formatDate(practiceParts(a.start as string).ymd)} ${formatTime(a.start)}`).join(', ')}
      </Text>
      <Text size="xs" c="dimmed" maw={360}>
        Reminders go out automatically 72, 24 and 2 hours before (Settings → Messaging & reminders). Reminders never contain clinical details.
      </Text>
      <Group mt="sm">
        {appointments[0]?.id && (
          <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => downloadIcs(appointments[0], link || undefined)}>
            Calendar invite (.ics)
          </Button>
        )}
        <Button onClick={onClose}>Done</Button>
      </Group>
    </Stack>
  );
}

function History({ appointmentId }: { readonly appointmentId: string }): JSX.Element {
  const medplum = useMedplum();
  const history = useLoader(async () => {
    const bundle = await medplum.get<Bundle<Appointment>>(medplum.fhirUrl('Appointment', appointmentId, '_history'), { cache: 'no-cache' });
    const versions = (bundle.entry ?? []).map((e) => e.resource as Appointment).filter(Boolean);
    return versions.map((v, i) => {
      const prev = versions[i + 1];
      const changes: string[] = [];
      if (!prev) changes.push('Booked');
      else {
        if (prev.status !== v.status) changes.push(`Status: ${STATUS_DISPLAY[prev.status].label} → ${STATUS_DISPLAY[v.status].label}`);
        if (prev.start !== v.start) changes.push(`Moved: ${formatDate(practiceParts(prev.start as string).ymd)} ${formatTime(prev.start)} → ${formatDate(practiceParts(v.start as string).ymd)} ${formatTime(v.start)}`);
        const loc = (a: Appointment): string | undefined => getExtensionValue(a, EXT.patientLocationState) as string | undefined;
        if (loc(prev) !== loc(v)) changes.push(`Location: ${loc(prev) ?? '—'} → ${loc(v) ?? '—'}`);
        if (getExtensionValue(v, EXT.confirmedAt) && !getExtensionValue(prev, EXT.confirmedAt)) changes.push('Confirmed by patient reply');
        if (v.cancelationReason && !prev.cancelationReason) changes.push(`Reason: ${v.cancelationReason.coding?.[0]?.display ?? v.cancelationReason.text}`);
        if (changes.length === 0) changes.push('Details edited');
      }
      return { v, changes };
    });
  }, [appointmentId]);
  if (!history.data) return <Loader size="sm" />;
  return (
    <Stack gap="sm">
      {history.data.map(({ v, changes }) => (
        <div key={v.meta?.versionId}>
          <Text size="xs" c="dimmed" className="tm-num">
            {formatDate(v.meta?.lastUpdated?.slice(0, 10))} {formatTime(v.meta?.lastUpdated)} · {v.meta?.author?.display ?? v.meta?.author?.reference ?? 'system'}
          </Text>
          {changes.map((c) => (
            <Text key={c} size="sm">
              {c}
            </Text>
          ))}
        </div>
      ))}
    </Stack>
  );
}


/** The visit plan's latest eligibility result, shown beside the payer. */
function EligibilityNote({ coverage }: { readonly coverage: Coverage }): JSX.Element {
  const medplum = useMedplum();
  const latest = useLoader(() => latestEligibility(medplum, coverage), [coverage.id]);
  const label = latest.data ? { active: 'eligibility active', inactive: 'eligibility inactive', check: 'eligibility needs a look', pending: 'eligibility check pending' }[latest.data.status] : 'eligibility not checked yet';
  return <> · {label}</>;
}

/** Posts the practice's self-pay missed-visit fee. The ledger re-checks the visit and sets the amount. */
function VisitFeeAction({ appointment }: { readonly appointment: Appointment }): JSX.Element | null {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const policy = useLoader(() => readSettings(medplum, 'billing').then((b) => b.policy), []);
  const [busy, setBusy] = useState(false);
  const kind = appointment.status === 'noshow' ? 'no-show' : 'late-cancel';
  const cents = policy.data ? visitFeeCents(policy.data, kind) : 0;
  if (!roles.some((r) => ['admin', 'biller', 'provider', 'frontdesk'].includes(r)) || cents <= 0) return null;
  const post = async (): Promise<void> => {
    setBusy(true);
    try {
      const results = await ledgerApi.visitFee(medplum, appointment.id as string);
      notifications.show({ color: 'brand', message: results.some((r) => r.created) ? `${kind === 'no-show' ? 'No-show' : 'Late-cancellation'} fee of ${formatCents(cents)} posted to the patient account.` : 'This fee was already posted.' });
    } catch (err) {
      notifications.show({ color: 'red', message: normalizeErrorString(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group mt="sm">
      <Button size="xs" variant="light" loading={busy} onClick={() => void post()}>
        Post {kind === 'no-show' ? 'no-show' : 'late-cancellation'} fee ({formatCents(cents)})
      </Button>
      <Text size="xs" c="dimmed">Self-pay only. Never billed to insurance.</Text>
    </Group>
  );
}
