import { Alert, Box, List, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { SignInForm } from '@medplum/react';
import { IconClockHour4, IconLock, IconShieldCheck } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { FullLogo, Logo } from '../layout/Logo';
import classes from './SignInPage.module.css';

// P01. Medplum's SignInForm runs the full flow: password, then TOTP enrolment or verification
// when the project setting `mfaRequired` is on (see `npm run setup -- --mfa`).
// Layout: on wide screens a navy brand panel with the full logo sits beside the form. On narrow
// screens a navy header band carries the compact logo above the form.

export function SignInPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const reason = params.get('reason');

  return (
    <div className={classes.page}>
      <header className={classes.mobileHeader}>
        <Logo height={40} />
        <Text size="sm" className={classes.mobileTagline}>
          Staff sign-in
        </Text>
      </header>

      <aside className={classes.brandPanel}>
        <FullLogo height={108} tone="white" />
        <div>
          <Title order={1} className={classes.headline}>
            Calm, safe, multi-state psychiatric care.
          </Title>
          <List spacing="sm" className={classes.points} icon={null}>
            <List.Item icon={<ThemeIcon size={26} radius="xl" color="brand" variant="filled"><IconShieldCheck size={15} /></ThemeIcon>}>
              Two-factor sign-in for every staff account
            </List.Item>
            <List.Item icon={<ThemeIcon size={26} radius="xl" color="brand" variant="filled"><IconLock size={15} /></ThemeIcon>}>
              Every chart view is recorded in the audit log
            </List.Item>
            <List.Item icon={<ThemeIcon size={26} radius="xl" color="brand" variant="filled"><IconClockHour4 size={15} /></ThemeIcon>}>
              Sessions end automatically when idle
            </List.Item>
          </List>
        </div>
        <Text size="xs" className={classes.legal}>
          Teleemon Behavioral Health & Wellness, PLLC · Bellevue, WA
        </Text>
      </aside>

      <main className={classes.formPanel}>
        <Box w="100%" maw={420}>
          <Stack gap="lg">
            {reason === 'idle' && (
              <Alert color="blue" variant="light" title="You were signed out">
                Your session ended after a period of inactivity, to protect patient privacy.
              </Alert>
            )}
            <Paper withBorder radius="lg" className={classes.card}>
              <div className={classes.cardBody}>
                <SignInForm onSuccess={() => navigate('/today')} disableGoogleAuth clientId={import.meta.env.MEDPLUM_CLIENT_ID || undefined} projectId={import.meta.env.MEDPLUM_PROJECT_ID || undefined}>
                  <Stack gap={4} mb="sm" align="center">
                    <Title order={2}>Staff sign-in</Title>
                    <Text size="sm" c="dimmed">
                      Authorized Teleemon staff only
                    </Text>
                  </Stack>
                </SignInForm>
              </div>
            </Paper>
            <Text size="xs" c="dimmed" ta="center">
              Access to this system is monitored. Use of protected health information is limited to treatment,
              payment and operations.
            </Text>
          </Stack>
        </Box>
      </main>
    </div>
  );
}
