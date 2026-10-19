import { Alert, Anchor, Badge, Button, Card, Checkbox, Group, Loader, Select, SimpleGrid, Stack, Stepper, Text, TextInput, Title } from '@mantine/core';
import { IconAlertTriangle, IconMailCheck, IconMapPin, IconVideo } from '@tabler/icons-react';
import { US_STATES } from '@teleemon/core';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { PortalError, errorText, publicApi } from '../api';
import type { FreeDay, FreeTime } from '../components/SlotPicker';
import { SlotPicker, formatWhen } from '../components/SlotPicker';
import { Show, useLoader } from '../components/states';
import type { Challenge } from '../pow';
import { solveChallenge } from '../pow';

interface Options {
  readonly states: string[];
  readonly visitTypes: { code: string; label: string; minutes: number }[];
  readonly phone: string;
  readonly holdMinutes: number;
}

const stateName = (code: string): string => US_STATES.find((s) => s.code === code)?.name ?? code;

// X01 Public booking: state first, live times, no account needed, no trackers. The server checks
// licensure, conflicts and the booking window again, and holds the time until the email link is opened.
export function BookPage(): JSX.Element {
  const options = useLoader(() => publicApi.get<Options>('options'), []);
  return (
    <div className="tm-page">
      <Title order={1}>Book a first visit</Title>
      <Text c="dimmed" mt={4} mb="lg">Already a patient? <Anchor component={Link} to="/signin">Sign in</Anchor> to book a follow-up.</Text>
      <Show loaded={options}>{(o) => <BookFlow options={o} />}</Show>
    </div>
  );
}

function BookFlow({ options }: { readonly options: Options }): JSX.Element {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<string | null>(null);
  const [time, setTime] = useState<FreeTime>();
  const [form, setForm] = useState({ given: '', family: '', birthDate: '', email: '', phone: '', smsConsent: false, website: '' });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const visitType = options.visitTypes[0];
  const licensed = !!state && options.states.includes(state);

  const load = useCallback(async (from: string): Promise<FreeDay[]> => (await publicApi.get<{ days: FreeDay[] }>(`slots?state=${state}&visitType=${visitType.code}&from=${from}`)).days, [state, visitType.code]);

  const submit = async (): Promise<void> => {
    if (!time || !state) return;
    setError(undefined);
    try {
      setBusy('Checking this is a person, not a bot…');
      const proof = await solveChallenge(await publicApi.get<Challenge>('challenge'));
      setBusy('Booking…');
      await publicApi.post('book', { ...form, state, visitType: visitType.code, start: time.start, practitionerId: time.practitionerId, proof });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof PortalError && err.code === 'taken') { setTime(undefined); setStep(1); }
    } finally {
      setBusy(undefined);
    }
  };

  if (done) {
    return (
      <Card>
        <Stack gap="sm" align="flex-start">
          <IconMailCheck size={36} color="var(--mantine-color-brand-7)" />
          <Title order={2}>Check your email</Title>
          <Text>Look for a message at <b>{form.email}</b> about your request{time ? <> for {formatWhen(time.start, state ?? undefined)}</> : null}. A new-patient confirmation link lets you set up your portal sign-in. If your details need matching to an existing record, our team will contact you within one business day.</Text>
          <Text size="sm" c="dimmed">If a time is held, open its confirmation link within {options.holdMinutes} minutes. Your visit is confirmed only after email confirmation or staff review. If the email does not arrive, check spam or call {options.phone}.</Text>
        </Stack>
      </Card>
    );
  }

  const detailsOk = form.given.trim() && form.family.trim() && form.birthDate && /\S+@\S+\.\S+/.test(form.email) && form.phone.replace(/\D/g, '').length >= 10;
  return (
    <Stepper active={step} onStepClick={(s) => s < step && setStep(s)} size="sm" allowNextStepsSelect={false}>
      <Stepper.Step label="Location">
        <Card mt="md">
          <Stack>
            <Group gap="xs"><IconMapPin size={20} /><Title order={2}>Where will you be during the visit?</Title></Group>
            <Text size="sm" c="dimmed">Your provider must be licensed where you are during the visit, which may differ from where you live.</Text>
            <Select label="State" placeholder="Choose a state" searchable data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} value={state} onChange={(v) => { setState(v); setTime(undefined); }} />
            {state && !licensed && (
              <Alert color="red" icon={<IconAlertTriangle size={18} />} title={`We cannot see patients in ${stateName(state)} yet`}>
                Our providers are licensed in {options.states.map(stateName).join(', ')}. If you will be in one of these states at the time of your visit, choose it above. Otherwise your primary care clinician or insurer can help you find care in {stateName(state)}.
              </Alert>
            )}
            <Group justify="flex-end"><Button disabled={!licensed} onClick={() => setStep(1)}>Continue</Button></Group>
          </Stack>
        </Card>
      </Stepper.Step>
      <Stepper.Step label="Time">
        <Card mt="md">
          <Stack>
            <Group justify="space-between">
              <Title order={2}>{visitType.label}</Title>
              <Badge leftSection={<IconVideo size={14} />}>{visitType.minutes} min · video</Badge>
            </Group>
            {state && <SlotPicker load={load} state={state} value={time} onChange={setTime} />}
            {time && <Text size="sm">Selected: <b>{formatWhen(time.start, state ?? undefined)}</b> with {time.provider}</Text>}
            <Group justify="space-between"><Button variant="default" onClick={() => setStep(0)}>Back</Button><Button disabled={!time} onClick={() => setStep(2)}>Continue</Button></Group>
          </Stack>
        </Card>
      </Stepper.Step>
      <Stepper.Step label="Your details">
        <Card mt="md">
          <Stack>
            <Title order={2}>About you</Title>
            <Text size="sm" c="dimmed">For patients 18 and over. A parent or guardian books for patients under 18 by calling {options.phone}.</Text>
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <TextInput label="First name" autoComplete="given-name" required value={form.given} onChange={(e) => setForm({ ...form, given: e.currentTarget.value })} />
              <TextInput label="Last name" autoComplete="family-name" required value={form.family} onChange={(e) => setForm({ ...form, family: e.currentTarget.value })} />
            </SimpleGrid>
            <TextInput label="Date of birth" type="date" autoComplete="bday" required value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.currentTarget.value })} />
            <TextInput label="Email" type="email" autoComplete="email" required description="We send your confirmation link here." value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
            <TextInput label="Mobile phone" type="tel" autoComplete="tel-national" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.currentTarget.value })} />
            <Checkbox label="Text me appointment reminders (no health details). Reply STOP at any time." checked={form.smsConsent} onChange={(e) => setForm({ ...form, smsConsent: e.currentTarget.checked })} />
            {/* Hidden from people; automated form-fillers complete it and are ignored. */}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => setForm({ ...form, website: e.currentTarget.value })} style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} />
            {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
            <Group justify="space-between">
              <Button variant="default" onClick={() => setStep(1)} disabled={!!busy}>Back</Button>
              <Button onClick={() => void submit()} disabled={!detailsOk || !!busy} leftSection={busy ? <Loader size={16} color="white" /> : undefined}>{busy ?? 'Request this time'}</Button>
            </Group>
            <Text size="xs" c="dimmed">We will contact you only about this booking and your care.</Text>
          </Stack>
        </Card>
      </Stepper.Step>
    </Stepper>
  );
}
