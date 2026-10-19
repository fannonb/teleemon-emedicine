import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCalendarPlus, IconChecklist, IconClipboardText, IconFileText, IconMessage, IconPill, IconVideo } from '@tabler/icons-react';
import { INTAKE_STEPS, stepDone } from '@teleemon/core';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { formatWhen } from '../components/SlotPicker';
import { Show, useLoader } from '../components/states';
import type { PortalOverview } from '../data';
import { loadOverview, providerName } from '../data';
import { useMe, useSession } from '../session';
import { Page } from '../components/Shell';

// X03 Home: the next visit first, with check-in available whenever the visit is booked.
export function HomePage(): JSX.Element {
  const { medplum, api } = useSession();
  const me = useMe();
  const overview = useLoader(() => loadOverview(medplum, api, me), [medplum, api, me.patientRef, me.access]);
  return (
    <Page title={`Hello, ${me.actorName.split(' ')[0]}`} subtitle={me.access === 'self' ? undefined : `You are managing ${me.patientName}'s care.`}>
      <Show loaded={overview} rows={3}>{(o) => <HomeBody o={o} />}</Show>
    </Page>
  );
}

function HomeBody({ o }: { readonly o: PortalOverview }): JSX.Element {
  const me = useMe();
  const canCheckIn = o.next?.status === 'booked';
  const checkedIn = o.next?.status === 'arrived' || o.next?.status === 'checked-in';
  const doneSteps = o.intakeState ? INTAKE_STEPS.filter((s) => stepDone(s.key, o.intakeState as never)).length : 0;
  // New-patient forms are for patients who have not had a visit yet; established patients (including
  // migrated ones) only get the questionnaires for their next visit.
  const established = o.appointments.some((a) => a.status === 'fulfilled');
  const intakeDone = established || (o.intakeState ? stepDone('review', o.intakeState) : true);
  return (
    <Stack gap="lg">
      <Card>
        {o.next ? (
          <Stack gap="sm">
            <Group justify="space-between" align="flex-start">
              <div>
                <Text size="sm" c="dimmed">Next visit</Text>
                <Title order={2}>{formatWhen(o.next.start as string)}</Title>
                <Text size="sm">{o.next.appointmentType?.text ?? 'Visit'} with {providerName(o.next)}</Text>
              </div>
              {o.next.status === 'pending' ? <Badge color="orange">Waiting for email confirmation</Badge> : o.next.status === 'arrived' || o.next.status === 'checked-in' ? <Badge color="green">Checked in</Badge> : <Badge leftSection={<IconVideo size={14} />}>Video</Badge>}
            </Group>
            <Group>
              <Button component={Link} to={`/visit/${o.next.id}`} variant={canCheckIn || checkedIn ? 'filled' : 'light'}>{checkedIn ? 'Join visit' : canCheckIn ? 'Check in' : 'Visit details'}</Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm" align="flex-start">
            <Text fw={650}>No upcoming visits</Text>
            {me.visitTypes.length > 0 && <Button component={Link} to="/appointments/new" leftSection={<IconCalendarPlus size={18} />}>Book a visit</Button>}
          </Stack>
        )}
      </Card>

      {me.clinical && (!intakeDone || o.measuresDue.length > 0) && (
        <Card>
          <Stack gap="sm">
            <Group gap="xs"><ThemeIcon variant="light" color="orange"><IconChecklist size={18} /></ThemeIcon><Title order={2}>Before your visit</Title></Group>
            {!intakeDone && (
              <Stack gap={6}>
                <Group justify="space-between"><Text>New patient forms</Text><Text size="sm" c="dimmed" className="tm-num">{doneSteps} of {INTAKE_STEPS.length} done</Text></Group>
                <Progress value={(doneSteps / INTAKE_STEPS.length) * 100} aria-label="Intake progress" />
                <Button component={Link} to="/intake" variant="light" style={{ alignSelf: 'flex-start' }}>{doneSteps ? 'Continue where you left off' : 'Start your forms'}</Button>
              </Stack>
            )}
            {intakeDone && o.measuresDue.length > 0 && (
              <Group justify="space-between">
                <Text>{o.measuresDue.length} short questionnaire{o.measuresDue.length > 1 ? 's' : ''} ({o.measuresDue.map((m) => m.shortTitle).join(', ')})</Text>
                <Button component={Link} to="/intake?step=measures" variant="light">Answer now</Button>
              </Group>
            )}
          </Stack>
        </Card>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        <Tile to="/appointments" icon={<IconCalendarPlus size={20} />} label="Visits" text="Book, cancel or check in" />
        {me.clinical && <Tile to="/messages" icon={<IconMessage size={20} />} label="Messages" text="Non-urgent questions" />}
        {me.clinical && <Tile to="/summaries" icon={<IconFileText size={20} />} label="Summaries" text="After-visit summaries" />}
        {me.clinical && <Tile to="/refills" icon={<IconPill size={20} />} label="Refills" text="Request a refill" />}
        {me.clinical && intakeDone && <Tile to="/intake" icon={<IconClipboardText size={20} />} label="Forms" text="Consents and payment" />}
      </SimpleGrid>
    </Stack>
  );
}

function Tile({ to, icon, label, text }: { readonly to: string; readonly icon: JSX.Element; readonly label: string; readonly text: string }): JSX.Element {
  return (
    <Card component={Link} to={to} style={{ textDecoration: 'none' }} padding="md">
      <Stack gap={4}>
        <ThemeIcon variant="light" size={36} radius="xl">{icon}</ThemeIcon>
        <Text fw={650} c="var(--mantine-color-text)">{label}</Text>
        <Text size="sm" c="dimmed">{text}</Text>
      </Stack>
    </Card>
  );
}
