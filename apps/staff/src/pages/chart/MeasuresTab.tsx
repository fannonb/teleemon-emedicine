import { Alert, Badge, Button, Card, Group, Modal, Radio, Select, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { BundleEntry, Flag, QuestionnaireResponse } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertOctagon, IconClipboardList, IconPlus } from '@tabler/icons-react';
import type { MeasureDef } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, MEASURES, MEASURE_LIST, questionnaireUrl, scoreMeasure } from '@teleemon/core';
import { getExtensionValue } from '@medplum/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { ScoreChange, TrendChart } from '../../components/charts';
import { Section } from '../../components/Section';
import { loadScores } from '../../fhir/clinical';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

const FUTURE: string[] = ['PHQ-A (adolescent)', 'MDQ', 'DAST-10', 'PCL-5', 'Y-BOCS', 'C-SSRS screener', 'Vanderbilt'];

// P15 Measures and assessments.
export function MeasuresTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient, refresh } = useChart();
  const [entering, setEntering] = useState<MeasureDef['key']>();
  const scores = useLoader(() => loadScores(medplum, patient), [patient.id], 5000);
  const safety = useLoader(async () => {
    const flags = await medplum.searchResources('Flag', { subject: `Patient/${patient.id}`, status: 'active' }, { cache: 'no-cache' });
    return flags.filter((f) => f.code.coding?.some((c) => c.system === CODE_SYSTEMS.flagCode && c.code === 'safety-screen-positive'));
  }, [patient.id], 5000);

  return (
    <Stack gap="lg">
      {safety.data?.map((f) => <SafetyBanner key={f.id} flag={f} onResolved={() => { safety.reload(); refresh(); }} />)}
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Scores are calculated on the server, so portal and in-session entries are scored the same way. Severity bands are shaded behind each trend.
        </Text>
        <Select
          placeholder="Enter a measure…"
          data={MEASURE_LIST.map((m) => ({ value: m.key, label: m.title }))}
          value={null}
          onChange={(v) => v && setEntering(v as MeasureDef['key'])}
          leftSection={<IconPlus size={16} />}
          w={320}
          aria-label="Enter a measure"
        />
      </Group>
      <Section loaded={scores} isEmpty={(s) => s.length === 0} empty={{ icon: <IconClipboardList size={22} />, title: 'No measures recorded', text: 'Enter a PHQ-9, GAD-7, ASRS or AUDIT-C above. Patients complete them in the portal from Phase 7.' }}>
        {(series) => (
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            {series.map((s) => {
              const last = s.points[s.points.length - 1];
              const prev = s.points[s.points.length - 2];
              return (
                <Card key={s.def.key} withBorder padding="md">
                  <Group justify="space-between" align="flex-start" mb="xs">
                    <div>
                      <Title order={3}>{s.def.shortTitle}</Title>
                      <Text size="xs" c="dimmed">
                        Latest {formatDate(last.date.slice(0, 10))} · {s.points.length} result{s.points.length === 1 ? '' : 's'}
                      </Text>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <Group gap={6} justify="flex-end">
                        <Text fz={26} fw={700} lh={1} className="tm-num">
                          {last.value}
                        </Text>
                        <Text size="xs" c="dimmed">
                          / {s.def.maxScore}
                        </Text>
                      </Group>
                      <Group gap={6} justify="flex-end" mt={4}>
                        <ScoreChange current={last.value} previous={prev?.value} />
                        <Badge size="sm" variant="light" color={s.def.bands.find((b) => last.value >= b.min && last.value <= b.max)?.color ?? 'gray'}>
                          {last.observation.interpretation?.[0]?.text}
                        </Badge>
                      </Group>
                    </div>
                  </Group>
                  <TrendChart label={`${s.def.shortTitle} scores`} points={s.points} max={s.def.maxScore} bands={s.def.key === 'asrs-a' || s.def.key === 'audit-c' ? [] : [...s.def.bands]} />
                </Card>
              );
            })}
          </SimpleGrid>
        )}
      </Section>
      <Text size="xs" c="dimmed">
        More instruments planned: {FUTURE.join(', ')}.
      </Text>
      {entering && (
        <MeasureEntryModal
          def={MEASURES[entering]}
          onClose={() => setEntering(undefined)}
          onSaved={() => {
            setEntering(undefined);
            scores.reload();
            safety.reload();
            refresh();
          }}
        />
      )}
    </Stack>
  );
}

function MeasureEntryModal({ def, onClose, onSaved }: { readonly def: MeasureDef; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [answers, setAnswers] = useState<Record<string, number | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const result = scoreMeasure(def, answers, getExtensionValue(patient, EXT.sexAssignedAtBirth) as string | undefined);

  const save = async (): Promise<void> => {
    if (!result.complete) {
      setError('Answer every item. If the patient declined an item, note it in the visit documentation.');
      return;
    }
    setSaving(true);
    try {
      const saved = await medplum.createResource<QuestionnaireResponse>({
        resourceType: 'QuestionnaireResponse',
        questionnaire: questionnaireUrl(def.key),
        status: 'completed',
        subject: createReference(patient),
        authored: new Date().toISOString(),
        author: profile ? createReference(profile) : undefined,
        source: createReference(patient),
        item: def.items.map((item) => ({
          linkId: item.linkId,
          text: item.text,
          answer: [{ valueCoding: { code: String(answers[item.linkId]), display: item.options.find((o) => o.value === answers[item.linkId])?.label } }],
        })),
      });
      let scored = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        scored = !!(await medplum.searchOne('Observation', { 'derived-from': `QuestionnaireResponse/${saved.id}` }, { cache: 'no-cache' }).catch(() => undefined));
        if (scored) break;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      notifications.show({
        color: result.safetyConcern ? 'red' : 'brand',
        title: `${def.shortTitle} saved: ${result.score}`,
        message: !scored ? 'Answers saved. Server scoring is pending; this page checks for updates. Complete a safety assessment now if indicated.' : result.safetyConcern ? 'Positive safety item. The server has recorded the score, safety alert and urgent review task.' : result.band?.label,
      });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={def.title} size="xl" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          {def.prompt}
        </Text>
        {def.items.map((item, i) => (
          <Radio.Group
            key={item.linkId}
            label={`${i + 1}. ${item.text}`}
            value={answers[item.linkId] === undefined ? null : String(answers[item.linkId])}
            onChange={(v) => setAnswers((a) => ({ ...a, [item.linkId]: Number(v) }))}
            styles={{ label: { fontWeight: 500, marginBottom: 6 } }}
          >
            <Group gap="md">
              {item.options.map((o) => (
                <Radio key={o.value} value={String(o.value)} label={o.label} />
              ))}
            </Group>
          </Radio.Group>
        ))}
        {result.safetyConcern && (
          <Alert color="red" icon={<IconAlertOctagon size={18} />} title="Positive safety item">
            {result.safetyDetail}. Saving creates an urgent safety review for the provider. Follow the practice safety protocol now if the patient is at imminent risk (988 / 911).
          </Alert>
        )}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="space-between" mt="xs">
          <Text size="sm" className="tm-num">
            Score <b>{result.score}</b> / {def.maxScore}
            {result.band && result.complete ? ` · ${result.band.label}` : ''}
            {!result.complete && <Text span c="dimmed"> · {def.items.length - Object.keys(answers).length} unanswered</Text>}
          </Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!result.complete}>
              Save {def.shortTitle}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function SafetyBanner({ flag, onResolved }: { readonly flag: Flag; readonly onResolved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const resolve = async (): Promise<void> => {
    if (note.trim().length < 10) return;
    setSaving(true);
    try {
      const observationRef = flag.extension?.find((e) => e.url === 'http://hl7.org/fhir/StructureDefinition/flag-detail')?.valueReference?.reference;
      const observation = observationRef?.startsWith('Observation/') ? await medplum.readResource('Observation', observationRef.split('/')[1]) : undefined;
      const source = observation?.derivedFrom?.find((r) => r.reference?.startsWith('QuestionnaireResponse/'))?.reference;
      const tasks = await medplum.searchResources('Task', { subject: flag.subject.reference as string, code: `${CODE_SYSTEMS.taskCode}|safety-review`, status: 'requested,ready,in-progress' });
      const entries: BundleEntry[] = [{
        resource: { ...flag, status: 'inactive', period: { ...flag.period, end: new Date().toISOString() }, extension: [...(flag.extension ?? []), { url: EXT.reviewNote, valueString: note.trim() }] },
        request: { method: 'PUT', url: `Flag/${flag.id}`, ifMatch: flag.meta?.versionId ? `W/"${flag.meta.versionId}"` : undefined },
      }];
      for (const t of tasks.filter((t) => !!source && t.focus?.reference === source)) entries.push({
        resource: { ...t, status: 'completed', note: [...(t.note ?? []), { text: note.trim() }] },
        request: { method: 'PUT', url: `Task/${t.id}`, ifMatch: t.meta?.versionId ? `W/"${t.meta.versionId}"` : undefined },
      });
      await medplum.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: entries });
      onResolved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Alert color="red" variant="filled" icon={<IconAlertOctagon size={20} />} title="Positive safety screen">
      <Group justify="space-between" align="flex-end">
        <Text size="sm">Flagged {formatDate(flag.period?.start?.slice(0, 10))}. Complete a safety assessment and document the plan, then mark this reviewed.</Text>
        <Button size="xs" variant="white" color="red" onClick={() => setOpen(true)}>
          Mark reviewed
        </Button>
      </Group>
      <Modal opened={open} onClose={() => setOpen(false)} title="Safety review completed" centered>
        <Stack>
          <Textarea label="Assessment and plan (summary)" description="Full documentation goes in the visit note." value={note} onChange={(e) => setNote(e.currentTarget.value)} autosize minRows={3} required />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button color="red" loading={saving} disabled={note.trim().length < 10} onClick={resolve}>
              Mark reviewed
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Alert>
  );
}
