import { Button, Group, Modal, Text } from '@mantine/core';
import { useIdle, useInterval } from '@mantine/hooks';
import { useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

// P01: automatic sign-out after a period of inactivity, with a one-minute warning.

const WARNING_SECONDS = 60;

function idleMinutes(): number {
  const configured = Number(import.meta.env.TELEEMON_IDLE_MINUTES);
  return Number.isFinite(configured) && configured >= 2 ? configured : 15;
}

export function IdleTimeout(): JSX.Element {
  const medplum = useMedplum();
  const warnAfterMs = (idleMinutes() * 60 - WARNING_SECONDS) * 1000;
  const idle = useIdle(warnAfterMs, { initialState: false });
  const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS);
  const countdown = useInterval(() => setSecondsLeft((s) => s - 1), 1000);

  useEffect(() => {
    if (idle) {
      setSecondsLeft(WARNING_SECONDS);
      countdown.start();
    } else {
      countdown.stop();
    }
    return countdown.stop;
  }, [idle]);

  useEffect(() => {
    if (idle && secondsLeft <= 0) {
      countdown.stop();
      medplum.signOut().then(() => window.location.assign('/signin?reason=idle')).catch(console.error);
    }
  }, [idle, secondsLeft, medplum, countdown]);

  return (
    <Modal
      opened={idle}
      onClose={() => undefined}
      withCloseButton={false}
      centered
      title="Are you still there?"
      closeOnClickOutside={false}
    >
      <Text size="sm" mb="md" aria-live="assertive">
        For patient privacy you will be signed out in{' '}
        <Text span fw={700} className="tm-num">
          {Math.max(secondsLeft, 0)} seconds
        </Text>
        . Move the mouse or press any key to stay signed in.
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => medplum.signOut().then(() => window.location.assign('/signin'))}>
          Sign out now
        </Button>
        <Button>Stay signed in</Button>
      </Group>
    </Modal>
  );
}
