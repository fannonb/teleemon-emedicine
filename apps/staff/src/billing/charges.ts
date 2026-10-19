import type { MedplumClient } from '@medplum/core';
import type { BundleEntry, ChargeItem, Coverage, Extension, Patient } from '@medplum/fhirtypes';
import type { ChargeLine, PayerConfig } from '@teleemon/core';
import { PAYER_IDENTIFIER_SYSTEM, REVENUE_EXT, centsMoney, chargeItemCents, chargeLineOf, chargeQueueTag } from '@teleemon/core';
import { patientName } from '../fhir/patient';
import { activeCoverageFor, practitionerNames } from './billingShared';

// Charge review (P30) data: the queue, the release checks the server also runs, and the edits.
// The server (bots/src/charge-rules.ts) has the final word on every change; the checks here only
// stop a biller from pressing a button that is certain to be refused, and say why.

export type ChargeTab = 'planned' | 'billable' | 'not-billable' | 'entered-in-error';

export const CHARGE_TABS: readonly { value: ChargeTab; label: string }[] = [
  { value: 'planned', label: 'To review' },
  { value: 'billable', label: 'Billable' },
  { value: 'not-billable', label: 'Not billable' },
  { value: 'entered-in-error', label: 'Entered in error' },
];

export const SELF_PAY = 'self-pay';
/** Modifiers a biller can choose here; telehealth ones follow the payer (P40). */
export const MODIFIER_OPTIONS: readonly string[] = ['95', '93', 'GT', 'FQ'];

export interface ChargeRow {
  readonly charge: ChargeItem;
  readonly patient?: Patient;
  /** Rendering provider, as a display name. */
  readonly provider?: string;
  /** The patient's active coverage, when one exists. */
  readonly coverage?: Coverage;
}

const ext = (c: { extension?: Extension[] }, url: string): string | undefined => c.extension?.find((e) => e.url === url)?.valueString;

export const payerOf = (charge: ChargeItem): string | undefined => ext(charge, REVENUE_EXT.billingPayer);
export const holdReasonOf = (charge: ChargeItem): string | undefined => ext(charge, REVENUE_EXT.holdReason);
export const codeOf = (charge: ChargeItem): string | undefined => charge.code?.coding?.[0]?.code;
export const isPosted = (charge: ChargeItem): boolean => ext(charge, REVENUE_EXT.ledgerJournal) !== undefined;

/** The diagnoses on the charge, in order. Pointer 1 is the first, shown as letter A. */
export function diagnosesOf(charge: ChargeItem): { letter: string; code: string; display?: string }[] {
  return (charge.reason ?? []).map((r, i) => ({
    letter: String.fromCharCode(65 + i),
    code: r.coding?.[0]?.code ?? '?',
    display: r.coding?.[0]?.display,
  }));
}

export function payerName(id: string | undefined, payers: readonly PayerConfig[]): { text: string; known: boolean } {
  if (!id) return { text: 'No payer chosen', known: false };
  if (id === SELF_PAY) return { text: 'Self-pay', known: true };
  const p = payers.find((x) => x.id === id);
  return p ? { text: p.name, known: p.active } : { text: 'Payer not in settings', known: false };
}

/** Why the charge cannot be released yet. Empty when the server should accept the release. */
export function releaseProblems(charge: ChargeItem, payers: readonly PayerConfig[]): string[] {
  const out: string[] = [];
  const line = chargeLineOf(charge);
  const payer = payerOf(charge);
  const cents = chargeItemCents(charge);
  const code = codeOf(charge);
  if (!line) out.push('The charge line cannot be read, so the charge cannot be released.');
  if (!payer) out.push('Choose the payer, or self-pay, before releasing.');
  else if (payer !== SELF_PAY && !payers.some((p) => p.active && p.id === payer)) out.push('The payer is not an active payer in billing settings.');
  if (cents === undefined || cents <= 0) out.push('The amount must be more than $0.00.');
  if (!charge.reason?.length) out.push('At least one diagnosis is needed.');
  if (!code) out.push('The charge has no procedure code.');
  if (line && code && code !== line.code) out.push('The procedure code and the charge line disagree.');
  if (line && cents !== undefined && line.chargeCents !== cents) out.push('The amount and the charge line disagree.');
  if (line && line.diagnosisPointers.some((p) => p < 1 || p > (charge.reason?.length ?? 0))) out.push('A diagnosis pointer points to no diagnosis.');
  if (line?.aiSuggested && !line.providerAccepted) out.push(`${line.code} was suggested by AI. Only the provider who signed the note can accept it.`);
  if (!charge.performer?.[0]?.actor?.reference?.startsWith('Practitioner/')) out.push('The rendering provider is not recorded.');
  return out;
}

/** The AI-suggested code the provider has not accepted: a red flag in the queue. */
export function aiUnaccepted(charge: ChargeItem): ChargeLine | undefined {
  const line = chargeLineOf(charge);
  return line?.aiSuggested && !line.providerAccepted ? line : undefined;
}

function withExtension(list: readonly Extension[], url: string, valueString: string | undefined): Extension[] {
  const rest = list.filter((e) => e.url !== url);
  return valueString === undefined ? rest : [...rest, { url, valueString }];
}

export interface ChargeEdits {
  readonly modifiers: readonly string[];
  readonly pointers: readonly number[];
  readonly cents: number;
  /** Payer id, or 'self-pay'. Undefined keeps the current payer. */
  readonly payer?: string;
  /** Status to move to. Undefined keeps the current status. */
  readonly status?: ChargeItem['status'];
  /** Hold or error reason. Undefined keeps the current reason; null clears it. */
  readonly holdReason?: string | null;
}

/** The charge with the edits applied, keeping ChargeLine and priceOverride in step. */
export function editedCharge(charge: ChargeItem, e: ChargeEdits): ChargeItem {
  const line = chargeLineOf(charge);
  let extension: Extension[] = [...(charge.extension ?? [])];
  if (line) extension = withExtension(extension, REVENUE_EXT.chargeLine, JSON.stringify({ ...line, modifiers: [...e.modifiers], diagnosisPointers: [...e.pointers], chargeCents: e.cents }));
  if (e.payer !== undefined) extension = withExtension(extension, REVENUE_EXT.billingPayer, e.payer);
  if (e.holdReason !== undefined) extension = withExtension(extension, REVENUE_EXT.holdReason, e.holdReason ?? undefined);
  return { ...charge, status: e.status ?? charge.status, priceOverride: centsMoney(e.cents), extension };
}

/** Writes the charge if nobody has changed it since it was read (If-Match on the version). */
export function saveCharge(medplum: MedplumClient, original: ChargeItem, next: ChargeItem): Promise<ChargeItem> {
  return medplum.updateResource(next, { headers: { 'If-Match': `W/"${original.meta?.versionId}"` } });
}

/**
 * Points the plan at a configured payer. Writes Coverage.payor[0].identifier when that entry is
 * free; otherwise adds a payor entry, so an existing identifier is never overwritten.
 */
export function coverageWithPayer(cov: Coverage, payer: PayerConfig): Coverage {
  const identifier = { system: PAYER_IDENTIFIER_SYSTEM, value: payer.id };
  const payors = (cov.payor ?? []).filter((p) => p.identifier?.system !== PAYER_IDENTIFIER_SYSTEM);
  const first = payors[0];
  if (first && !first.identifier) return { ...cov, payor: [{ ...first, identifier }, ...payors.slice(1)] };
  return { ...cov, payor: [...payors, { display: payer.name, identifier }] };
}

/** The payer a plan has been linked to, when a biller has done so. */
export const linkedPayerOf = (cov: Coverage | undefined): string | undefined => cov?.payor?.find((p) => p.identifier?.system === PAYER_IDENTIFIER_SYSTEM)?.identifier?.value;

export const planNameOf = (cov: Coverage | undefined): string | undefined => cov?.payor?.[0]?.display ?? undefined;

/** The queue for one status, oldest service date first while reviewing. */
export async function loadCharges(medplum: MedplumClient, status: ChargeTab): Promise<ChargeRow[]> {
  const entries: BundleEntry[] = [];
  for await (const page of medplum.searchResourcePages(
    'ChargeItem',
    new URLSearchParams([
      // R4 ChargeItem has no status search parameter; charge-rules keeps a queue tag instead.
      ['_tag', chargeQueueTag(`status-${status}`)],
      ['_include', 'ChargeItem:subject'],
      ['_sort', status === 'planned' ? 'occurrence' : '-_lastUpdated'],
      ['_count', '200'],
    ]),
    { cache: 'no-cache' }
  )) {
    entries.push(...(page.bundle.entry ?? []));
  }
  const charges: ChargeItem[] = [];
  const patients = new Map<string, Patient>();
  for (const e of entries) {
    const r = e.resource;
    if (!r) continue;
    if (r.resourceType === 'ChargeItem' && e.search?.mode !== 'include') charges.push(r);
    else if (r.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
  }
  const patientRefs = [...new Set(charges.flatMap((c) => (c.subject?.reference ? [c.subject.reference] : [])))];
  const providerRefs = [...new Set(charges.flatMap((c) => (c.performer?.[0]?.actor?.reference ? [c.performer[0].actor.reference] : [])))];
  const [coverage, providers] = await Promise.all([activeCoverageFor(medplum, patientRefs), practitionerNames(medplum, providerRefs)]);
  return charges.map((charge) => {
    const subject = charge.subject?.reference;
    const actor = charge.performer?.[0]?.actor?.reference;
    return {
      charge,
      patient: subject ? patients.get(subject) : undefined,
      provider: actor ? providers.get(actor) : undefined,
      coverage: subject ? coverage.get(subject) : undefined,
    };
  });
}

export const rowPatientName = (row: ChargeRow): string => (row.patient ? patientName(row.patient) : 'Unknown patient');

/** The charge's id; queue rows always come from a stored charge, so the empty fallback never shows. */
export const chargeId = (charge: ChargeItem): string => charge.id ?? '';

/** The charge moved to another status, with its hold reason set or cleared. Nothing else changes. */
export function withStatus(charge: ChargeItem, status: ChargeItem['status'], holdReason: string | null): ChargeItem {
  return { ...charge, status, extension: withExtension(charge.extension ?? [], REVENUE_EXT.holdReason, holdReason ?? undefined) };
}
