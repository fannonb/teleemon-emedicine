// Common psychiatric medications with their DEA schedule and monitoring needs (P14).
// Patient-reported and historical medications are recorded against this list; prescriptions
// come from the e-prescribing vendor in Phase 5, which supplies RxNorm codes.

export type Schedule = '2' | '3' | '4' | '5';

export interface MonitoringRule {
  readonly key: 'lithium' | 'valproate' | 'clozapine' | 'antipsychotic-metabolic';
  readonly label: string;
  readonly everyDays: number;
}

export interface MedicationEntry {
  readonly name: string;
  readonly schedule?: Schedule;
  /** Narcotic controlled substance (DEA schedules 2/3 vs non-narcotic 2N/3N). */
  readonly narcotic?: boolean;
  readonly monitoring?: MonitoringRule;
}

const LITHIUM: MonitoringRule = { key: 'lithium', label: 'Lithium level, renal and thyroid function', everyDays: 120 };
const VALPROATE: MonitoringRule = { key: 'valproate', label: 'Valproate level, LFTs and CBC', everyDays: 180 };
const CLOZAPINE: MonitoringRule = { key: 'clozapine', label: 'CBC with ANC (per REMS schedule)', everyDays: 30 };
const METABOLIC: MonitoringRule = { key: 'antipsychotic-metabolic', label: 'Metabolic panel: A1c, lipids, weight', everyDays: 365 };

export const MEDICATIONS: readonly MedicationEntry[] = [
  // Stimulants and ADHD
  { name: 'Amphetamine/dextroamphetamine', schedule: '2' },
  { name: 'Lisdexamfetamine', schedule: '2' },
  { name: 'Methylphenidate', schedule: '2' },
  { name: 'Dexmethylphenidate', schedule: '2' },
  { name: 'Atomoxetine' },
  { name: 'Guanfacine ER' },
  { name: 'Viloxazine ER' },
  // Opioid use disorder
  { name: 'Buprenorphine/naloxone', schedule: '3', narcotic: true },
  { name: 'Buprenorphine', schedule: '3', narcotic: true },
  { name: 'Naltrexone' },
  // Benzodiazepines and hypnotics
  { name: 'Alprazolam', schedule: '4' },
  { name: 'Clonazepam', schedule: '4' },
  { name: 'Lorazepam', schedule: '4' },
  { name: 'Diazepam', schedule: '4' },
  { name: 'Zolpidem', schedule: '4' },
  { name: 'Modafinil', schedule: '4' },
  // Mood stabilizers
  { name: 'Lithium carbonate', monitoring: LITHIUM },
  { name: 'Divalproex sodium', monitoring: VALPROATE },
  { name: 'Lamotrigine' },
  // Antipsychotics
  { name: 'Clozapine', monitoring: CLOZAPINE },
  { name: 'Aripiprazole', monitoring: METABOLIC },
  { name: 'Quetiapine', monitoring: METABOLIC },
  { name: 'Olanzapine', monitoring: METABOLIC },
  { name: 'Risperidone', monitoring: METABOLIC },
  { name: 'Lurasidone', monitoring: METABOLIC },
  { name: 'Cariprazine', monitoring: METABOLIC },
  { name: 'Ziprasidone', monitoring: METABOLIC },
  // Antidepressants and anxiolytics
  { name: 'Sertraline' },
  { name: 'Fluoxetine' },
  { name: 'Escitalopram' },
  { name: 'Citalopram' },
  { name: 'Paroxetine' },
  { name: 'Venlafaxine XR' },
  { name: 'Duloxetine' },
  { name: 'Bupropion XL' },
  { name: 'Mirtazapine' },
  { name: 'Trazodone' },
  { name: 'Buspirone' },
  { name: 'Hydroxyzine' },
  { name: 'Prazosin' },
];

export function findMedication(name: string | undefined): MedicationEntry | undefined {
  const n = (name ?? '').trim().toLowerCase();
  return MEDICATIONS.find((m) => m.name.toLowerCase() === n);
}

export const SCHEDULE_LABEL: Record<Schedule, string> = { '2': 'C-II', '3': 'C-III', '4': 'C-IV', '5': 'C-V' };
