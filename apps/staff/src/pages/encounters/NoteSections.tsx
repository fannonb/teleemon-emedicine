import { ActionIcon, Autocomplete, Badge, Button, Card, Checkbox, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import type { Condition } from '@medplum/fhirtypes';
import { IconArrowDown, IconArrowUp, IconCopy, IconLock, IconPlus, IconX } from '@tabler/icons-react';
import type { NoteData, NoteDiagnosis, NoteTemplate, RiskAssessment, SectionKey, TemplateSettings } from '@teleemon/core';
import { DIAGNOSES, MSE_DOMAINS, PSYCHOTHERAPY_MODALITIES, SECTION_LABELS, SI_LABELS, addOnFor, findDiagnosis } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { conditionCode, conditionStatus } from '../../fhir/clinical';
import classes from './Encounter.module.css';

/** Sections whose text is often carried forward from the last signed note. */
export const COPYABLE: SectionKey[] = ['pastHistory', 'socialHistory', 'substanceUse', 'assessment', 'plan'];

/** Expands a smart phrase (".trigger" followed by a space or new line) at the end of the text. */
export function expandPhrases(text: string, phrases: TemplateSettings['phrases']): string {
  const m = /(^|\s)(\.[a-z0-9-]+)([ \n])$/i.exec(text);
  if (!m) return text;
  const phrase = phrases.find((p) => p.trigger.toLowerCase() === m[2].toLowerCase());
  return phrase ? `${text.slice(0, text.length - m[2].length - 1)}${phrase.text}${m[3]}` : text;
}

interface Props {
  readonly template: NoteTemplate;
  readonly note: NoteData;
  readonly onChange: (next: NoteData) => void;
  readonly phrases: TemplateSettings['phrases'];
  readonly problemList: Condition[];
  readonly onAddDiagnosis: (code: string) => Promise<Condition | undefined>;
  readonly previous?: NoteData;
  readonly copied: Set<SectionKey>;
  readonly onCopied: (key: SectionKey, on: boolean) => void;
  readonly measuresText?: string;
  readonly highlight?: Set<string>;
  readonly readOnly?: boolean;
}

export function NoteSections(props: Props): JSX.Element {
  const { template, note, onChange, readOnly } = props;
  const set = (patch: Partial<NoteData>): void => onChange({ ...note, ...patch });
  const setSection = (key: SectionKey, value: string): void => {
    if (props.copied.has(key)) props.onCopied(key, false);
    set({ sections: { ...note.sections, [key]: expandPhrases(value, props.phrases) } });
  };

  return (
    <Stack gap="md">
      {template.sections.map((key) => (
        <SectionCard
          key={key}
          id={`section-${key}`}
          title={SECTION_LABELS[key]}
          flagged={props.highlight?.has(key)}
          badge={props.copied.has(key) ? <Badge size="xs" color="orange" variant="light">Copied from last note · review</Badge> : undefined}
          action={
            !readOnly && COPYABLE.includes(key) && props.previous?.sections[key] ? (
              <Tooltip label="Copy this section from the last signed note">
                <Button size="compact-xs" variant="subtle" leftSection={<IconCopy size={12} />} onClick={() => { set({ sections: { ...note.sections, [key]: props.previous?.sections[key] } }); props.onCopied(key, true); }}>
                  Copy forward
                </Button>
              </Tooltip>
            ) : undefined
          }
        >
          {key === 'mse' ? (
            <MseEditor note={note} onChange={onChange} readOnly={readOnly} />
          ) : key === 'risk' ? (
            <RiskEditor risk={note.risk} onChange={(risk) => set({ risk })} readOnly={readOnly} />
          ) : key === 'diagnoses' ? (
            <DiagnosesEditor diagnoses={note.diagnoses} problemList={props.problemList} onChange={(diagnoses) => set({ diagnoses })} onAdd={props.onAddDiagnosis} readOnly={readOnly} />
          ) : key === 'psychotherapy' ? (
            <PsychotherapyEditor note={note} onChange={onChange} readOnly={readOnly} />
          ) : key === 'measures' ? (
            <Stack gap={6}>
              {props.measuresText ? (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} className="tm-num">
                  {props.measuresText}
                </Text>
              ) : (
                <Text size="sm" c="dimmed">
                  No scores on file. Enter a PHQ-9 or GAD-7 from the chart's Measures tab.
                </Text>
              )}
              <Textarea placeholder="Comments on the scores (optional)" autosize minRows={1} value={note.sections.measures ?? ''} onChange={(e) => setSection('measures', e.currentTarget.value)} readOnly={readOnly} />
            </Stack>
          ) : (
            <Textarea
              autosize
              minRows={key === 'intervalHistory' || key === 'assessment' || key === 'plan' ? 3 : 2}
              value={note.sections[key] ?? ''}
              onChange={(e) => setSection(key, e.currentTarget.value)}
              placeholder={key === 'plan' ? 'Medication changes, labs, therapy, referrals… (type .plan-cont and a space for a smart phrase)' : undefined}
              readOnly={readOnly}
              aria-label={SECTION_LABELS[key]}
            />
          )}
          {key === 'plan' && (
            <Checkbox mt="sm" label="I reviewed the patient's medication list at this visit" checked={note.medsReviewed} onChange={(e) => set({ medsReviewed: e.currentTarget.checked })} disabled={readOnly} />
          )}
        </SectionCard>
      ))}
      {note.privateNotes && <SectionCard
        id="section-private"
        title="Private psychotherapy notes"
        badge={<Badge size="xs" color="gray" leftSection={<IconLock size={10} />}>Never exported or released</Badge>}
      >
        <Textarea
          autosize
          minRows={2}
            placeholder="Legacy note content only. Use the separate private notes record below for new psychotherapy notes."
          value={note.privateNotes ?? ''}
            readOnly
            description="This legacy field shares the clinical note's access. It is excluded from exports, but is not a separate private record."
        />
      </SectionCard>}
    </Stack>
  );
}

function SectionCard({ id, title, badge, action, flagged, children }: { readonly id: string; readonly title: string; readonly badge?: ReactNode; readonly action?: ReactNode; readonly flagged?: boolean; readonly children: ReactNode }): JSX.Element {
  return (
    <Card id={id} padding="md" className={flagged ? classes.sectionFlagged : undefined}>
      <Group justify="space-between" mb={8} wrap="nowrap" mih={24}>
        <Group gap={8}>
          <Text fw={650} size="sm">
            {title}
          </Text>
          {badge}
        </Group>
        {action}
      </Group>
      {children}
    </Card>
  );
}

function MseEditor({ note, onChange, readOnly }: { readonly note: NoteData; readonly onChange: (n: NoteData) => void; readonly readOnly?: boolean }): JSX.Element {
  const setDomain = (key: string, value: string): void => onChange({ ...note, mse: { ...note.mse, [key]: value } });
  const allNormal = (): void => {
    const mse = { ...note.mse };
    for (const d of MSE_DOMAINS) if (d.options.length && !mse[d.key]) mse[d.key] = d.options[0];
    onChange({ ...note, mse });
  };
  return (
    <Stack gap="xs">
      {!readOnly && (
        <Group justify="flex-end" mt={-36} mb={4}>
          <Button size="compact-xs" variant="light" onClick={allNormal}>
            Fill empty domains with normal findings
          </Button>
        </Group>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" verticalSpacing="xs">
        {MSE_DOMAINS.map((d) =>
          d.options.length ? (
            <Autocomplete key={d.key} size="xs" label={d.label} data={d.options} value={note.mse[d.key] ?? ''} onChange={(v) => setDomain(d.key, v)} readOnly={readOnly} placeholder="Choose or type" />
          ) : (
            <TextInput key={d.key} size="xs" label={d.label} placeholder="e.g. “pretty good this week”" value={note.mse[d.key] ?? ''} onChange={(e) => setDomain(d.key, e.currentTarget.value)} readOnly={readOnly} />
          )
        )}
      </SimpleGrid>
    </Stack>
  );
}

function RiskEditor({ risk, onChange, readOnly }: { readonly risk: RiskAssessment; readonly onChange: (r: RiskAssessment) => void; readonly readOnly?: boolean }): JSX.Element {
  const high = risk.suicidalIdeation === 'active-no-plan' || risk.suicidalIdeation === 'active-plan' || risk.level === 'high';
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        <Select size="xs" label="Suicidal ideation" data={Object.entries(SI_LABELS).map(([value, label]) => ({ value, label }))} value={risk.suicidalIdeation ?? null} onChange={(v) => onChange({ ...risk, suicidalIdeation: (v ?? undefined) as RiskAssessment['suicidalIdeation'] })} readOnly={readOnly} />
        <Select size="xs" label="Homicidal ideation" data={[{ value: 'denied', label: 'Denies' }, { value: 'present', label: 'Present' }]} value={risk.homicidalIdeation ?? null} onChange={(v) => onChange({ ...risk, homicidalIdeation: (v ?? undefined) as RiskAssessment['homicidalIdeation'] })} readOnly={readOnly} />
        <Select size="xs" label="Self-harm" data={[{ value: 'none', label: 'None recent' }, { value: 'recent', label: 'Recent' }]} value={risk.selfHarm ?? null} onChange={(v) => onChange({ ...risk, selfHarm: (v ?? undefined) as RiskAssessment['selfHarm'] })} readOnly={readOnly} />
        <Select size="xs" label="Overall risk" data={[{ value: 'low', label: 'Low' }, { value: 'moderate', label: 'Moderate' }, { value: 'high', label: 'High' }]} value={risk.level ?? null} onChange={(v) => onChange({ ...risk, level: (v ?? undefined) as RiskAssessment['level'] })} readOnly={readOnly} />
      </SimpleGrid>
      <Checkbox
        label="Safety plan reviewed and updated with the patient"
        color={high ? 'red' : undefined}
        checked={!!risk.safetyPlanReviewed}
        onChange={(e) => onChange({ ...risk, safetyPlanReviewed: e.currentTarget.checked })}
        description={high ? 'Required for active suicidal ideation or high risk' : undefined}
        disabled={readOnly}
      />
      <Textarea size="xs" autosize minRows={1} placeholder="Protective factors, access to means, collateral (optional)" value={risk.notes ?? ''} onChange={(e) => onChange({ ...risk, notes: e.currentTarget.value })} readOnly={readOnly} />
    </Stack>
  );
}

function DiagnosesEditor({
  diagnoses,
  problemList,
  onChange,
  onAdd,
  readOnly,
}: {
  readonly diagnoses: NoteDiagnosis[];
  readonly problemList: Condition[];
  readonly onChange: (d: NoteDiagnosis[]) => void;
  readonly onAdd: (code: string) => Promise<Condition | undefined>;
  readonly readOnly?: boolean;
}): JSX.Element {
  const chosen = new Set(diagnoses.map((d) => d.code));
  const active = problemList.filter((c) => ['active', 'remission'].includes(conditionStatus(c)) && !chosen.has(conditionCode(c) ?? ''));
  const move = (i: number, dir: -1 | 1): void => {
    const next = [...diagnoses];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };
  return (
    <Stack gap="xs">
      {diagnoses.length === 0 && (
        <Text size="sm" c="dimmed">
          Add the diagnoses addressed at this visit. The first is the principal diagnosis on the claim.
        </Text>
      )}
      {diagnoses.map((d, i) => (
        <Group key={d.code} gap="xs" wrap="nowrap" className={classes.dxRow}>
          <Badge variant="filled" color="navy" size="sm" w={22} px={0}>
            {String.fromCharCode(65 + i)}
          </Badge>
          <Badge variant="outline" color="gray" className="tm-num" miw={64}>
            {d.code}
          </Badge>
          <Text size="sm" style={{ flex: 1 }}>
            {d.display}
          </Text>
          {!readOnly && (
            <Group gap={2} wrap="nowrap">
              <ActionIcon size="sm" variant="subtle" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <IconArrowUp size={14} />
              </ActionIcon>
              <ActionIcon size="sm" variant="subtle" disabled={i === diagnoses.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <IconArrowDown size={14} />
              </ActionIcon>
              <ActionIcon size="sm" variant="subtle" color="red" onClick={() => onChange(diagnoses.filter((x) => x.code !== d.code))} aria-label="Remove">
                <IconX size={14} />
              </ActionIcon>
            </Group>
          )}
        </Group>
      ))}
      {!readOnly && (
        <>
          {active.length > 0 && (
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                From the problem list:
              </Text>
              {active.map((c) => (
                <Button
                  key={c.id}
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconPlus size={11} />}
                  onClick={() => onChange([...diagnoses, { code: conditionCode(c) as string, display: c.code?.text ?? c.code?.coding?.[0]?.display ?? '', conditionId: c.id }])}
                >
                  {conditionCode(c)} {c.code?.text}
                </Button>
              ))}
            </Group>
          )}
          <Select
            size="xs"
            placeholder="Add a new diagnosis (also adds it to the problem list)"
            searchable
            data={DIAGNOSES.filter((d) => !chosen.has(d.code)).map((d) => ({ value: d.code, label: `${d.code}  ${d.display}` }))}
            value={null}
            onChange={async (code) => {
              if (!code) return;
              const condition = await onAdd(code);
              const dx = findDiagnosis(code);
              if (dx) onChange([...diagnoses, { code, display: dx.display, conditionId: condition?.id }]);
            }}
          />
        </>
      )}
    </Stack>
  );
}

function PsychotherapyEditor({ note, onChange, readOnly }: { readonly note: NoteData; readonly onChange: (n: NoteData) => void; readonly readOnly?: boolean }): JSX.Element {
  const p = note.psychotherapy ?? {};
  const suggested = addOnFor(p.minutes);
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        <NumberInput size="xs" label="Psychotherapy minutes (face to face, separate from E/M)" min={0} max={120} value={p.minutes ?? ''} onChange={(v) => onChange({ ...note, psychotherapy: { ...p, minutes: v === '' ? undefined : Number(v) } })} readOnly={readOnly} />
        <Select size="xs" label="Modality" data={PSYCHOTHERAPY_MODALITIES} value={p.modality ?? null} onChange={(v) => onChange({ ...note, psychotherapy: { ...p, modality: v ?? undefined } })} readOnly={readOnly} />
      </SimpleGrid>
      <Text size="xs" c={suggested ? 'brand.7' : 'dimmed'}>
        {suggested ? `${p.minutes} minutes supports add-on ${suggested}.` : 'At least 16 minutes are needed for a psychotherapy add-on (90833 16–37, 90836 38–52, 90838 53+).'}
      </Text>
      <Textarea size="xs" autosize minRows={2} placeholder="Focus and interventions" value={p.focus ?? ''} onChange={(e) => onChange({ ...note, psychotherapy: { ...p, focus: e.currentTarget.value } })} readOnly={readOnly} />
    </Stack>
  );
}
