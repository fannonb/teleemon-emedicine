import { Alert, Button, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed } from '@tabler/icons-react';
import type { IntakeStep } from '@teleemon/core';
import { INTAKE_STEPS, intakeAnswers, stepDone } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useMe, useSession } from '../../session';
import type { StepProps } from '../IntakePage';
import { saveIntake } from './HistoryStep';

// Submitting locks the intake answers (policy: a completed response cannot be edited).
export function ReviewStep({ overview, saved, goTo }: StepProps & { readonly goTo: (s: IntakeStep) => void }): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const state = overview.intakeState;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!state) return <></>;
  const steps = INTAKE_STEPS.filter((s) => s.key !== 'review');
  const missing = steps.filter((s) => !stepDone(s.key, state));
  const submitted = state.intake?.status === 'completed';

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await saveIntake(medplum, me.patientRef, state.intake, intakeAnswers(state.intake), 'completed');
      saved(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      {steps.map((s) => (
        <UnstyledButton key={s.key} onClick={() => goTo(s.key)}>
          <Group gap="xs">
            {stepDone(s.key, state) ? <IconCircleCheck size={20} color="var(--mantine-color-green-7)" /> : <IconCircleDashed size={20} color="var(--mantine-color-orange-7)" />}
            <Text>{s.label}</Text>
            {!stepDone(s.key, state) && <Text size="sm" c="orange.8">Still to do</Text>}
          </Group>
        </UnstyledButton>
      ))}
      {submitted ? (
        <Alert color="green" icon={<IconCircleCheck size={18} />}>Your forms are submitted. Thank you. Your care team will review them before your visit.</Alert>
      ) : (
        <>
          {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
          <Group justify="flex-end"><Button loading={busy} disabled={missing.length > 0} onClick={() => void submit()}>Submit my forms</Button></Group>
          {missing.length > 0 && <Text size="sm" c="dimmed" ta="right">Finish the steps above to submit.</Text>}
        </>
      )}
    </Stack>
  );
}
