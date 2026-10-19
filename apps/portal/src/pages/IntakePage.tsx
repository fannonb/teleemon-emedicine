import { Badge, Button, Card, Group, Progress, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import type { IntakeStep } from '@teleemon/core';
import { INTAKE_STEPS, resumeStep, stepDone } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Page } from '../components/Shell';
import { Show, useLoader } from '../components/states';
import type { PortalOverview } from '../data';
import { loadOverview } from '../data';
import { useMe, useSession } from '../session';
import { AboutStep } from './intake/AboutStep';
import { ConsentsStep } from './intake/ConsentsStep';
import { HistoryStep } from './intake/HistoryStep';
import { InsuranceStep } from './intake/InsuranceStep';
import { MeasuresStep } from './intake/MeasuresStep';
import { PaymentStep } from './intake/PaymentStep';
import { ReviewStep } from './intake/ReviewStep';

export interface StepProps {
  readonly overview: PortalOverview;
  /** Reload from the server, then optionally move to the next step. */
  readonly saved: (advance?: boolean) => void;
}

// X02 Intake wizard: every step saves to the server as you go, so it resumes where you stopped on any device.
export function IntakePage(): JSX.Element {
  const { medplum, api } = useSession();
  const me = useMe();
  const overview = useLoader(() => loadOverview(medplum, api, me), [medplum, api, me.patientRef, me.access]);
  return (
    <Page title="Your forms" subtitle="Saved as you go. You can stop and come back any time.">
      <Show loaded={overview} rows={4}>{(o) => <Wizard overview={o} reload={overview.reload} />}</Show>
    </Page>
  );
}

function Wizard({ overview, reload }: { readonly overview: PortalOverview; readonly reload: () => void }): JSX.Element {
  const [params] = useSearchParams();
  const state = overview.intakeState;
  const requested = INTAKE_STEPS.find((s) => s.key === params.get('step'))?.key;
  const [step, setStep] = useState<IntakeStep>(requested ?? (state ? resumeStep(state) : 'about'));
  const [advance, setAdvance] = useState(false);
  const index = INTAKE_STEPS.findIndex((s) => s.key === step);

  // After a save, move on once the reloaded data is in.
  useEffect(() => {
    if (!advance) return;
    setAdvance(false);
    const next = INTAKE_STEPS[index + 1];
    if (next) setStep(next.key);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [overview, advance, index]);

  if (!state) return <Card><Text>Only the patient can fill in these forms.</Text></Card>;
  const saved = (move = true): void => {
    if (move) setAdvance(true);
    reload();
  };
  const props: StepProps = { overview, saved };
  const doneCount = INTAKE_STEPS.filter((x) => stepDone(x.key, state)).length;
  return (
    <Stack gap="md">
      <Stack gap={6}>
        <Group justify="space-between">
          <Text fw={650}>Step {index + 1} of {INTAKE_STEPS.length} · {INTAKE_STEPS[index].label}</Text>
          <Text size="sm" c="dimmed" className="tm-num">{doneCount} done</Text>
        </Group>
        <Progress value={(doneCount / INTAKE_STEPS.length) * 100} aria-label="Forms progress" />
      </Stack>
      <nav className="tm-step-row" aria-label="Form steps">
        {INTAKE_STEPS.map((s, i) => {
          const done = stepDone(s.key, state);
          return (
            <Button key={s.key} size="xs" radius="xl" variant={i === index ? 'filled' : done ? 'light' : 'default'} color={done && i !== index ? 'green' : undefined}
              leftSection={done ? <IconCheck size={14} /> : undefined} onClick={() => setStep(s.key)} aria-current={i === index ? 'step' : undefined}>
              {s.label}
            </Button>
          );
        })}
      </nav>
      <Card>
        <Group justify="space-between" mb="md">
          <Text fw={650} size="lg">{INTAKE_STEPS[index].label}</Text>
          {stepDone(step, state) && <Badge color="green">Done</Badge>}
        </Group>
        {step === 'about' && <AboutStep {...props} />}
        {step === 'insurance' && <InsuranceStep {...props} />}
        {step === 'history' && <HistoryStep {...props} />}
        {step === 'measures' && <MeasuresStep {...props} />}
        {step === 'consents' && <ConsentsStep {...props} />}
        {step === 'payment' && <PaymentStep {...props} />}
        {step === 'review' && <ReviewStep {...props} goTo={setStep} />}
      </Card>
    </Stack>
  );
}
