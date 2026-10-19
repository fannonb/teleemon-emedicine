import { Alert, Button, Card, Group, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { US_STATES } from '@teleemon/core';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { PortalError, errorText } from '../api';
import { Page } from '../components/Shell';
import type { FreeDay, FreeTime } from '../components/SlotPicker';
import { SlotPicker, formatWhen } from '../components/SlotPicker';
import { Empty } from '../components/states';
import { useMe, useSession } from '../session';

// Signed-in booking (X03): visit type and state are pre-filled from the patient's history, so a
// returning patient picks a day, a time and confirms.
export function BookVisitPage(): JSX.Element {
  const { api } = useSession();
  const me = useMe();
  const navigate = useNavigate();
  const [visitType, setVisitType] = useState(me.visitTypes[0]?.code);
  const [state, setState] = useState<string | null>(me.lastState && me.states.includes(me.lastState) ? me.lastState : null);
  const [time, setTime] = useState<FreeTime>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (from: string): Promise<FreeDay[]> => (await api.get<{ days: FreeDay[] }>(`slots?state=${state}&visitType=${visitType}&from=${from}`)).days, [api, state, visitType]);

  if (!me.visitTypes.length) {
    return <Page title="Book a visit"><Empty title="Your next visit is booked by the care team" text="Your new patient visit is already booked. Follow-up visits can be booked here after it." /></Page>;
  }

  const book = async (): Promise<void> => {
    if (!time || !state || !visitType) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post('appointments', { visitType, state, start: time.start, practitionerId: time.practitionerId });
      notifications.show({ color: 'brand', title: 'Visit booked', message: formatWhen(time.start, state) });
      navigate('/appointments');
    } catch (err) {
      setError(errorText(err));
      if (err instanceof PortalError && err.code === 'taken') setTime(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Book a visit">
      <Card>
        <Stack>
          {me.visitTypes.length > 1 && (
            <SegmentedControl fullWidth value={visitType} onChange={(v) => { setVisitType(v); setTime(undefined); }} data={me.visitTypes.map((v) => ({ value: v.code, label: `${v.label.replace('Medication management', 'Med management')} · ${v.minutes} min` }))} orientation={me.visitTypes.length > 2 ? 'vertical' : 'horizontal'} />
          )}
          <Select label="Where will you be during the visit?" description="You must be in this state for the whole visit." data={US_STATES.map((s) => ({ value: s.code, label: s.name }))} searchable value={state} onChange={(v) => { setState(v); setTime(undefined); }} />
          {state && !me.states.includes(state) && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>Your provider is licensed in {me.states.join(', ')} only. Choose the state you will be in at the time of the visit.</Alert>
          )}
          {state && me.states.includes(state) && visitType && <SlotPicker key={`${state}-${visitType}`} load={load} state={state} value={time} onChange={setTime} />}
          {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
          {time && state && (
            <Group justify="space-between" align="center">
              <Text size="sm"><b>{formatWhen(time.start, state)}</b> with {time.provider}</Text>
              <Button loading={busy} onClick={() => void book()}>Book this time</Button>
            </Group>
          )}
        </Stack>
      </Card>
    </Page>
  );
}
