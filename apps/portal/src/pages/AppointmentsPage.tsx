import { Alert, Badge, Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Appointment } from '@medplum/fhirtypes';
import { IconCalendarPlus } from '@tabler/icons-react';
import { cancelCheck } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { formatWhen } from '../components/SlotPicker';
import { Empty, Show, useLoader } from '../components/states';
import { isUpcoming, loadAppointments, providerName } from '../data';
import { useMe, useSession } from '../session';

const STATUS: Partial<Record<Appointment['status'], { label: string; color: string }>> = {
  booked: { label: 'Confirmed', color: 'brand' },
  pending: { label: 'Confirm by email', color: 'orange' },
  arrived: { label: 'Checked in', color: 'green' },
  'checked-in': { label: 'Checked in', color: 'green' },
  fulfilled: { label: 'Completed', color: 'gray' },
  cancelled: { label: 'Cancelled', color: 'gray' },
  noshow: { label: 'Missed', color: 'orange' },
};

export function AppointmentsPage(): JSX.Element {
  const { medplum, api } = useSession();
  const me = useMe();
  const visits = useLoader(() => loadAppointments(medplum, me), [medplum, me.patientRef]);
  const [cancelling, setCancelling] = useState<Appointment>();
  const [busy, setBusy] = useState(false);

  const doCancel = async (): Promise<void> => {
    if (!cancelling) return;
    setBusy(true);
    try {
      const { late } = await api.post<{ late: boolean }>(`appointments/${cancelling.id}/cancel`);
      notifications.show({ color: 'brand', message: late ? 'Visit cancelled. This was within 24 hours, so a late-cancellation fee may apply.' : 'Visit cancelled.' });
      setCancelling(undefined);
      visits.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not cancelled', message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Visits" actions={me.visitTypes.length > 0 ? <Button component={Link} to="/appointments/new" leftSection={<IconCalendarPlus size={18} />}>Book</Button> : undefined}>
      <Show loaded={visits}>
        {(all) => {
          const upcoming = all.filter((a) => isUpcoming(a));
          const past = all.filter((a) => !isUpcoming(a)).reverse().slice(0, 20);
          return (
            <Stack gap="lg">
              <Stack gap="sm">
                <Title order={2}>Upcoming</Title>
                {upcoming.length === 0 ? (
                  <Empty title="No upcoming visits" text={me.visitTypes.length ? 'Book a visit and it will appear here.' : 'Your care team will book your next visit.'} />
                ) : upcoming.map((a) => (
                  <Card key={a.id} padding="md">
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Stack gap={2}>
                        <Text fw={650}>{formatWhen(a.start as string, me.lastState)}</Text>
                        <Text size="sm" c="dimmed">{a.appointmentType?.text ?? 'Visit'} · {providerName(a)}</Text>
                      </Stack>
                      <Badge color={STATUS[a.status]?.color ?? 'gray'}>{STATUS[a.status]?.label ?? a.status}</Badge>
                    </Group>
                    <Group mt="sm" gap="xs">
                      <VisitButton appointment={a} />
                      {!cancelCheck(a).problem && <Button size="sm" variant="subtle" color="red" onClick={() => setCancelling(a)}>Cancel</Button>}
                    </Group>
                  </Card>
                ))}
              </Stack>
              {past.length > 0 && (
                <Stack gap="xs">
                  <Title order={2}>Past</Title>
                  {past.map((a) => (
                    <Group key={a.id} justify="space-between" py={8} wrap="nowrap" style={{ borderBottom: '1px solid var(--tm-border)' }}>
                      <Stack gap={0}>
                        <Text size="sm">{formatWhen(a.start as string, me.lastState)}</Text>
                        <Text size="xs" c="dimmed">{a.appointmentType?.text ?? 'Visit'}</Text>
                      </Stack>
                      {PAST[a.status] && <Badge color={PAST[a.status]?.color} variant="light">{PAST[a.status]?.label}</Badge>}
                    </Group>
                  ))}
                </Stack>
              )}
            </Stack>
          );
        }}
      </Show>
      <Modal opened={!!cancelling} onClose={() => setCancelling(undefined)} title="Cancel this visit?" centered>
        {cancelling && (
          <Stack>
            <Text>{formatWhen(cancelling.start as string, me.lastState)}</Text>
            {cancelCheck(cancelling).late && <Alert color="orange">This is less than 24 hours away, so a late-cancellation fee may apply.</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCancelling(undefined)}>Keep visit</Button>
              <Button color="red" loading={busy} onClick={() => void doCancel()}>Cancel visit</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Page>
  );
}

/** How a past visit ended, in the patient's words. Visits staff never closed out show no label. */
const PAST: Partial<Record<string, { label: string; color: string }>> = {
  fulfilled: { label: 'Attended', color: 'green' },
  noshow: { label: 'Missed', color: 'orange' },
  cancelled: { label: 'Cancelled', color: 'gray' },
};

/** The main action for an upcoming visit: check in any time once booked, then join. */
function VisitButton({ appointment }: { readonly appointment: Appointment }): JSX.Element {
  const checkedIn = appointment.status === 'arrived' || appointment.status === 'checked-in';
  const canCheckIn = appointment.status === 'booked';
  const label = checkedIn ? 'Join visit' : canCheckIn ? 'Check in' : 'Details';
  return <Button size="sm" variant={checkedIn || canCheckIn ? 'filled' : 'light'} component={Link} to={`/visit/${appointment.id}`}>{label}</Button>;
}
