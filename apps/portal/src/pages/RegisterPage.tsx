import { Alert, Anchor, Button, Card, Checkbox, Group, List, Select, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconMailCheck } from '@tabler/icons-react';
import { US_STATES, ageInYears, normalizePhone } from '@teleemon/core';
import type { ChangeEvent, FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorText, publicApi } from '../api';
import { Show, useLoader } from '../components/states';
import type { Challenge } from '../pow';
import { solveChallenge } from '../pow';

export function RegisterPage(): JSX.Element {
  const options = useLoader(() => publicApi.get<{ states: string[]; phone: string }>('options'), []);
  return (
    <div className="tm-page" style={{ maxWidth: 640 }}>
      <Stack gap="lg">
        <div><Title order={1}>Create your account</Title><Text c="dimmed" mt={6}>Three steps: your details, verify your email, then your forms. Book a visit whenever you are ready.</Text></div>
        <Show loaded={options}>{(value) => <RegistrationForm options={value} />}</Show>
        <Text size="sm">Have an account? <Anchor component={Link} to="/signin">Sign in</Anchor> · Want to pick a time first? <Anchor component={Link} to="/book">Book a first visit</Anchor></Text>
      </Stack>
    </div>
  );
}

function RegistrationForm({ options }: { readonly options: { states: string[]; phone: string } }): JSX.Element {
  const [form, setForm] = useState({ given: '', family: '', birthDate: '', email: '', phone: '', state: '', smsConsent: false, website: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const age = form.birthDate ? ageInYears(form.birthDate) : undefined;
  const adult = age !== undefined && age >= 18;
  const valid = !!form.given.trim() && !!form.family.trim() && adult && !!normalizePhone(form.phone) && /^\S+@\S+\.\S+$/.test(form.email.trim()) && options.states.includes(form.state);
  const set = (key: 'given' | 'family' | 'birthDate' | 'email' | 'phone') => (event: ChangeEvent<HTMLInputElement>): void => setForm({ ...form, [key]: event.currentTarget.value });
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError(undefined);
    try {
      const proof = await solveChallenge(await publicApi.get<Challenge>('challenge'));
      await publicApi.post('register', { ...form, proof });
      setDone(true);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  if (done) return (
    <Card><Stack gap="md">
      <IconMailCheck size={32} color="var(--mantine-color-brand-7)" />
      <Title order={2}>Check your email</Title>
      <Text>We sent a link to <b>{form.email}</b>. Open it to choose your password.</Text>
      <List size="sm" spacing="xs"><List.Item>Then sign in and fill in your forms.</List.Item><List.Item>Book your first visit when you are ready. Nothing is booked yet.</List.Item></List>
      <Text size="sm" c="dimmed">No email? Check your spam folder, or call <Anchor href={`tel:${options.phone}`}>{options.phone}</Anchor>. If you have been our patient before, we may call you within one business day to link your record.</Text>
      <Button component={Link} to="/signin">Go to sign in</Button>
    </Stack></Card>
  );
  return (
    <Card><form onSubmit={(event) => void submit(event)}><Stack gap="md">
      <Title order={2}>Your details</Title>
      <Text size="sm" c="dimmed">Use the patient’s legal name. For patients under 18, a parent or guardian should call {options.phone} so we can arrange the appropriate access.</Text>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        <TextInput label="Legal first name" required autoComplete="given-name" maxLength={60} value={form.given} onChange={set('given')} />
        <TextInput label="Legal last name" required autoComplete="family-name" maxLength={60} value={form.family} onChange={set('family')} />
      </SimpleGrid>
      <TextInput label="Date of birth" type="date" required autoComplete="bday" max={new Date().toISOString().slice(0, 10)} value={form.birthDate} onChange={set('birthDate')} />
      {age !== undefined && !adult && <Alert color="orange">Please call the practice to arrange guardian access for a patient under 18.</Alert>}
      <TextInput label="Email" type="email" required autoComplete="email" description="We will send your account verification link here." value={form.email} onChange={set('email')} />
      <TextInput label="Mobile phone" type="tel" required autoComplete="tel-national" value={form.phone} onChange={set('phone')} />
      <Select label="Home state" required searchable placeholder="Choose a state" data={options.states.map((code) => ({ value: code, label: US_STATES.find((state) => state.code === code)?.name ?? code }))} value={form.state || null} onChange={(state) => setForm({ ...form, state: state ?? '' })} description="Currently accepting patients in these states. We confirm your physical location again for each visit." />
      <Checkbox label="Text me appointment reminders. Optional; reply STOP at any time." checked={form.smsConsent} onChange={(event) => setForm({ ...form, smsConsent: event.currentTarget.checked })} />
      <input name="website" aria-hidden="true" tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => setForm({ ...form, website: event.currentTarget.value })} style={{ position: 'absolute', left: -10000, opacity: 0 }} />
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group justify="flex-end"><Button type="submit" loading={busy} disabled={!valid}>Send verification email</Button></Group>
      <Text size="xs" c="dimmed">Your information is used to set up your care. We will ask you to review and sign care consents after sign-in.</Text>
    </Stack></form></Card>
  );
}
