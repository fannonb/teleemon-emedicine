// Measurement-based care instruments and their scoring (P15). The same scoring runs in the
// browser (immediate feedback) and in the measure-scoring Bot (authoritative Observation, Flag
// and urgent Task for positive safety items), so the two can never disagree.

import { CODE_SYSTEMS, LOINC_SYSTEM, TELEEMON_BASE } from './fhir';

export interface MeasureOption {
  readonly value: number;
  readonly label: string;
}

export interface MeasureItem {
  readonly linkId: string;
  readonly text: string;
  readonly options: readonly MeasureOption[];
}

export interface SeverityBand {
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly color: 'green' | 'yellow' | 'orange' | 'red';
}

export interface MeasureDef {
  readonly key: 'phq9' | 'gad7' | 'asrs-a' | 'audit-c';
  readonly title: string;
  readonly shortTitle: string;
  readonly prompt: string;
  /** Code for the total-score Observation. */
  readonly scoreCode: { system: string; code: string; display: string };
  readonly items: readonly MeasureItem[];
  readonly maxScore: number;
  readonly bands: readonly SeverityBand[];
}

export interface MeasureResult {
  readonly score: number;
  readonly complete: boolean;
  readonly band?: SeverityBand;
  /** For screening tools: whether the screen is positive. */
  readonly positive?: boolean;
  /** A response that requires same-day clinical attention (e.g. PHQ-9 item 9 > 0). */
  readonly safetyConcern: boolean;
  readonly safetyDetail?: string;
}

export const QUESTIONNAIRE_URL_BASE = `${TELEEMON_BASE}/Questionnaire`;

const FREQ_2W: MeasureOption[] = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Several days' },
  { value: 2, label: 'More than half the days' },
  { value: 3, label: 'Nearly every day' },
];

const ASRS_FREQ: MeasureOption[] = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'Rarely' },
  { value: 2, label: 'Sometimes' },
  { value: 3, label: 'Often' },
  { value: 4, label: 'Very often' },
];

export const MEASURES: Record<MeasureDef['key'], MeasureDef> = {
  phq9: {
    key: 'phq9',
    title: 'Patient Health Questionnaire (PHQ-9)',
    shortTitle: 'PHQ-9',
    prompt: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
    scoreCode: { system: LOINC_SYSTEM, code: '44261-6', display: 'PHQ-9 total score' },
    items: [
      'Little interest or pleasure in doing things',
      'Feeling down, depressed, or hopeless',
      'Trouble falling or staying asleep, or sleeping too much',
      'Feeling tired or having little energy',
      'Poor appetite or overeating',
      'Feeling bad about yourself, or that you are a failure or have let yourself or your family down',
      'Trouble concentrating on things, such as reading the newspaper or watching television',
      'Moving or speaking so slowly that other people could have noticed, or the opposite: being so fidgety or restless that you have been moving around a lot more than usual',
      'Thoughts that you would be better off dead, or of hurting yourself in some way',
    ].map((text, i) => ({ linkId: `phq9-${i + 1}`, text, options: FREQ_2W })),
    maxScore: 27,
    bands: [
      { min: 0, max: 4, label: 'Minimal', color: 'green' },
      { min: 5, max: 9, label: 'Mild', color: 'yellow' },
      { min: 10, max: 14, label: 'Moderate', color: 'orange' },
      { min: 15, max: 19, label: 'Moderately severe', color: 'red' },
      { min: 20, max: 27, label: 'Severe', color: 'red' },
    ],
  },
  gad7: {
    key: 'gad7',
    title: 'Generalized Anxiety Disorder scale (GAD-7)',
    shortTitle: 'GAD-7',
    prompt: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
    scoreCode: { system: LOINC_SYSTEM, code: '70274-6', display: 'GAD-7 total score' },
    items: [
      'Feeling nervous, anxious, or on edge',
      'Not being able to stop or control worrying',
      'Worrying too much about different things',
      'Trouble relaxing',
      'Being so restless that it is hard to sit still',
      'Becoming easily annoyed or irritable',
      'Feeling afraid, as if something awful might happen',
    ].map((text, i) => ({ linkId: `gad7-${i + 1}`, text, options: FREQ_2W })),
    maxScore: 21,
    bands: [
      { min: 0, max: 4, label: 'Minimal', color: 'green' },
      { min: 5, max: 9, label: 'Mild', color: 'yellow' },
      { min: 10, max: 14, label: 'Moderate', color: 'orange' },
      { min: 15, max: 21, label: 'Severe', color: 'red' },
    ],
  },
  'asrs-a': {
    key: 'asrs-a',
    title: 'Adult ADHD Self-Report Scale v1.1, Part A (ASRS screener)',
    shortTitle: 'ASRS',
    prompt: 'Over the past 6 months, how often…',
    scoreCode: { system: CODE_SYSTEMS.measure, code: 'asrs-a-total', display: 'ASRS v1.1 Part A total score' },
    items: [
      'How often do you have trouble wrapping up the final details of a project, once the challenging parts have been done?',
      'How often do you have difficulty getting things in order when you have to do a task that requires organization?',
      'How often do you have problems remembering appointments or obligations?',
      'When you have a task that requires a lot of thought, how often do you avoid or delay getting started?',
      'How often do you fidget or squirm with your hands or feet when you have to sit down for a long time?',
      'How often do you feel overly active and compelled to do things, like you were driven by a motor?',
    ].map((text, i) => ({ linkId: `asrs-${i + 1}`, text, options: ASRS_FREQ })),
    maxScore: 24,
    bands: [
      { min: 0, max: 24, label: 'See screen result', color: 'yellow' },
    ],
  },
  'audit-c': {
    key: 'audit-c',
    title: 'Alcohol Use Disorders Identification Test – Consumption (AUDIT-C)',
    shortTitle: 'AUDIT-C',
    prompt: 'Please answer about your drinking over the past year.',
    scoreCode: { system: LOINC_SYSTEM, code: '75626-2', display: 'AUDIT-C total score' },
    items: [
      {
        linkId: 'auditc-1',
        text: 'How often do you have a drink containing alcohol?',
        options: ['Never', 'Monthly or less', '2–4 times a month', '2–3 times a week', '4 or more times a week'].map((label, value) => ({ value, label })),
      },
      {
        linkId: 'auditc-2',
        text: 'How many standard drinks containing alcohol do you have on a typical day?',
        options: ['1 or 2', '3 or 4', '5 or 6', '7 to 9', '10 or more'].map((label, value) => ({ value, label })),
      },
      {
        linkId: 'auditc-3',
        text: 'How often do you have six or more drinks on one occasion?',
        options: ['Never', 'Less than monthly', 'Monthly', 'Weekly', 'Daily or almost daily'].map((label, value) => ({ value, label })),
      },
    ],
    maxScore: 12,
    bands: [
      { min: 0, max: 2, label: 'Negative', color: 'green' },
      { min: 3, max: 3, label: 'Positive for women; negative for men', color: 'yellow' },
      { min: 4, max: 12, label: 'Positive', color: 'orange' },
    ],
  },
};

export const MEASURE_LIST = Object.values(MEASURES);

export function questionnaireUrl(key: MeasureDef['key']): string {
  return `${QUESTIONNAIRE_URL_BASE}/${key}`;
}

export function measureFromQuestionnaireUrl(url: string | undefined): MeasureDef | undefined {
  return MEASURE_LIST.find((m) => questionnaireUrl(m.key) === url?.split('|')[0]);
}

/**
 * Scores a set of answers. `answers` maps item linkId → option value.
 * `sexAtBirth` affects the AUDIT-C threshold (3 for female, 4 otherwise).
 */
export function scoreMeasure(def: MeasureDef, answers: Record<string, number | undefined>, sexAtBirth?: string): MeasureResult {
  const values = def.items.map((i) => answers[i.linkId]);
  const complete = values.every((v) => typeof v === 'number');
  const score = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const band = def.bands.find((b) => score >= b.min && score <= b.max);

  if (def.key === 'phq9') {
    const item9 = answers['phq9-9'] ?? 0;
    return {
      score,
      complete,
      band,
      safetyConcern: item9 > 0,
      safetyDetail: item9 > 0 ? `PHQ-9 item 9 (thoughts of death or self-harm) answered "${FREQ_2W[item9].label}"` : undefined,
    };
  }
  if (def.key === 'asrs-a') {
    // Positive when 4 or more answers fall in the shaded boxes: items 1–3 at "Sometimes" or more,
    // items 4–6 at "Often" or more.
    const shaded = def.items.filter((item, idx) => (answers[item.linkId] ?? -1) >= (idx < 3 ? 2 : 3)).length;
    const positive = shaded >= 4;
    return {
      score,
      complete,
      positive,
      band: { min: 0, max: 24, label: positive ? `Screen positive (${shaded} of 6)` : `Screen negative (${shaded} of 6)`, color: positive ? 'orange' : 'green' },
      safetyConcern: false,
    };
  }
  if (def.key === 'audit-c') {
    // 4 or more for males, 3 or more for females. When sex assigned at birth is not recorded (or is
    // intersex/not listed), the lower threshold is used so a positive screen is not missed. Pending
    // confirmation by the clinical lead (PATIENT-ONBOARDING-PLAN.md, decision 6).
    const threshold = sexAtBirth === 'male' ? 4 : 3;
    const positive = score >= threshold;
    const assumed = sexAtBirth !== 'male' && sexAtBirth !== 'female';
    return {
      score,
      complete,
      positive,
      band: { min: 0, max: 12, label: `${positive ? 'Positive screen' : 'Negative screen'}${assumed ? ' (threshold 3: sex at birth not recorded)' : ''}`, color: positive ? 'orange' : 'green' },
      safetyConcern: false,
    };
  }
  return { score, complete, band, safetyConcern: false };
}
