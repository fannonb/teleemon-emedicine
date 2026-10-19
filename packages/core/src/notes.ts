// Clinical note rules (P21, P23, P24). The editor, the note-rules pre-commit Bot and the exports
// all use these, so "can this note be signed?" has one answer everywhere.
// CPT/E-M rules are planning guidance from the scope and must be confirmed by the billing
// advisor before go-live (scope §22).

import { findDiagnosis } from './diagnoses';
import type { Composition } from '@medplum/fhirtypes';
import { CODE_SYSTEMS } from './fhir';
import type { Modality } from './fhir';

export type SectionKey =
  | 'chiefComplaint'
  | 'intervalHistory'
  | 'psychRos'
  | 'substanceUse'
  | 'pastHistory'
  | 'socialHistory'
  | 'mse'
  | 'risk'
  | 'measures'
  | 'assessment'
  | 'diagnoses'
  | 'plan'
  | 'psychotherapy'
  | 'followUp';

export const SECTION_LABELS: Record<SectionKey, string> = {
  chiefComplaint: 'Chief complaint',
  intervalHistory: 'Interval history',
  psychRos: 'Psychiatric review of systems',
  substanceUse: 'Substance use',
  pastHistory: 'Past psychiatric and medical history',
  socialHistory: 'Social history',
  mse: 'Mental status examination',
  risk: 'Risk assessment',
  measures: 'Measures',
  assessment: 'Assessment',
  diagnoses: 'Diagnoses',
  plan: 'Plan',
  psychotherapy: 'Psychotherapy',
  followUp: 'Follow-up',
};

export type TemplateCode = 'psych-eval' | 'med-mgmt' | 'med-mgmt-therapy' | 'brief' | 'crisis' | 'telephone';

export interface NoteTemplate {
  readonly code: TemplateCode;
  readonly label: string;
  readonly sections: SectionKey[];
  /** Visit types (scheduling codes) this template is the default for. */
  readonly visitTypes: string[];
  readonly evaluation?: boolean;
  readonly psychotherapy?: boolean;
  readonly defaults: Partial<Record<SectionKey, string>>;
}

const CORE: SectionKey[] = ['chiefComplaint', 'intervalHistory', 'psychRos', 'substanceUse', 'mse', 'risk', 'measures', 'assessment', 'diagnoses', 'plan', 'followUp'];

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    code: 'psych-eval',
    label: 'Psychiatric evaluation (90792)',
    visitTypes: ['new-eval'],
    evaluation: true,
    sections: ['chiefComplaint', 'intervalHistory', 'psychRos', 'substanceUse', 'pastHistory', 'socialHistory', 'mse', 'risk', 'measures', 'assessment', 'diagnoses', 'plan', 'followUp'],
    defaults: { intervalHistory: 'History of present illness: ' },
  },
  { code: 'med-mgmt', label: 'Medication management follow-up', visitTypes: ['med-mgmt', 'office-med-mgmt'], sections: CORE, defaults: {} },
  {
    code: 'med-mgmt-therapy',
    label: 'Medication management + psychotherapy',
    visitTypes: ['med-mgmt-therapy'],
    psychotherapy: true,
    sections: [...CORE.slice(0, -1), 'psychotherapy', 'followUp'],
    defaults: {},
  },
  { code: 'brief', label: 'Brief check-in', visitTypes: ['brief'], sections: ['intervalHistory', 'mse', 'risk', 'assessment', 'diagnoses', 'plan', 'followUp'], defaults: {} },
  { code: 'crisis', label: 'Crisis note', visitTypes: [], sections: ['chiefComplaint', 'intervalHistory', 'mse', 'risk', 'assessment', 'diagnoses', 'plan', 'followUp'], defaults: { plan: 'Safety plan reviewed with patient. Crisis resources provided (988, 911). ' } },
  { code: 'telephone', label: 'Telephone note', visitTypes: [], sections: ['intervalHistory', 'risk', 'assessment', 'diagnoses', 'plan', 'followUp'], defaults: {} },
];

export function findTemplate(code: string | undefined): NoteTemplate | undefined {
  return NOTE_TEMPLATES.find((t) => t.code === code);
}

export function templateForVisitType(visitType: string | undefined): NoteTemplate {
  return NOTE_TEMPLATES.find((t) => visitType && t.visitTypes.includes(visitType)) ?? (NOTE_TEMPLATES[1] as NoteTemplate);
}

/** Structured MSE pick-lists; the first option is the usual normal finding. */
export const MSE_DOMAINS: { key: string; label: string; options: string[] }[] = [
  { key: 'appearance', label: 'Appearance', options: ['Well groomed, appropriately dressed', 'Disheveled', 'Poor hygiene', 'Unusual dress'] },
  { key: 'behavior', label: 'Behavior', options: ['Calm, cooperative, good eye contact', 'Guarded', 'Restless', 'Psychomotor retardation', 'Agitated'] },
  { key: 'speech', label: 'Speech', options: ['Normal rate, rhythm and volume', 'Pressured', 'Slowed', 'Soft', 'Loud', 'Poverty of speech'] },
  { key: 'mood', label: 'Mood (patient’s words)', options: [] },
  { key: 'affect', label: 'Affect', options: ['Euthymic, full range, congruent', 'Constricted', 'Blunted', 'Flat', 'Labile', 'Anxious', 'Dysphoric', 'Irritable', 'Expansive'] },
  { key: 'thoughtProcess', label: 'Thought process', options: ['Linear and goal-directed', 'Circumstantial', 'Tangential', 'Flight of ideas', 'Loose associations', 'Thought blocking'] },
  { key: 'thoughtContent', label: 'Thought content', options: ['No delusions, obsessions or preoccupations', 'Ruminative', 'Obsessions', 'Paranoid ideation', 'Delusions'] },
  { key: 'perception', label: 'Perception', options: ['No hallucinations reported or observed', 'Auditory hallucinations', 'Visual hallucinations', 'Appears internally preoccupied'] },
  { key: 'cognition', label: 'Cognition', options: ['Alert and oriented ×4, attention intact', 'Inattentive', 'Disoriented', 'Memory impairment'] },
  { key: 'insight', label: 'Insight', options: ['Good', 'Fair', 'Limited', 'Poor'] },
  { key: 'judgment', label: 'Judgment', options: ['Good', 'Fair', 'Limited', 'Poor'] },
];

export type SuicidalIdeation = 'denied' | 'passive' | 'active-no-plan' | 'active-plan';
export type RiskLevel = 'low' | 'moderate' | 'high';

export interface RiskAssessment {
  suicidalIdeation?: SuicidalIdeation;
  homicidalIdeation?: 'denied' | 'present';
  selfHarm?: 'none' | 'recent';
  level?: RiskLevel;
  safetyPlanReviewed?: boolean;
  notes?: string;
}

export const SI_LABELS: Record<SuicidalIdeation, string> = {
  denied: 'Denies suicidal ideation',
  passive: 'Passive death wish, no intent or plan',
  'active-no-plan': 'Active suicidal ideation without plan',
  'active-plan': 'Active suicidal ideation with plan',
};

export const PSYCHOTHERAPY_MODALITIES = ['Supportive', 'Cognitive behavioral', 'DBT skills', 'Motivational interviewing', 'Psychoeducation', 'Interpersonal', 'Other'];

export type EmMethod = 'mdm' | 'time';
export type MdmLevel = 'straightforward' | 'low' | 'moderate' | 'high';

export interface NoteBilling {
  emMethod: EmMethod;
  mdm?: MdmLevel;
  /** Total provider time on the date of service, minutes (when E/M is selected by time). */
  totalMinutes?: number;
  /** Primary code: 90792 or an established-patient E/M 99212–99215. */
  primaryCode?: string;
  addOnCode?: string;
  pos?: string;
  modifiers: string[];
}

export interface NoteDiagnosis {
  code: string;
  display: string;
  conditionId?: string;
}

/** The structured content of a note. Stored as JSON on the Composition (EXT.noteData). */
export interface NoteData {
  template: TemplateCode;
  sections: Partial<Record<SectionKey, string>>;
  mse: Record<string, string>;
  risk: RiskAssessment;
  psychotherapy?: { minutes?: number; modality?: string; focus?: string };
  diagnoses: NoteDiagnosis[];
  billing: NoteBilling;
  medsReviewed: boolean;
  /** Measures displayed when the draft was saved; part of the signed content. */
  measuresSnapshot?: string;
  /** Active medication text captured for this signed visit; exports never read later chart changes. */
  medicationsSnapshot?: string[];
  /** HIPAA psychotherapy notes: kept separate, never exported or released. */
  privateNotes?: string;
  aiAssisted?: boolean;
}

const EM_BY_MDM: Record<MdmLevel, string> = { straightforward: '99212', low: '99213', moderate: '99214', high: '99215' };

/** Established-patient E/M from total time on the date of service (2021+ CPT time ranges). */
export function emFromTime(minutes: number | undefined): string | undefined {
  if (!minutes || minutes < 10) return undefined;
  if (minutes >= 40) return '99215';
  if (minutes >= 30) return '99214';
  if (minutes >= 20) return '99213';
  return '99212';
}

export function emFromMdm(level: MdmLevel | undefined): string | undefined {
  return level ? EM_BY_MDM[level] : undefined;
}

/** Psychotherapy add-on with E/M, by face-to-face psychotherapy minutes. */
export function addOnFor(minutes: number | undefined): string | undefined {
  if (!minutes || minutes < 16) return undefined;
  if (minutes >= 53) return '90838';
  if (minutes >= 38) return '90836';
  return '90833';
}

const ADD_ON_RANGE: Record<string, [number, number]> = { '90833': [16, 37], '90836': [38, 52], '90838': [53, 999] };

/** Place of service and modifiers from modality and where the patient is. Payer overrides come in Phase 8 (P40). */
export function posAndModifiers(modality: Modality | undefined, patientAtHome = true): { pos: string; modifiers: string[] } {
  if (modality === 'office') return { pos: '11', modifiers: [] };
  if (modality === 'phone') return { pos: patientAtHome ? '10' : '02', modifiers: ['93'] };
  return { pos: patientAtHome ? '10' : '02', modifiers: ['95'] };
}

/** The suggested primary code and its reason, shown in the billing panel. */
export function suggestPrimary(note: Pick<NoteData, 'template' | 'billing' | 'psychotherapy'>): { code?: string; reason: string } {
  const t = findTemplate(note.template);
  if (t?.evaluation) return { code: '90792', reason: 'Psychiatric diagnostic evaluation with medical services' };
  if (note.billing.emMethod === 'time') {
    const code = emFromTime(note.billing.totalMinutes);
    return code ? { code, reason: `${note.billing.totalMinutes} minutes total time on the date of service` } : { reason: 'Enter total time (at least 10 minutes)' };
  }
  const code = emFromMdm(note.billing.mdm);
  return code ? { code, reason: `${note.billing.mdm} medical decision making` } : { reason: 'Choose the level of medical decision making' };
}

export interface SignProblem {
  readonly section?: SectionKey | 'billing' | 'meds';
  readonly message: string;
}

/**
 * Everything that blocks signing. The editor shows these as the pre-sign checklist; the
 * note-rules Bot refuses a final Composition with any of them.
 */
export function signProblems(note: NoteData): SignProblem[] {
  const problems: SignProblem[] = [];
  const t = findTemplate(note.template);
  if (!t) problems.push({ message: 'Unknown note template' });
  if (note.diagnoses.length === 0) problems.push({ section: 'diagnoses', message: 'Add at least one diagnosis' });
  for (const d of note.diagnoses) {
    if (!findDiagnosis(d.code)) problems.push({ section: 'diagnoses', message: `${d.code} is not a billable code in the catalogue` });
  }
  if (t?.sections.includes('risk')) {
    if (!note.risk.suicidalIdeation) problems.push({ section: 'risk', message: 'Document suicidal ideation (including “denies”)' });
    if (!note.risk.level) problems.push({ section: 'risk', message: 'Choose a risk level' });
    if ((note.risk.suicidalIdeation === 'active-no-plan' || note.risk.suicidalIdeation === 'active-plan' || note.risk.level === 'high') && !note.risk.safetyPlanReviewed) {
      problems.push({ section: 'risk', message: 'Active suicidal ideation or high risk requires a reviewed safety plan' });
    }
  }
  if (t?.sections.includes('mse') && Object.values(note.mse).filter((v) => v?.trim()).length < 6) {
    problems.push({ section: 'mse', message: 'Complete the mental status examination (at least 6 domains)' });
  }
  if (!note.sections.assessment?.trim()) problems.push({ section: 'assessment', message: 'Write the assessment' });
  if (!note.sections.plan?.trim()) problems.push({ section: 'plan', message: 'Write the plan' });
  if (!note.medsReviewed) problems.push({ section: 'meds', message: 'Confirm the medication list was reviewed' });

  const b = note.billing;
  if (t && !['telephone', 'crisis'].includes(t.code)) {
    if (!b.primaryCode) problems.push({ section: 'billing', message: 'Choose the visit code' });
    if (t.evaluation && b.primaryCode && b.primaryCode !== '90792') problems.push({ section: 'billing', message: 'A psychiatric evaluation is billed as 90792' });
    if (!t.evaluation && b.primaryCode && !/^9921[2-5]$/.test(b.primaryCode)) problems.push({ section: 'billing', message: 'A follow-up is billed with an E/M code 99212–99215' });
    if (!b.pos) problems.push({ section: 'billing', message: 'Place of service is missing' });
  }
  if (b.addOnCode) {
    const range = ADD_ON_RANGE[b.addOnCode];
    const minutes = note.psychotherapy?.minutes ?? 0;
    if (!b.primaryCode || !/^9921[2-5]$/.test(b.primaryCode)) problems.push({ section: 'billing', message: `${b.addOnCode} is an add-on and needs an E/M visit code (99212–99215)` });
    if (!range || minutes < range[0] || minutes > range[1]) {
      problems.push({ section: 'psychotherapy', message: `${b.addOnCode} needs ${range ? `${range[0]}${range[1] < 999 ? `–${range[1]}` : '+'}` : 'documented'} minutes of psychotherapy; ${minutes} documented` });
    }
    if (b.emMethod === 'time') problems.push({ section: 'billing', message: 'With a psychotherapy add-on, choose the E/M level by medical decision making (time cannot count twice)' });
    if (!note.psychotherapy?.modality) problems.push({ section: 'psychotherapy', message: 'Choose the psychotherapy modality' });
  }
  return problems;
}

/** Signed more than 72 hours after the visit started (P23). */
export function isLateEntry(visitStart: string | undefined, signedAt: string, hours = 72): boolean {
  return !!visitStart && Date.parse(signedAt) - Date.parse(visitStart) > hours * 3600000;
}

export function emptyNote(template: NoteTemplate, modality?: Modality): NoteData {
  const { pos, modifiers } = posAndModifiers(modality);
  return {
    template: template.code,
    sections: { ...template.defaults },
    mse: {},
    risk: {},
    psychotherapy: template.psychotherapy ? {} : undefined,
    diagnoses: [],
    billing: { emMethod: 'mdm', primaryCode: template.evaluation ? '90792' : undefined, pos, modifiers },
    medsReviewed: false,
  };
}

export interface RenderedSection {
  readonly key: SectionKey;
  readonly title: string;
  readonly text: string;
}

/** The note as titled text sections, in template order. Private psychotherapy notes are never included. */
export function renderNote(note: NoteData, extra: { measures?: string } = {}): RenderedSection[] {
  const t = findTemplate(note.template);
  return (t?.sections ?? []).flatMap((key): RenderedSection[] => {
    let text = note.sections[key]?.trim() ?? '';
    if (key === 'mse') {
      text = MSE_DOMAINS.filter((d) => note.mse[d.key]?.trim())
        .map((d) => `${d.label.replace(' (patient’s words)', '')}: ${d.key === 'mood' ? `“${note.mse[d.key].trim()}”` : note.mse[d.key].trim()}`)
        .join('\n');
    }
    if (key === 'risk') {
      const r = note.risk;
      text = [
        r.suicidalIdeation && SI_LABELS[r.suicidalIdeation],
        r.homicidalIdeation && (r.homicidalIdeation === 'denied' ? 'Denies homicidal ideation' : 'Homicidal ideation present'),
        r.selfHarm && (r.selfHarm === 'none' ? 'No recent self-harm' : 'Recent self-harm'),
        r.level && `Overall risk: ${r.level}`,
        r.safetyPlanReviewed ? 'Safety plan reviewed and updated' : undefined,
        r.notes?.trim(),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (key === 'measures' && (extra.measures ?? note.measuresSnapshot)) text = [extra.measures ?? note.measuresSnapshot, text].filter(Boolean).join('\n');
    if (key === 'diagnoses') text = note.diagnoses.map((d) => `${d.code}  ${d.display}`).join('\n');
    if (key === 'psychotherapy' && note.psychotherapy) {
      const p = note.psychotherapy;
      text = [p.minutes ? `${p.minutes} minutes` : undefined, p.modality, p.focus?.trim()].filter(Boolean).join(' · ') + (text ? `\n${text}` : '');
    }
    return text ? [{ key, title: SECTION_LABELS[key], text }] : [];
  });
}

/** One canonical narrative for the editor, signing validator and clinical exports. */
export function noteSections(note: NoteData): NonNullable<Composition['section']> {
  const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  return renderNote(note).map((s) => ({
    title: s.title,
    code: { coding: [{ system: `${CODE_SYSTEMS.noteTemplate}/section`, code: s.key }] },
    text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${escape(s.text).replace(/\n/g, '<br/>')}</div>` },
    ...(s.key === 'diagnoses' ? { entry: note.diagnoses.filter((d) => d.conditionId).map((d) => ({ reference: `Condition/${d.conditionId}`, display: d.display })) } : {}),
  }));
}

/**
 * Plain-language after-visit summary for the patient: plan, follow-up and crisis resources.
 * Excludes the history, MSE, risk details and anything from private psychotherapy notes.
 */
export function afterVisitSummary(note: NoteData, opts: { firstName: string; visitDate: string; provider: string; includeDiagnoses?: boolean }): { heading: string; paragraphs: { title: string; text: string }[] } {
  const paragraphs = [
    { title: 'Your plan', text: note.sections.plan?.trim() ?? '' },
    { title: 'Next visit', text: note.sections.followUp?.trim() ?? '' },
    ...(opts.includeDiagnoses && note.diagnoses.length ? [{ title: 'What we are treating', text: note.diagnoses.map((d) => d.display).join('\n') }] : []),
    {
      title: 'If you need help',
      text: 'Call or text 988 (Suicide & Crisis Lifeline) any time, or call 911 in an emergency. For non-urgent questions, message us in the patient portal.',
    },
  ].filter((p) => p.text);
  return { heading: `Visit summary for ${opts.firstName} · ${opts.visitDate} · ${opts.provider}`, paragraphs };
}
