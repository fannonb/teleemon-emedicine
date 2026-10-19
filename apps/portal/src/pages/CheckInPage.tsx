import { Alert, Button, Card, Checkbox, Group, Select, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconExternalLink, IconMapPin } from '@tabler/icons-react';
import { US_STATES } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { formatWhen } from '../components/SlotPicker';
import { Show, useLoader } from '../components/states';
import { providerName } from '../data';
import { useMe, useSession } from '../session';

interface VisitStatus {
  readonly checkIn: { problem?: string; reconfirm: boolean };
  readonly checkedIn: boolean;
  readonly confirmedState?: string;
  readonly bookedState?: string;
  readonly join: { available: boolean; problem?: string };
}

const stateName = (code?: string): string => US_STATES.find((s) => s.code === code)?.name ?? code ?? '';

// X04 Check-in: confirm where you are; the join button exists only after the server accepts it.
export function CheckInPage(): JSX.Element {
  const { id = '' } = useParams();
  const { medplum, api } = useSession();
  const me = useMe();
  const appt = useLoader(() => medplum.readResource('Appointment', id, { cache: 'no-cache' }), [medplum, id]);
  const status = useLoader(() => api.get<VisitStatus>(`appointments/${id}/status`), [api, id]);

  // Keep the patient's view in sync if staff check the visit in or start it from the calendar.
  useEffect(() => {
    const timer = window.setInterval(status.reload, 30000);
    return () => window.clearInterval(timer);
  }, [status.reload]);

  return (
    <Page title="Your visit">
      <Show loaded={appt}>
        {(a) => (
          <Card>
            <Stack gap={4}>
              <Title order={2}>{formatWhen(a.start as string, me.lastState)}</Title>
              <Text c="dimmed">{a.appointmentType?.text ?? 'Visit'} with {providerName(a)} · video</Text>
            </Stack>
          </Card>
        )}
      </Show>
      <Show loaded={status}>{(s) => <CheckIn id={id} status={s} onChange={status.reload} />}</Show>
    </Page>
  );
}

function CheckIn({ id, status, onChange }: { readonly id: string; readonly status: VisitStatus; readonly onChange: () => void }): JSX.Element {
  const { api } = useSession();
  const [state, setState] = useState<string | null>(status.confirmedState ?? status.bookedState ?? null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const checkIn = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`appointments/${id}/check-in`, { state, confirm });
      onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const join = async (): Promise<void> => {
    setError(undefined);
    // Open the tab synchronously (pop-up blockers), then point it at the link.
    const tab = window.open('', '_blank');
    try {
      const res = await api.get<{ url?: string; pending?: boolean }>(`appointments/${id}/join`);
      if (res.url && tab) {
        tab.opener = null;
        tab.location.href = res.url;
      } else {
        tab?.close();
        setPending(true);
      }
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    }
  };

  if (status.checkedIn && !status.checkIn.reconfirm) {
    return (
      <Card>
        <Stack>
          <Group gap="xs"><IconCircleCheck color="var(--mantine-color-green-7)" /><Text fw={650}>Checked in from {stateName(status.confirmedState) || 'your confirmed location'}</Text></Group>
          <Text size="sm" c="dimmed">The provider will start the visit when ready. If your location changes before then, tell your provider before the visit starts.</Text>
          {status.join.available ? (
            <Button size="lg" leftSection={<IconExternalLink size={18} />} onClick={() => void join()}>Join video visit</Button>
          ) : (
            <Alert color="gray">{status.join.problem}</Alert>
          )}
          {pending && <Alert color="blue">The video link is not ready yet. Try again in a minute. You stay checked in.</Alert>}
          {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        </Stack>
      </Card>
    );
  }

  const reconfirm = status.checkIn.reconfirm;
  return (
    <Card>
      <Stack>
        <Group gap="xs"><IconMapPin size={20} /><Title order={2}>{reconfirm ? 'Confirm your location' : 'Check in'}</Title></Group>
        {status.checkIn.problem ? (
          <Text>{status.checkIn.problem}</Text>
        ) : (
          <>
            <Text size="sm">
              {reconfirm
                ? 'It has been a while since you checked in, and you may have moved. Confirm where you are right now — you stay checked in. Your provider must be licensed where you are.'
                : 'Check in whenever you are ready. Your provider will start the visit when ready. Your provider must be licensed where you are right now.'}
            </Text>
            <Select label="Where are you right now?" data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} searchable value={state} onChange={(v) => { setState(v); setConfirm(false); }} />
            {state && (
              <Checkbox checked={confirm} onChange={(e) => setConfirm(e.currentTarget.checked)} label={`I am physically in ${stateName(state)} now. I will tell my provider if I move before the visit starts.`} />
            )}
            {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
            <Button size="lg" disabled={!state || !confirm} loading={busy} onClick={() => void checkIn()}>{reconfirm ? 'Confirm location' : 'Check in'}</Button>
            <Text size="xs" c="dimmed">The video link appears after you check in.</Text>
          </>
        )}
      </Stack>
    </Card>
  );
}
