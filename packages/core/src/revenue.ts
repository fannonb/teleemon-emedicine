// How the revenue cycle is recorded in FHIR (Phase 8). The ledger holds the money; these
// resources hold the billing documents and the work queues. Shared by the staff app, the Bots and
// the worker so all three agree on statuses and extensions.
//
// ChargeItem: one per billed code, created by the charge-capture Bot when a note is signed.
//   status 'planned'        captured, waiting for charge review (P30)
//          'billable'       reviewed; the worker posts the ledger charge (EXT.ledgerJournal records it)
//          'billed'         on a submitted claim
//          'not-billable'   held or voided by a biller, with EXT.holdReason
//          'entered-in-error'
//   EXT.chargeLine (JSON ChargeLine) carries modifiers, pointers, POS and the AI flags;
//   priceOverride is the amount; EXT.billingPayer the payer id ('self-pay' when none).
// Claim (837P): built in P31 from billable ChargeItems of one visit. Claim.status stays FHIR's
//   ('draft' | 'active' | 'cancelled' | 'entered-in-error'); the work status is EXT.claimStatus
//   (ClaimStatus). EXT.scrubResult is the latest scrub, tied to claimContentHash() of the claim
//   it checked. Each item names its ChargeItem with EXT.chargeItem. The clearinghouse id is an
//   identifier under CLEARINGHOUSE_IDENTIFIER_SYSTEM.
// ClaimResponse: 277CA acknowledgements and each 835 claim payment, linked to the Claim.
// PaymentReconciliation: one per 835 (identifier = trace number), with a detail per claim.
// CoverageEligibilityRequest / Response: 270/271 checks (P32).
// Invoice: one per patient statement (P35), status 'issued'; the PDF is a billing DocumentReference.
// Task (team 'biller'): the work queues below, all closed with a reason like every inbox item.

import type { ChargeItem, Claim, Coverage } from '@medplum/fhirtypes';
import type { ChargeLine, ClaimStatus, PayerConfig } from './billing';
import { EXT, GENERATED_IDENTIFIER_SYSTEM, TELEEMON_BASE } from './fhir';
import { stableJson } from './portal';

export const REVENUE_EXT = {
  /** valueString: JSON ChargeLine. On ChargeItem. */
  chargeLine: `${TELEEMON_BASE}/StructureDefinition/charge-line`,
  /** valueString: payer id from billing settings, or 'self-pay'. On ChargeItem and Claim. */
  billingPayer: `${TELEEMON_BASE}/StructureDefinition/billing-payer`,
  /** valueString: why a charge is held or not billed. On ChargeItem. */
  holdReason: `${TELEEMON_BASE}/StructureDefinition/hold-reason`,
  /** valueString: idempotency key of the ledger journal posted for this resource. */
  ledgerJournal: `${TELEEMON_BASE}/StructureDefinition/ledger-journal`,
  /** valueString: idempotency key of the reversal posted when a posted charge was entered in error. */
  ledgerReversal: `${TELEEMON_BASE}/StructureDefinition/ledger-reversal`,
  /** valueString: JSON EligibilityResult. On CoverageEligibilityResponse. */
  eligibilityResult: `${TELEEMON_BASE}/StructureDefinition/eligibility-result`,
  /** valueReference(ChargeItem). On Claim.item. */
  chargeItem: `${TELEEMON_BASE}/StructureDefinition/charge-item`,
  /** valueString: JSON { at, hash, findings }. On Claim. Same URL as EXT.scrubResult. */
  scrubResult: EXT.scrubResult,
  /** valueCode: ClaimStatus. On Claim. Same URL as EXT.claimStatus. */
  claimStatus: EXT.claimStatus,
  /** valueDate: appeal deadline. On denial Tasks (also Task.restriction.period.end). */
  appealDeadline: `${TELEEMON_BASE}/StructureDefinition/appeal-deadline`,
} as const;

/** CPT/HCPCS procedure codes on ChargeItem.code and Claim.item.productOrService. */
export const CPT_SYSTEM = 'http://www.ama-assn.org/go/cpt';

export const CLEARINGHOUSE_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/clearinghouse`;
/** On Coverage.payor[0].identifier: the configured payer (PayerConfig.id) this plan bills to. */
export const PAYER_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/payer`;

/** The configured payer a Coverage bills to, once a biller has linked it (P32 or P30). */
export const payerIdOf = (coverage: Coverage | undefined): string | undefined => coverage?.payor?.find((p) => p.identifier?.system === PAYER_IDENTIFIER_SYSTEM)?.identifier?.value;

/** Suggests a configured payer for a free-text plan name (exact name, case-insensitive). The biller confirms it. */
export function suggestPayer(display: string | undefined, payers: readonly PayerConfig[]): PayerConfig | undefined {
  const name = display?.trim().toLowerCase();
  return name ? payers.find((p) => p.active && p.name.toLowerCase() === name) : undefined;
}
export const REMITTANCE_IDENTIFIER_SYSTEM = `${TELEEMON_BASE}/identifier/remittance-trace`;

/** Task codes (CODE_SYSTEMS.taskCode) for billing work. */
export const BILLING_TASKS = {
  claimRejected: 'claim-rejected',
  eraException: 'era-exception',
  denial: 'denial',
  eligibilityIssue: 'eligibility-issue',
  refundReview: 'refund-review',
  smallBalance: 'small-balance-review',
  statementRun: 'statement-run',
  /** A worker step failed (charge not posted, claim not sent); the description says what to do. */
  billingError: 'billing-error',
} as const;

/** Communication category for billing notices to patients (no amounts or clinical content). */
export const BILLING_NOTICE_CATEGORY = 'billing-notice';

/** Whole cents from a FHIR Money value (dollars). */
export const moneyCents = (m: { value?: number } | undefined): number | undefined => (m?.value === undefined ? undefined : Math.round(m.value * 100));
export const centsMoney = (cents: number) => ({ value: cents / 100, currency: 'USD' as const });

/**
 * R4 ChargeItem has no `status` search parameter, so work queues search by tag instead. The
 * charge-rules Bot sets these tags on every write, so they always match the charge:
 *   status-<status>   the charge status (P30 tabs, P31 "ready to bill")
 *   ledger-pending    billable, not yet posted to the ledger (worker)
 *   reversal-pending  entered in error after posting, reversal not yet recorded (worker)
 */
export const CHARGE_QUEUE_SYSTEM = `${TELEEMON_BASE}/CodeSystem/charge-queue`;
export type ChargeQueue = `status-${ChargeItem['status']}` | 'ledger-pending' | 'reversal-pending';

export function chargeQueues(c: ChargeItem): ChargeQueue[] {
  const has = (url: string) => c.extension?.some((e) => e.url === url) ?? false;
  const out: ChargeQueue[] = [`status-${c.status}`];
  if (c.status === 'billable' && !has(REVENUE_EXT.ledgerJournal)) out.push('ledger-pending');
  if (c.status === 'entered-in-error' && has(REVENUE_EXT.ledgerJournal) && !has(REVENUE_EXT.ledgerReversal)) out.push('reversal-pending');
  return out;
}

/** The charge with its queue tags recomputed; other tags are kept. */
export function withChargeQueueTags(c: ChargeItem): ChargeItem {
  const others = (c.meta?.tag ?? []).filter((t) => t.system !== CHARGE_QUEUE_SYSTEM);
  return { ...c, meta: { ...c.meta, tag: [...others, ...chargeQueues(c).map((code) => ({ system: CHARGE_QUEUE_SYSTEM, code }))] } };
}

/** Search value for one queue: `{ _tag: chargeQueueTag('status-planned') }`. */
export const chargeQueueTag = (q: ChargeQueue): string => `${CHARGE_QUEUE_SYSTEM}|${q}`;

/** Idempotency identifier for a captured charge: one per signed note and code. */
export const chargeIdentifier = (compositionId: string, code: string) => ({ system: GENERATED_IDENTIFIER_SYSTEM, value: `charge:${compositionId}:${code}` });

export function chargeLineOf(c: ChargeItem): ChargeLine | undefined {
  const json = c.extension?.find((e) => e.url === REVENUE_EXT.chargeLine)?.valueString;
  try {
    return json ? (JSON.parse(json) as ChargeLine) : undefined;
  } catch {
    return undefined;
  }
}

export const claimStatusOf = (c: Claim): ClaimStatus => (c.extension?.find((e) => e.url === REVENUE_EXT.claimStatus)?.valueCode as ClaimStatus | undefined) ?? 'draft';

export interface ScrubStamp {
  readonly at: string;
  readonly hash: string;
  readonly findings: { ruleId: string; severity: 'error' | 'warning'; message: string }[];
}

export function scrubStampOf(c: Claim): ScrubStamp | undefined {
  const json = c.extension?.find((e) => e.url === REVENUE_EXT.scrubResult)?.valueString;
  try {
    return json ? (JSON.parse(json) as ScrubStamp) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Change detection for a claim's billable content (not a security hash): the scrub result is
 * valid only for the content it checked, so any edit after scrubbing requires a new scrub.
 */
export function claimContentHash(c: Claim): string {
  const content = stableJson({
    patient: c.patient?.reference, provider: c.provider?.reference, billablePeriod: c.billablePeriod, insurance: c.insurance?.map((i) => i.coverage?.reference),
    diagnosis: c.diagnosis?.map((d) => d.diagnosisCodeableConcept?.coding?.[0]?.code), related: c.related, subType: c.subType,
    items: c.item?.map((i) => ({ code: i.productOrService?.coding?.[0]?.code, mod: i.modifier?.map((m) => m.coding?.[0]?.code), ptr: i.diagnosisSequence, qty: i.quantity?.value, net: i.net?.value, pos: i.locationCodeableConcept?.coding?.[0]?.code, ci: i.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference })),
    total: c.total?.value,
    payer: c.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) h = Math.imul(h ^ content.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** A scrub stamp is current when it checked this exact content and found no errors. */
export function scrubCurrentAndClean(c: Claim): boolean {
  const s = scrubStampOf(c);
  return Boolean(s && s.hash === claimContentHash(c) && !s.findings.some((f) => f.severity === 'error'));
}
