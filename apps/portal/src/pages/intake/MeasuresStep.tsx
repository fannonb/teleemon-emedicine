import { Alert, Button, Card, Group, Radio, Stack, Text, Title } from '@mantine/core';
import type { MeasureDef } from '@teleemon/core';
import { questionnaireUrl, scoreMeasure } from '@teleemon/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useMe, useSession } from '../../session';
import type { StepProps } from '../IntakePage';
import { CrisisNow } from './CrisisNow';

// Questionnaires for the next visit (the visit type's measures). Scoring, the safety alert and the
// urgent review task are done by the server (measure-scoring Bot), as for staff-entered measures.
export function MeasuresStep({ overview, saved }: StepProps): JSX.Element {
  const [safety, setSafety] = useState(false);
  if (!overview.next) return <Text c="dimmed">Questionnaires are sent before each visit. You have none to complete now.</Text>;
  if (overview.measuresDue.length === 0) {
    return (
      <Stack>
        <Group gap="xs"><IconCircleCheck color="var(--mantine-color-green-7)" /><Text>All questionnaires for your next visit are done. Thank you.</Text></Group>
        {safety && <CrisisNow />}
        <Group justify="flex-end"><Button onClick={() => saved()}>Continue</Button></Group>
      </Stack>
    );
  }
  const def = overview.measuresDue[0];
  return (
    <Stack>
      <Text size="sm" c="dimmed">{overview.measuresDue.length} to go. Your provider reviews your answers with you at the visit.</Text>
      {safety && <CrisisNow />}
      <MeasureForm key={def.key} def={def} onSaved={(concern) => { if (concern) setSafety(true); saved(false); }} />
    </Stack>
  );
}

function MeasureForm({ def, onSaved }: { readonly def: MeasureDef; readonly onSaved: (safetyConcern: boolean) => void }): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const [answers, setAnswers] = useState<Record<string, number | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const result = scoreMeasure(def, answers);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await medplum.createResource({
        resourceType: 'QuestionnaireResponse',
        questionnaire: questionnaireUrl(def.key),
        status: 'completed',
        subject: { reference: me.patientRef },
        author: { reference: me.actor },
        source: { reference: me.actor },
        authored: new Date().toISOString(),
        item: def.items.map((item) => ({
          linkId: item.linkId,
          text: item.text,
          answer: [{ valueCoding: { code: String(answers[item.linkId]), display: item.options.find((o) => o.value === answers[item.linkId])?.label } }],
        })),
      });
      onSaved(result.safetyConcern);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder={false} padding={0}>
      <Stack>
        <div>
          <Title order={3}>{def.title}</Title>
          <Text size="sm" c="dimmed">{def.prompt}</Text>
        </div>
        {def.items.map((item, i) => (
          <Radio.Group key={item.linkId} label={`${i + 1}. ${item.text}`} value={answers[item.linkId] === undefined ? '' : String(answers[item.linkId])} onChange={(v) => setAnswers({ ...answers, [item.linkId]: Number(v) })}>
            <Stack gap={6} mt={6}>
              {item.options.map((o) => <Radio key={o.value} value={String(o.value)} label={o.label} />)}
            </Stack>
          </Radio.Group>
        ))}
        {result.safetyConcern && <CrisisNow />}
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end"><Button loading={busy} disabled={!result.complete} onClick={() => void submit()}>Submit {def.shortTitle}</Button></Group>
      </Stack>
    </Card>
  );
}
