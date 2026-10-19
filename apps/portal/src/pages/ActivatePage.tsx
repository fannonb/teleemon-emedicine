import { Alert, Anchor, Button, Card, List, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { PORTAL_RULES } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { errorText, publicApi } from '../api';
import { formatWhen } from '../components/SlotPicker';
import { Show, useLoader } from '../components/states';

interface Invitation {
  readonly state: 'valid' | 'expired' | 'used';
  readonly kind?: 'patient' | 'proxy';
  readonly firstName?: string;
  readonly email?: string;
  readonly appointment?: { start?: string; status?: string; visit?: string };
}

interface Activation {
  readonly email: string;
  readonly existingLogin: boolean;
  readonly appointment?: 'confirmed' | 'expired';
}

// Invitation link: confirms a held online booking and sets the portal password (single use, 72 hours).
export function ActivatePage(): JSX.Element {
  const [saved] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  // Remove the token from the address bar and browser history straight away.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', '/activate');
  }, []);
  const invitation = useLoader(() => publicApi.get<Invitation>(`invitation?token=${encodeURIComponent(saved)}`), [saved]);
  return (
    <div className="tm-page" style={{ maxWidth: 520 }}>
      <Title order={1} mb="lg">Set up your portal</Title>
      <Show loaded={invitation}>{(inv) => <Activate token={saved} invitation={inv} />}</Show>
    </div>
  );
}

function Activate({ token, invitation }: { readonly token: string; readonly invitation: Invitation }): JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Activation>();

  if (invitation.state !== 'valid') {
    return (
      <Alert color="orange" icon={<IconAlertTriangle size={18} />} title={invitation.state === 'used' ? 'This link was already used' : 'This link has expired'}>
        {invitation.state === 'used' ? <>Your sign-in is set up. <Anchor component={Link} to="/signin">Sign in</Anchor>.</> : 'Call us and we will send a new link.'}
      </Alert>
    );
  }
  if (result) {
    return (
      <Card>
        <Stack align="flex-start">
          <IconCircleCheck size={36} color="var(--mantine-color-green-7)" />
          <Title order={2}>Your account is ready</Title>
          {result.appointment === 'confirmed' && <Text>Your visit is confirmed. We will remind you before it.</Text>}
          {result.appointment === 'expired' && <Alert color="orange">The time we held for you has passed. Sign in to choose a new time.</Alert>}
          <Text>{result.existingLogin ? 'You already have an account with this email. Sign in with your usual password.' : 'Sign in with your email and new password.'}</Text>
          <Text size="sm">Next, fill in your forms. They save as you go.</Text>
          {!result.appointment && <Text size="sm">No visit is booked yet. You can book one from your home page.</Text>}
          <Button component={Link} to={`/signin?next=/intake&email=${encodeURIComponent(result.email)}`}>Sign in and continue</Button>
        </Stack>
      </Card>
    );
  }
  const strongEnough = password.length >= PORTAL_RULES.minPasswordLength;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await publicApi.post<Activation>('activate', { token, password }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Stack>
        <Text>Hello {invitation.firstName}. {invitation.kind === 'proxy' ? 'This sets up your parent or guardian sign-in.' : 'Choose a password for your patient portal.'}</Text>
        {invitation.appointment?.start && (
          <Alert color="blue">Submitting this form confirms the held visit on <b>{formatWhen(invitation.appointment.start)}</b>, if the hold has not expired.</Alert>
        )}
        {invitation.email && <Text size="sm" c="dimmed">Your sign-in email: {invitation.email}</Text>}
        <PasswordInput label="New password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
        <List size="sm" c={strongEnough ? 'green' : 'dimmed'}><List.Item>At least {PORTAL_RULES.minPasswordLength} characters. A short sentence works well.</List.Item></List>
        <PasswordInput label="Confirm password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} error={confirm && confirm !== password ? 'The passwords do not match' : undefined} />
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Button loading={busy} disabled={!strongEnough || password !== confirm} onClick={() => void submit()}>{invitation.appointment ? 'Confirm visit and set password' : 'Set password'}</Button>
      </Stack>
    </Card>
  );
}
