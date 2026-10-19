import type { MedplumClient } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Coverage, CoverageEligibilityRequest, CoverageEligibilityResponse, Patient } from '@medplum/fhirtypes';
import type { EligibilityResult, PayerConfig } from '@teleemon/core';
import { GENERATED_IDENTIFIER_SYSTEM, PRACTICE_TIME_ZONE, REVENUE_EXT, addCalendarDays, eligibilitySummary, searchAll, zonedDate, zonedMidnight } from '@teleemon/core';
import { coverageWithPayer } from './charges';
import { activeCoverageFor, collectEntries, forEachLimited, idOf, patientsFrom } from './billingShared';

// P32 eligibility (270/271): the recent checks and their results, a check for one coverage, and the
// batch for tomorrow's booked patients. The worker answers each request; this page only asks and reads.

export const ELIGIBILITY_RESULT_EXT = REVENUE_EXT.eligibilityResult;
/** Requests from the batch carry this identifier prefix, so the worker's daily queue and this batch never duplicate. */
export const DAILY_PREFIX = 'eligibility-daily:';
const LOOKBACK_DAYS = 14;

export type EligibilityStatus = 'active' | 'inactive' | 'check' | 'pending';

export interface EligibilityRow {
  readonly request: CoverageEligibilityRequest;
  readonly response?: CoverageEligibilityResponse;
  readonly result?: EligibilityResult;
  readonly status: EligibilityStatus;
  /** Staff-readable lines (plan, copay, deductible, MH, telehealth, errors). */
  readonly lines: readonly string[];
  readonly patient?: Patient;
  readonly coverage?: Coverage;
  readonly source: 'tomorrow' | 'manual';
  readonly insurer?: string;
}

/** The result stored by the worker on the CoverageEligibilityResponse; undefined until it has one. */
export function resultOf(r: CoverageEligibilityResponse | undefined): EligibilityResult | undefined {
  const json = r?.extension?.find((e) => e.url === ELIGIBILITY_RESULT_EXT)?.valueString;
  if (!json) return undefined;
  try {
    return JSON.parse(json) as EligibilityResult;
  } catch {
    return undefined;
  }
}

/** The recent requests, each with its response and coverage, newest first. */
export async function loadEligibility(medplum: MedplumClient): Promise<EligibilityRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const entries = await collectEntries(medplum, 'CoverageEligibilityRequest', [['created', `ge${since}`], ['_include', 'CoverageEligibilityRequest:patient'], ['_sort', '-created'], ['_count', '200']]);
  const patients = patientsFrom(entries);
  const requests: CoverageEligibilityRequest[] = [];
  for (const e of entries) {
    if (e.resource?.resourceType === 'CoverageEligibilityRequest' && e.search?.mode !== 'include') requests.push(e.resource);
  }
  if (requests.length === 0) return [];

  const requestRefs = requests.map((r) => `CoverageEligibilityRequest/${r.id}`);
  const responses: CoverageEligibilityResponse[] = [];
  for (let i = 0; i < requestRefs.length; i += 40) {
    responses.push(...(await medplum.searchResources('CoverageEligibilityResponse', { request: requestRefs.slice(i, i + 40).join(','), _count: '200' }, { cache: 'no-cache' })));
  }
  const responseFor = new Map<string, CoverageEligibilityResponse>();
  for (const r of responses) {
    const ref = r.request?.reference;
    if (ref && !responseFor.has(ref)) responseFor.set(ref, r);
  }

  const coverageIds = [...new Set(requests.map((r) => idOf(r.insurance?.[0]?.coverage?.reference)).filter((x): x is string => x !== undefined))];
  const coverages = new Map<string, Coverage>();
  for (let i = 0; i < coverageIds.length; i += 40) {
    const found = await medplum.searchResources('Coverage', { _id: coverageIds.slice(i, i + 40).join(','), _count: '40' }, { cache: 'no-cache' });
    for (const c of found) coverages.set(`Coverage/${c.id}`, c);
  }

  return requests.map((request): EligibilityRow => {
    const response = responseFor.get(`CoverageEligibilityRequest/${request.id}`);
    const result = resultOf(response);
    const coverageRef = request.insurance?.[0]?.coverage?.reference;
    const coverage = coverageRef ? coverages.get(coverageRef) : undefined;
    const patientRef = request.patient?.reference;
    const source = request.identifier?.some((i) => i.value?.startsWith(DAILY_PREFIX)) ? 'tomorrow' : 'manual';
    const { status, lines } = eligibilityState(response);
    return {
      request,
      response,
      result,
      status,
      lines,
      patient: patientRef ? patients.get(patientRef) : undefined,
      coverage,
      source,
      insurer: request.insurer?.display,
    };
  });
}

/** Status and readable lines for one request and its response (shared by P32, the chart and the calendar). */
export function eligibilityState(response: CoverageEligibilityResponse | undefined): { status: EligibilityStatus; lines: string[] } {
  const result = resultOf(response);
  if (response && result) return eligibilitySummary(result);
  if (response) return { status: 'check', lines: ['The response has no result. Check it again.'] };
  return { status: 'pending', lines: ['Waiting for the payer. Results usually arrive within a minute.'] };
}

/** The latest eligibility check for one coverage, with its status; undefined when never checked. */
export async function latestEligibility(medplum: MedplumClient, coverage: Coverage): Promise<{ checkedAt?: string; status: EligibilityStatus; lines: string[] } | undefined> {
  const requests = await medplum.searchResources('CoverageEligibilityRequest', { patient: coverage.beneficiary?.reference ?? '', _sort: '-created', _count: '20' }, { cache: 'no-cache' });
  const request = requests.find((r) => r.insurance?.some((i) => i.coverage?.reference === `Coverage/${coverage.id}`));
  if (!request) return undefined;
  const response = await medplum.searchOne('CoverageEligibilityResponse', { request: `CoverageEligibilityRequest/${request.id}` }, { cache: 'no-cache' });
  return { checkedAt: response?.created ?? request.created, ...eligibilityState(response ?? undefined) };
}

/** One eligibility check for a coverage, requested now. The worker answers it. */
export function checkNow(medplum: MedplumClient, patient: Patient, coverage: Coverage, insurer: string): Promise<CoverageEligibilityRequest> {
  const profile = medplum.getProfile();
  const request: CoverageEligibilityRequest = {
    resourceType: 'CoverageEligibilityRequest',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: `eligibility-manual:${crypto.randomUUID()}` }],
    status: 'active',
    purpose: ['benefits'],
    patient: createReference(patient),
    created: new Date().toISOString(),
    provider: profile?.resourceType === 'Practitioner' ? createReference(profile) : undefined,
    insurer: { display: insurer },
    insurance: [{ focal: true, coverage: createReference(coverage) }],
  };
  return medplum.createResource(request);
}

export interface TomorrowBatch {
  readonly patients: number;
  readonly requested: number;
  readonly checkedRecently: number;
  readonly noCoverage: number;
}

/**
 * A check for each patient booked in the practice's tomorrow who has active coverage and no
 * request in the last 24 hours. The identifier is per patient and day, so running it twice is safe.
 */
export async function checkTomorrowsVisits(medplum: MedplumClient, now = new Date()): Promise<TomorrowBatch> {
  const today = zonedDate(now, PRACTICE_TIME_ZONE);
  const tomorrow = addCalendarDays(today, 1);
  const start = zonedMidnight(tomorrow, PRACTICE_TIME_ZONE).toISOString();
  const end = zonedMidnight(addCalendarDays(today, 2), PRACTICE_TIME_ZONE).toISOString();
  const appointments = await searchAll(medplum, 'Appointment', [['date', `ge${start}`], ['date', `lt${end}`], ['status', 'booked,pending'], ['_count', '200']]);
  const patientRefs = [
    ...new Set(
      appointments.flatMap((a) => (a.participant ?? []).map((p) => p.actor?.reference).filter((r): r is string => !!r?.startsWith('Patient/')))
    ),
  ];
  const coverage = await activeCoverageFor(medplum, patientRefs);
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  let requested = 0;
  let checkedRecently = 0;
  let noCoverage = 0;
  await forEachLimited(patientRefs, 4, async (ref) => {
    const cov = coverage.get(ref);
    if (!cov) {
      noCoverage += 1;
      return;
    }
    const recent = await medplum.searchOne('CoverageEligibilityRequest', { patient: ref, created: `ge${since}` }, { cache: 'no-cache' });
    if (recent) {
      checkedRecently += 1;
      return;
    }
    const value = `${DAILY_PREFIX}${idOf(ref)}:${tomorrow}`;
    const request: CoverageEligibilityRequest = {
      resourceType: 'CoverageEligibilityRequest',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value }],
      status: 'active',
      purpose: ['benefits'],
      patient: { reference: ref },
      created: now.toISOString(),
      servicedDate: tomorrow,
      insurer: { display: cov.payor?.[0]?.display ?? 'Payer' },
      insurance: [{ focal: true, coverage: createReference(cov) }],
    };
    await medplum.createResourceIfNoneExist(request, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${value}` }).toString());
    requested += 1;
  });
  return { patients: patientRefs.length, requested, checkedRecently, noCoverage };
}

/** Points a coverage at a configured payer (the same write P30 uses), with the version lock. */
export function linkCoveragePayer(medplum: MedplumClient, cov: Coverage, payer: PayerConfig): Promise<Coverage> {
  return medplum.updateResource(coverageWithPayer(cov, payer), { headers: { 'If-Match': `W/"${cov.meta?.versionId}"` } });
}
