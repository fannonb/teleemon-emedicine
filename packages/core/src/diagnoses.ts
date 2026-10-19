// Psychiatric diagnosis catalogue: DSM-5-TR names mapped to billable ICD-10-CM codes (P13).
// Phase 1 validates diagnoses against this curated list. Phase 8 (P40) replaces it with the
// full, versioned CMS ICD-10-CM release; until then every code here must be checked against the
// current fiscal-year release before go-live.

export interface DiagnosisEntry {
  readonly code: string;
  readonly display: string;
  readonly group: string;
}

export const DIAGNOSES: readonly DiagnosisEntry[] = [
  // Depressive disorders
  { code: 'F32.0', display: 'Major depressive disorder, single episode, mild', group: 'Depressive' },
  { code: 'F32.1', display: 'Major depressive disorder, single episode, moderate', group: 'Depressive' },
  { code: 'F32.2', display: 'Major depressive disorder, single episode, severe without psychotic features', group: 'Depressive' },
  { code: 'F32.3', display: 'Major depressive disorder, single episode, severe with psychotic features', group: 'Depressive' },
  { code: 'F32.4', display: 'Major depressive disorder, single episode, in partial remission', group: 'Depressive' },
  { code: 'F32.5', display: 'Major depressive disorder, single episode, in full remission', group: 'Depressive' },
  { code: 'F32.9', display: 'Major depressive disorder, single episode, unspecified', group: 'Depressive' },
  { code: 'F32.A', display: 'Depression, unspecified', group: 'Depressive' },
  { code: 'F32.81', display: 'Premenstrual dysphoric disorder', group: 'Depressive' },
  { code: 'F33.0', display: 'Major depressive disorder, recurrent, mild', group: 'Depressive' },
  { code: 'F33.1', display: 'Major depressive disorder, recurrent, moderate', group: 'Depressive' },
  { code: 'F33.2', display: 'Major depressive disorder, recurrent, severe without psychotic features', group: 'Depressive' },
  { code: 'F33.3', display: 'Major depressive disorder, recurrent, severe with psychotic features', group: 'Depressive' },
  { code: 'F33.41', display: 'Major depressive disorder, recurrent, in partial remission', group: 'Depressive' },
  { code: 'F33.42', display: 'Major depressive disorder, recurrent, in full remission', group: 'Depressive' },
  { code: 'F33.9', display: 'Major depressive disorder, recurrent, unspecified', group: 'Depressive' },
  { code: 'F34.1', display: 'Persistent depressive disorder (dysthymia)', group: 'Depressive' },
  // Bipolar and related
  { code: 'F31.0', display: 'Bipolar I disorder, current episode hypomanic', group: 'Bipolar' },
  { code: 'F31.11', display: 'Bipolar I disorder, current episode manic, mild', group: 'Bipolar' },
  { code: 'F31.12', display: 'Bipolar I disorder, current episode manic, moderate', group: 'Bipolar' },
  { code: 'F31.13', display: 'Bipolar I disorder, current episode manic, severe', group: 'Bipolar' },
  { code: 'F31.2', display: 'Bipolar I disorder, current episode manic, with psychotic features', group: 'Bipolar' },
  { code: 'F31.31', display: 'Bipolar I disorder, current episode depressed, mild', group: 'Bipolar' },
  { code: 'F31.32', display: 'Bipolar I disorder, current episode depressed, moderate', group: 'Bipolar' },
  { code: 'F31.4', display: 'Bipolar I disorder, current episode depressed, severe', group: 'Bipolar' },
  { code: 'F31.5', display: 'Bipolar I disorder, current episode depressed, with psychotic features', group: 'Bipolar' },
  { code: 'F31.81', display: 'Bipolar II disorder', group: 'Bipolar' },
  { code: 'F31.9', display: 'Bipolar disorder, unspecified', group: 'Bipolar' },
  { code: 'F34.0', display: 'Cyclothymic disorder', group: 'Bipolar' },
  // Anxiety
  { code: 'F41.1', display: 'Generalized anxiety disorder', group: 'Anxiety' },
  { code: 'F41.0', display: 'Panic disorder', group: 'Anxiety' },
  { code: 'F40.10', display: 'Social anxiety disorder', group: 'Anxiety' },
  { code: 'F40.00', display: 'Agoraphobia', group: 'Anxiety' },
  { code: 'F41.8', display: 'Other specified anxiety disorder', group: 'Anxiety' },
  { code: 'F41.9', display: 'Unspecified anxiety disorder', group: 'Anxiety' },
  // Obsessive-compulsive
  { code: 'F42.2', display: 'Obsessive-compulsive disorder', group: 'Obsessive-compulsive' },
  // Trauma and stressor-related
  { code: 'F43.10', display: 'Posttraumatic stress disorder', group: 'Trauma' },
  { code: 'F43.20', display: 'Adjustment disorder, unspecified', group: 'Trauma' },
  { code: 'F43.21', display: 'Adjustment disorder with depressed mood', group: 'Trauma' },
  { code: 'F43.22', display: 'Adjustment disorder with anxiety', group: 'Trauma' },
  { code: 'F43.23', display: 'Adjustment disorder with mixed anxiety and depressed mood', group: 'Trauma' },
  // Neurodevelopmental
  { code: 'F90.0', display: 'ADHD, predominantly inattentive presentation', group: 'Neurodevelopmental' },
  { code: 'F90.1', display: 'ADHD, predominantly hyperactive/impulsive presentation', group: 'Neurodevelopmental' },
  { code: 'F90.2', display: 'ADHD, combined presentation', group: 'Neurodevelopmental' },
  { code: 'F90.8', display: 'Other specified ADHD', group: 'Neurodevelopmental' },
  { code: 'F90.9', display: 'Unspecified ADHD', group: 'Neurodevelopmental' },
  { code: 'F84.0', display: 'Autism spectrum disorder', group: 'Neurodevelopmental' },
  // Psychotic
  { code: 'F20.9', display: 'Schizophrenia', group: 'Psychotic' },
  { code: 'F25.0', display: 'Schizoaffective disorder, bipolar type', group: 'Psychotic' },
  { code: 'F25.1', display: 'Schizoaffective disorder, depressive type', group: 'Psychotic' },
  { code: 'F22', display: 'Delusional disorder', group: 'Psychotic' },
  { code: 'F23', display: 'Brief psychotic disorder', group: 'Psychotic' },
  { code: 'F29', display: 'Unspecified schizophrenia spectrum and other psychotic disorder', group: 'Psychotic' },
  // Substance-related (subject to 42 CFR Part 2 labelling once decision D2 is made)
  { code: 'F10.10', display: 'Alcohol use disorder, mild', group: 'Substance use' },
  { code: 'F10.20', display: 'Alcohol use disorder, moderate or severe', group: 'Substance use' },
  { code: 'F10.21', display: 'Alcohol use disorder, moderate or severe, in remission', group: 'Substance use' },
  { code: 'F11.10', display: 'Opioid use disorder, mild', group: 'Substance use' },
  { code: 'F11.20', display: 'Opioid use disorder, moderate or severe', group: 'Substance use' },
  { code: 'F11.21', display: 'Opioid use disorder, moderate or severe, in remission', group: 'Substance use' },
  { code: 'F12.10', display: 'Cannabis use disorder, mild', group: 'Substance use' },
  { code: 'F12.20', display: 'Cannabis use disorder, moderate or severe', group: 'Substance use' },
  { code: 'F14.10', display: 'Cocaine use disorder, mild', group: 'Substance use' },
  { code: 'F14.20', display: 'Cocaine use disorder, moderate or severe', group: 'Substance use' },
  { code: 'F15.10', display: 'Amphetamine-type substance use disorder, mild', group: 'Substance use' },
  { code: 'F15.20', display: 'Amphetamine-type substance use disorder, moderate or severe', group: 'Substance use' },
  { code: 'F17.210', display: 'Tobacco use disorder, cigarettes', group: 'Substance use' },
  // Other
  { code: 'F51.01', display: 'Insomnia disorder', group: 'Other' },
  { code: 'F60.3', display: 'Borderline personality disorder', group: 'Other' },
];

export function findDiagnosis(code: string | undefined): DiagnosisEntry | undefined {
  return DIAGNOSES.find((d) => d.code === code);
}

export function isSubstanceUseCode(code: string | undefined): boolean {
  return !!code && /^F1[0-9]\./.test(code) && code !== 'F17.210';
}

export function searchDiagnoses(query: string, limit = 20): DiagnosisEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return DIAGNOSES.slice(0, limit);
  return DIAGNOSES.filter((d) => d.code.toLowerCase().startsWith(q) || d.display.toLowerCase().includes(q)).slice(0, limit);
}
