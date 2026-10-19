import { Alert, Anchor, Button, Card, Image, PasswordInput, PinInput, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import type { LoginAuthenticationResponse } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import { IconAlertTriangle, IconChevronRight } from '@tabler/icons-react';
import type { FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useSession } from '../session';

type Stage = { kind: 'password' } | { kind: 'mfa'; login: string } | { kind: 'enroll'; login: string; qr?: string } | { kind: 'profile'; login: string; memberships: NonNullable<LoginAuthenticationResponse['memberships']> };

export function SignInPage(): JSX.Element {
  const { medplum, reload } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const finish = async (res: LoginAuthenticationResponse): Promise<void> => {
    if (res.mfaEnrollRequired) return setStage({ kind: 'enroll', login: res.login, qr: res.enrollQrCode });
    if (res.mfaRequired) return setStage({ kind: 'mfa', login: res.login });
    if (res.memberships && !res.code) return setStage({ kind: 'profile', login: res.login, memberships: res.memberships });
    if (!res.code) throw new Error('Sign-in did not complete. Please try again.');
    const profile = await medplum.processCode(res.code);
    if (profile.resourceType !== 'Patient' && profile.resourceType !== 'RelatedPerson') {
      await medplum.signOut().catch(() => medplum.clear());
      throw new Error('This is a staff account. Staff sign in to the staff app.');
    }
    await reload();
    const next = params.get('next');
    navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/home', { replace: true });
  };

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent): void => {
    e.preventDefault();
    void run(async () => {
      // Only the password step's refusal is reworded; it never says which of the two was wrong.
      const res = await medplum.startLogin({ email: email.trim(), password, projectId: import.meta.env.MEDPLUM_PROJECT_ID }).catch((err: unknown) => {
        const raw = normalizeErrorString(err);
        throw new Error(/password|email|not found|invalid/i.test(raw) ? `That email and password do not match a portal sign-in.${import.meta.env.DEV ? ` (${raw})` : ''}` : raw);
      });
      await finish(res);
    });
  };

  return (
    <div className="tm-page" style={{ maxWidth: 400 }}>
      <Stack gap="xl" mt="md">
        <Stack gap={2} ta="center">
          <Title order={1}>Sign in</Title>
          <Text size="sm" c="dimmed">to your Teleemon patient portal</Text>
        </Stack>
      <Card>
        {stage.kind === 'password' && (
          <form onSubmit={submitPassword}>
            <Stack>
              <TextInput label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
              <PasswordInput label="Password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
              {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
              <Button type="submit" loading={busy} fullWidth>Sign in</Button>
            </Stack>
          </form>
        )}
        {(stage.kind === 'mfa' || stage.kind === 'enroll') && (
          <Stack>
            {stage.kind === 'enroll' && (
              <>
                <Text>Your practice requires an authenticator app. Scan this code with it, then enter the 6-digit code.</Text>
                {stage.qr && <Image src={stage.qr} alt="Authenticator setup code" w={180} h={180} />}
              </>
            )}
            {stage.kind === 'mfa' && <Text>Enter the 6-digit code from your authenticator app.</Text>}
            <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} aria-label="Authenticator code" />
            {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
            <Button loading={busy} disabled={code.length !== 6} onClick={() => void run(async () => finish(await medplum.post(stage.kind === 'enroll' ? 'auth/mfa/login-enroll' : 'auth/mfa/verify', { login: stage.login, token: code })))}>Continue</Button>
          </Stack>
        )}
        {stage.kind === 'profile' && (
          <Stack gap="xs">
            <Text fw={650}>Whose portal do you want to open?</Text>
            {stage.memberships.map((m) => (
              <UnstyledButton key={m.id} onClick={() => void run(async () => finish(await medplum.post('auth/profile', { login: stage.login, profile: m.id })))} style={{ border: '1px solid var(--tm-border)', borderRadius: 10, padding: '12px 14px' }}>
                <Stack gap={0} style={{ flex: 1 }}>
                  <Text fw={600}>{m.profile?.display ?? 'Portal'}</Text>
                  <Text size="sm" c="dimmed">{m.profile?.reference?.startsWith('RelatedPerson/') ? 'As parent or guardian' : 'Your own care'}</Text>
                </Stack>
                <IconChevronRight size={18} style={{ float: 'right', marginTop: -32 }} />
              </UnstyledButton>
            ))}
            {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
          </Stack>
        )}
      </Card>
      <Stack gap={4} ta="center">
        <Text size="sm">
          New here? <Anchor component={Link} to="/register">Create an account</Anchor> or <Anchor component={Link} to="/book">book a visit</Anchor>
        </Text>
        <Text size="sm" c="dimmed">Forgot your password? Call the practice.</Text>
      </Stack>
      </Stack>
    </div>
  );
}
