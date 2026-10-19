import { Alert, Button, Group, Radio, Stack, TextInput, Textarea, Title } from '@mantine/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { IntakeAnswers } from '@teleemon/core';
import { INTAKE_QUESTIONNAIRE_URL, INTAKE_SECTIONS, crisisLanguage, intakeAnswers, intakeItems, missingIntakeAnswers } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useMe, useSession } from '../../session';
import type { StepProps } from '../IntakePage';
import { CrisisNow } from './CrisisNow';

/** Saves the intake answers as an in-progress QuestionnaireResponse; Review submits it. */
export async function saveIntake(medplum: ReturnType<typeof useSession>['medplum'], patientRef: string, existing: QuestionnaireResponse | undefined, answers: IntakeAnswers, status: 'in-progress' | 'completed' = 'in-progress'): Promise<QuestionnaireResponse> {
  const qr: QuestionnaireResponse = {
    ...(existing ?? {}),
    resourceType: 'QuestionnaireResponse',
    questionnaire: INTAKE_QUESTIONNAIRE_URL,
    status,
    subject: { reference: patientRef },
    authored: new Date().toISOString(),
    item: intakeItems(answers),
  };
  return existing ? medplum.updateResource(qr) : medplum.createResource(qr);
}

export function HistoryStep({ overview, saved }: StepProps): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const existing = overview.intakeState?.intake;
  const locked = existing?.status === 'completed';
  const [answers, setAnswers] = useState<IntakeAnswers>(() => intakeAnswers(existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const missing = missingIntakeAnswers(answers);
  const worrying = Object.values(answers).some((a) => typeof a === 'string' && crisisLanguage(a));

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await saveIntake(medplum, me.patientRef, existing, answers);
      saved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      {locked && <Alert color="green">You submitted these answers. To add anything, send your care team a message.</Alert>}
      {INTAKE_SECTIONS.map((section) => (
        <Stack key={section.key} gap="sm">
          <Title order={3}>{section.title}</Title>
          {section.questions.filter((q) => !q.when || answers[q.when] === true).map((q) => {
            const value = answers[q.linkId];
            if (q.type === 'boolean') {
              return (
                <Radio.Group key={q.linkId} label={q.text} withAsterisk={q.required} value={value === undefined ? '' : value ? 'yes' : 'no'} onChange={(v) => setAnswers({ ...answers, [q.linkId]: v === 'yes' })}>
                  <Group mt={6}><Radio value="yes" label="Yes" disabled={locked} /><Radio value="no" label="No" disabled={locked} /></Group>
                </Radio.Group>
              );
            }
            const Input = q.type === 'text' ? Textarea : TextInput;
            return <Input key={q.linkId} label={q.text} withAsterisk={q.required} disabled={locked} maxLength={4000} value={typeof value === 'string' ? value : ''} onChange={(e) => setAnswers({ ...answers, [q.linkId]: e.currentTarget.value })} />;
          })}
        </Stack>
      ))}
      {worrying && <CrisisNow />}
      {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      {!locked && (
        <Group justify="flex-end">
          <Button variant="default" loading={busy} onClick={() => void saveIntake(medplum, me.patientRef, existing, answers).then(() => saved(false), (e: unknown) => setError(errorText(e)))}>Save for later</Button>
          <Button loading={busy} disabled={missing.length > 0} onClick={() => void save()}>Save and continue</Button>
        </Group>
      )}
    </Stack>
  );
}
