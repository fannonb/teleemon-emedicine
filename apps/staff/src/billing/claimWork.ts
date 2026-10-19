import type { MedplumClient } from '@medplum/core';
import type { ChargeItem, Claim, ClaimResponse, Coverage, Patient } from '@medplum/fhirtypes';
import type { BillingSettings, ClaimDraft, ClaimStatus, PayerConfig, ScrubContext, ScrubRule } from '@teleemon/core';
import {
  CLEARINGHOUSE_IDENTIFIER_SYSTEM, CPT_SYSTEM, ICD10CM_SYSTEM, REVENUE_EXT, SCRUB_RULES, centsMoney, chargeItemCents, chargeLineOf, chargeQueueTag, claimDraftFromFhir,
  claimStatusOf, claimTransitionProblem, fetchClaimSources, readSettings, zonedDate,
} from '@teleemon/core';
import { CLAIM_TYPE_SYSTEM, CLOSE_REASON_EXT, PLACE_OF_SERVICE_SYSTEM, PROCESS_PRIORITY_SYSTEM, RELATED_CLAIM_SYSTEM, activeCoverageFor, collectEntries, patientsFrom, practitionerNames } from './billingShared';
import { SELF_PAY, codeOf, diagnosesOf, payerName, payerOf, releaseProblems } from './charges';

// P31 claims: reading the work queues, building a claim from released charges, the scrub preview
// and the status moves. The server (bots/src/claim-rules.ts) has the final word on every change;
// the checks here only stop a press that is certain to be refused, and show why.

export type WorkTab = 'ready' | 'draft' | 'scrubbed' | 'submitted' | 'rejected' | 'paid' | 'denied' | 'closed';

export const WORK_TABS: readonly { readonly value: WorkTab; readonly label: string; readonly statuses: readonly ClaimStatus[] }[] = [
  { value: 'ready', label: 'Ready to bill', statuses: [] },
  { value: 'draft', label: 'Draft', statuses: ['draft'] },
  { value: 'scrubbed', label: 'Scrubbed', statuses: ['scrubbed'] },
  { value: 'submitted', label: 'Submitted & accepted', statuses: ['submitted', 'accepted'] },
  { value: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { value: 'paid', label: 'Paid', statuses: ['paid', 'partially-paid'] },
  { value: 'denied', label: 'Denied & appealed', statuses: ['denied', 'appealed'] },
  { value: 'closed', label: 'Closed', statuses: ['closed'] },
];

/** The Claim's visit, from its first line that names one. */
export const visitOf = (c: Claim): string | undefined => c.item?.flatMap((i) => i.encounter ?? []).find((e) => e.reference?.startsWith('Encounter/'))?.reference;

export const clearinghouseIdOf = (c: Claim): string | undefined => c.identifier?.find((i) => i.system === CLEARINGHOUSE_IDENTIFIER_SYSTEM)?.value;

export interface ClaimRow {
  readonly claim: Claim;
  readonly status: ClaimStatus;
  readonly patient?: Patient;
  readonly visit?: string;
}

export interface PlanLine {
  readonly charge: ChargeItem;
  readonly code: string;
  readonly modifiers: readonly string[];
  readonly pointers: readonly number[];
  readonly units: number;
  readonly pos: string;
  readonly cents: number;
}

/** What a claim for one visit would contain, and why it cannot be built yet. */
export interface ClaimPlan {
  readonly problems: readonly string[];
  readonly lines: readonly PlanLine[];
  readonly diagnoses: readonly { readonly code: string; readonly display?: string }[];
  readonly totalCents: number;
  readonly serviceDate?: string;
  readonly payer?: string;
  readonly provider?: string;
  /** The FHIR Claim to create. Present only when there are no problems. */
  readonly claim?: Claim;
}

export interface VisitPlan {
  readonly visit: string;
  readonly patient?: Patient;
  readonly providerName?: string;
  readonly plan: ClaimPlan;
}

export interface ClaimsData {
  readonly settings: BillingSettings;
  readonly claims: readonly ClaimRow[];
  readonly ready: readonly VisitPlan[];
}

export interface PlanInput {
  readonly charges: readonly ChargeItem[];
  readonly patient?: Patient;
  readonly coverage?: Coverage;
  readonly payers: readonly PayerConfig[];
  /** The claim this one replaces (a replacement names it in Claim.related). */
  readonly replaces?: string;
  /** Statuses of the other claims on the visit. */
  readonly otherStatuses: readonly ClaimStatus[];
  readonly now: Date;
}

/**
 * The claim for one visit, built from its released charges. Every problem is collected, so the
 * biller sees them all at once. The diagnosis list is shared by every charge, because the scrubber
 * reads each line's pointers against the claim's own diagnoses.
 */
export function planClaim(input: PlanInput): ClaimPlan {
  const { charges, patient, coverage, payers } = input;
  const problems: string[] = [];
  const add = (p: string): void => {
    if (!problems.includes(p)) problems.push(p);
  };

  if (charges.length === 0) add('There are no billable charges for this visit.');
  const patientRef = charges[0]?.subject?.reference;
  const visit = charges[0]?.context?.reference;
  if (!patient || !patientRef?.startsWith('Patient/')) add('The patient record cannot be read.');
  if (!visit?.startsWith('Encounter/')) add('The charges do not name a visit.');
  if (charges.some((c) => c.subject?.reference !== patientRef)) add('The charges belong to more than one patient.');
  if (charges.some((c) => c.context?.reference !== visit)) add('The charges belong to more than one visit.');
  if (charges.some((c) => c.status !== 'billable' && c.status !== 'billed')) add('Only charges released in charge review can be billed.');

  const payerIds = [...new Set(charges.map(payerOf))];
  const payer = payerIds.length === 1 ? payerIds[0] : undefined;
  if (payerIds.length > 1) add('The charges name different payers. Make them the same in charge review.');
  if (!payer) add('Choose the payer on each charge in charge review.');
  else if (payer === SELF_PAY) add('Self-pay visits are not billed to insurance.');
  else if (!payers.some((p) => p.active && p.id === payer)) add(`The payer ${payerName(payer, payers).text} is not an active payer in billing settings.`);
  if (!coverage) add('No active coverage is on file for this patient.');

  const providerRefs = [...new Set(charges.map((c) => c.performer?.[0]?.actor?.reference))];
  const provider = providerRefs.length === 1 && providerRefs[0]?.startsWith('Practitioner/') ? providerRefs[0] : undefined;
  if (!provider) add('All the charges need the same rendering provider.');

  for (const c of charges) for (const p of releaseProblems(c, payers)) add(p);

  const lines: PlanLine[] = charges.map((c) => {
    const line = chargeLineOf(c);
    return {
      charge: c,
      code: codeOf(c) ?? line?.code ?? '',
      modifiers: line?.modifiers ?? [],
      pointers: line?.diagnosisPointers ?? [],
      units: line?.units ?? 1,
      pos: line?.pos ?? '',
      cents: chargeItemCents(c) ?? 0,
    };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.cents, 0);

  const diagnosisLists = new Set(charges.map((c) => JSON.stringify(diagnosesOf(c).map((d) => d.code))));
  if (diagnosisLists.size > 1) add('The charges list different diagnoses. Correct the note and capture the visit again so every charge shares one diagnosis list.');
  const dx = charges[0] ? diagnosesOf(charges[0]) : [];
  if (dx.length === 0) add('At least one diagnosis is needed.');
  if (dx.length > 12) add('A claim lists at most 12 diagnoses.');
  if (new Set(lines.map((l) => l.pos)).size > 1) add('The charge lines have different places of service.');

  if (input.replaces === undefined && input.otherStatuses.length > 0) {
    add(`This visit already has a live claim (${input.otherStatuses.join(', ')}). Correct that claim, or create a replacement from it.`);
  }
  if (input.replaces !== undefined && input.otherStatuses.some((s) => s === 'draft' || s === 'scrubbed')) {
    add('This visit already has a draft or scrubbed claim. Finish or correct that one first.');
  }

  const times = charges.map((c) => Date.parse(c.occurrenceDateTime ?? '')).filter((t) => Number.isFinite(t));
  if (charges.length > 0 && times.length === 0) add('The charges need a date of service.');
  const serviceDate = times.length > 0 ? zonedDate(new Date(Math.min(...times))) : undefined;

  const partial: ClaimPlan = { problems, lines, diagnoses: dx, totalCents, serviceDate, payer, provider };
  if (problems.length > 0 || !patientRef || !visit || !provider || !payer || !coverage?.id || !serviceDate) return partial;

  const claim: Claim = {
    resourceType: 'Claim',
    status: 'active',
    type: { coding: [{ system: CLAIM_TYPE_SYSTEM, code: 'professional' }] },
    use: 'claim',
    priority: { coding: [{ system: PROCESS_PRIORITY_SYSTEM, code: 'normal' }] },
    patient: { reference: patientRef },
    created: input.now.toISOString(),
    billablePeriod: { start: serviceDate },
    provider: { reference: provider },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
    diagnosis: dx.map((d, i) => ({ sequence: i + 1, diagnosisCodeableConcept: { coding: [{ system: ICD10CM_SYSTEM, code: d.code, display: d.display }] } })),
    item: lines.map((l, i) => ({
      sequence: i + 1,
      encounter: [{ reference: visit }],
      productOrService: { coding: [{ system: CPT_SYSTEM, code: l.code }] },
      modifier: l.modifiers.map((m) => ({ coding: [{ code: m }] })),
      diagnosisSequence: [...l.pointers],
      quantity: { value: l.units },
      unitPrice: centsMoney(l.cents),
      net: centsMoney(l.cents),
      locationCodeableConcept: { coding: [{ system: PLACE_OF_SERVICE_SYSTEM, code: l.pos }] },
      extension: [{ url: REVENUE_EXT.chargeItem, valueReference: { reference: `ChargeItem/${l.charge.id}` } }],
    })),
    total: centsMoney(totalCents),
    related: input.replaces ? [{ relationship: { coding: [{ system: RELATED_CLAIM_SYSTEM, code: 'prior' }] }, claim: { reference: `Claim/${input.replaces}` } }] : undefined,
    extension: [
      { url: REVENUE_EXT.billingPayer, valueString: payer },
      { url: REVENUE_EXT.claimStatus, valueCode: 'draft' },
    ],
  };
  return { ...partial, claim };
}

/** Claims in every work status, and the visits that have billable charges but no claim yet. */
export async function loadClaimsWork(medplum: MedplumClient): Promise<ClaimsData> {
  const now = new Date();
  const [settings, claimEntries, chargeEntries] = await Promise.all([
    readSettings(medplum, 'billing'),
    collectEntries(medplum, 'Claim', [['status', 'active'], ['_include', 'Claim:patient'], ['_sort', '-_lastUpdated'], ['_count', '200']]),
    // ChargeItem has no status search parameter; the charge-rules Bot tags each queue.
    collectEntries(medplum, 'ChargeItem', [['_tag', chargeQueueTag('status-billable')], ['_include', 'ChargeItem:subject'], ['_sort', 'occurrence'], ['_count', '200']]),
  ]);
  const patients = new Map<string, Patient>([...patientsFrom(claimEntries), ...patientsFrom(chargeEntries)]);
  const claims: Claim[] = [];
  for (const e of claimEntries) if (e.resource?.resourceType === 'Claim') claims.push(e.resource);
  const charges: ChargeItem[] = [];
  for (const e of chargeEntries) if (e.resource?.resourceType === 'ChargeItem' && e.search?.mode !== 'include') charges.push(e.resource);

  const rows: ClaimRow[] = claims.map((claim) => ({ claim, status: claimStatusOf(claim), patient: patients.get(claim.patient?.reference ?? ''), visit: visitOf(claim) }));

  // A visit with any claim that is not closed is not "ready": its charges are already on a claim.
  const occupied = new Set(rows.filter((r) => r.visit && r.status !== 'closed').map((r) => r.visit as string));
  const byVisit = new Map<string, ChargeItem[]>();
  for (const c of charges) {
    const v = c.context?.reference;
    if (!v || occupied.has(v)) continue;
    byVisit.set(v, [...(byVisit.get(v) ?? []), c]);
  }
  const patientRefs = [...new Set(charges.flatMap((c) => (c.subject?.reference ? [c.subject.reference] : [])))];
  const [coverage, names] = await Promise.all([
    activeCoverageFor(medplum, patientRefs),
    practitionerNames(medplum, charges.map((c) => c.performer?.[0]?.actor?.reference)),
  ]);
  const ready: VisitPlan[] = [...byVisit].map(([visit, list]) => {
    const patientRef = list[0]?.subject?.reference;
    const providerRef = list[0]?.performer?.[0]?.actor?.reference;
    return {
      visit,
      patient: patientRef ? patients.get(patientRef) : undefined,
      providerName: providerRef ? names.get(providerRef) : undefined,
      plan: planClaim({ charges: list, patient: patientRef ? patients.get(patientRef) : undefined, coverage: patientRef ? coverage.get(patientRef) : undefined, payers: settings.payers, otherStatuses: [], now }),
    };
  });
  return { settings, claims: rows, ready };
}

/**
 * The plan for one visit read fresh: its billable or billed charges, its patient, coverage and the
 * other claims on it. Used for a replacement, and when a ready visit is opened.
 */
export async function loadVisitPlan(medplum: MedplumClient, visit: string, payers: readonly PayerConfig[], replaces?: string): Promise<VisitPlan> {
  const [chargeEntries, claims] = await Promise.all([
    collectEntries(medplum, 'ChargeItem', [['context', visit], ['_include', 'ChargeItem:subject'], ['_count', '200']]),
    medplum.searchResources('Claim', { encounter: visit, status: 'active', _count: '50' }, { cache: 'no-cache' }),
  ]);
  const patients = patientsFrom(chargeEntries);
  const charges = chargeEntries
    .map((e) => e.resource)
    .filter((r): r is ChargeItem => r?.resourceType === 'ChargeItem' && (r.status === 'billable' || r.status === 'billed'));
  const patientRef = charges[0]?.subject?.reference;
  const patient = patientRef ? patients.get(patientRef) : undefined;
  const coverage = patientRef ? (await activeCoverageFor(medplum, [patientRef])).get(patientRef) : undefined;
  const providerRef = charges[0]?.performer?.[0]?.actor?.reference;
  const names = await practitionerNames(medplum, [providerRef]);
  const otherStatuses = claims.filter((c) => c.id !== replaces && claimStatusOf(c) !== 'closed').map((c) => claimStatusOf(c));
  return {
    visit,
    patient,
    providerName: providerRef ? names.get(providerRef) : undefined,
    plan: planClaim({ charges, patient, coverage, payers, replaces, otherStatuses, now: new Date() }),
  };
}

/** One rule's result on a claim, as the scrubber sees it right now. */
export interface RuleResult {
  readonly rule: ScrubRule;
  readonly state: 'pass' | 'error' | 'warning' | 'off';
  readonly message?: string;
}

export interface ScrubPreview {
  readonly draft: ClaimDraft;
  readonly rules: readonly RuleResult[];
}

/** The scrubber run in the browser, with today's date. A preview only: the server re-checks on scrub and submit. */
export async function previewScrub(medplum: MedplumClient, claim: Claim, settings: BillingSettings): Promise<ScrubPreview> {
  const sources = await fetchClaimSources(medplum, claim);
  const draft = claimDraftFromFhir(sources);
  const payer = settings.payers.find((p) => p.id === draft.coverage.payerId);
  const ctx: ScrubContext = { today: zonedDate(new Date()), payer, fees: settings.fees, disabledRules: settings.disabledScrubRules };
  const off = new Set(settings.disabledScrubRules);
  const rules = SCRUB_RULES.map((rule): RuleResult => {
    if (!rule.mandatory && off.has(rule.id)) return { rule, state: 'off' };
    const message = rule.check(draft, ctx);
    return message ? { rule, state: rule.severity, message } : { rule, state: 'pass' };
  });
  return { draft, rules };
}

/**
 * Moves a claim to a new work status, reading it fresh first. The client never writes the scrub
 * result: the server records it on the scrubbed and submitted moves.
 */
export async function moveClaim(medplum: MedplumClient, claimId: string, to: ClaimStatus, change?: (c: Claim) => Claim): Promise<Claim> {
  const current = await medplum.readResource('Claim', claimId, { cache: 'no-cache' });
  const from = claimStatusOf(current);
  const problem = claimTransitionProblem(from, to);
  if (problem) throw new Error(`This claim ${problem}.`);
  const base = change ? change(current) : current;
  const next: Claim = {
    ...base,
    extension: [...(base.extension ?? []).filter((e) => e.url !== REVENUE_EXT.claimStatus), { url: REVENUE_EXT.claimStatus, valueCode: to }],
  };
  return medplum.updateResource(next, { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } });
}

/** Closes a claim with the reason stored on it. Only paid, partially paid, denied or appealed claims may close. */
export function closeClaim(medplum: MedplumClient, claimId: string, reason: string): Promise<Claim> {
  return moveClaim(medplum, claimId, 'closed', (c) => ({
    ...c,
    extension: [...(c.extension ?? []).filter((e) => e.url !== CLOSE_REASON_EXT), { url: CLOSE_REASON_EXT, valueString: reason }],
  }));
}

/** 277CA acknowledgements and each 835 claim payment for one claim, newest first. */
export function claimResponsesFor(medplum: MedplumClient, claimId: string): Promise<ClaimResponse[]> {
  return medplum.searchResources('ClaimResponse', { request: `Claim/${claimId}`, _sort: '-created', _count: '50' }, { cache: 'no-cache' });
}

/** The claim's payer id, as the scrubber and the worker read it. */
export const payerOfClaim = (c: Claim): string | undefined => c.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString;

/** The claim total in whole cents (0 when none is set). */
export const claimTotalCents = (c: Claim): number => (c.total?.value === undefined ? 0 : Math.round(c.total.value * 100));

/** The first eight characters of a claim id, for display. */
export const shortClaimId = (c: Claim): string => (c.id ?? '').slice(0, 8);
