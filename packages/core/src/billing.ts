// Billing rules (Phase 8): payer and fee settings, charge capture from a note, the claim scrubber,
// the 835 remittance posting plan, denials, eligibility, aging, statements and claim status.
// Pure functions over plain data. Money is integer cents; journals are built by ledger.ts, which
// this file calls and never changes.
//
// DEFAULT_BILLING holds PLACEHOLDER policy and synthetic payers until the practice sets its policy
// and the billing advisor signs off (scope §22). Nothing moves money automatically except clean ERA
// auto-posting.

import type { NoteData } from './notes';
import { findDiagnosis } from './diagnoses';
import { isValidNpi } from './registration';
import { accountProblem, eraClaimJournal, formatCents, insuranceReceivable, journalProblem, practiceAccount, sumCents } from './ledger';
import type { JournalDraft } from './ledger';

// --- Payers, fees and policy (P40, stored as the 'billing' settings) ---------------------------

export interface PayerConfig {
  /** `payer:<code>`; also the ledger payerRef. */
  readonly id: string;
  readonly name: string;
  readonly stediTradingPartnerId?: string;
  /** 837 payer ID (clearinghouse routing number). */
  readonly payerIdCode: string;
  readonly timelyFilingDays: number;
  readonly appealDays: number;
  /** Codes that need an authorization on the claim. */
  readonly requiresPriorAuthCodes: readonly string[];
  /** Modifier for telehealth lines (POS 02 and 10); 'none' means the payer does not use one. */
  readonly telehealthModifier: '95' | 'GT' | 'none';
  readonly acceptsPos10: boolean;
  readonly active: boolean;
}

export interface FeeScheduleEntry {
  readonly code: string;
  readonly description: string;
  /** Billed charge, integer cents. */
  readonly chargeCents: number;
  /** Expected allowed amount per payer id, for variance checks. */
  readonly allowedCents?: Readonly<Record<string, number>>;
}

/** PLACEHOLDER values pending practice policy; the billing advisor confirms them before go-live. */
export interface BillingPolicy {
  readonly smallBalanceWriteOffCents: number;
  /** Every write-off needs a named approver; writeOffJournal refuses none. */
  readonly writeOffNeedsApproval: true;
  readonly refundReviewAfterDays: number;
  readonly statementMinimumCents: number;
  readonly statementCycleDays: number;
  /** Clean ERA claims post without staff; everything else waits in exceptions. */
  readonly autoPostEra: boolean;
  /** Self-pay no-show fee; 0 means no fee is charged. Older saved settings may omit it. */
  readonly noShowFeeCents?: number;
  /** Self-pay late-cancellation fee; 0 means no fee is charged. */
  readonly lateCancelFeeCents?: number;
}

export type VisitFeeKind = 'no-show' | 'late-cancel';

/** The policy amount for a missed-visit fee, or 0 when the practice charges none. */
export const visitFeeCents = (policy: BillingPolicy, kind: VisitFeeKind): number =>
  Math.max(0, Math.trunc((kind === 'no-show' ? policy.noShowFeeCents : policy.lateCancelFeeCents) ?? 0));

export interface BillingSettings {
  readonly payers: readonly PayerConfig[];
  readonly fees: readonly FeeScheduleEntry[];
  readonly policy: BillingPolicy;
  /** Scrub rule IDs staff have switched off. Mandatory rules ignore this list. */
  readonly disabledScrubRules: readonly string[];
}

/** Synthetic payers and fees. Trading partner and payer IDs are placeholders until confirmed in Settings. */
export const DEFAULT_BILLING: BillingSettings = {
  payers: [
    { id: 'payer:synthetic-commercial', name: 'Synthetic Commercial Health (test)', payerIdCode: 'SYNCM0001', timelyFilingDays: 90, appealDays: 180, requiresPriorAuthCodes: ['90838'], telehealthModifier: '95', acceptsPos10: true, active: true },
    { id: 'payer:synthetic-medicare', name: 'Synthetic Medicare Advantage (test)', payerIdCode: 'SYNMC0001', timelyFilingDays: 365, appealDays: 120, requiresPriorAuthCodes: [], telehealthModifier: 'GT', acceptsPos10: false, active: true },
    { id: 'payer:stedi-test', name: 'Stedi test payer', stediTradingPartnerId: 'REPLACE-WITH-STEDI-TEST-ID', payerIdCode: 'STEDITEST', timelyFilingDays: 180, appealDays: 60, requiresPriorAuthCodes: [], telehealthModifier: 'none', acceptsPos10: true, active: true },
  ],
  fees: [
    { code: '90792', description: 'Psychiatric diagnostic evaluation', chargeCents: 25000 },
    { code: '99212', description: 'Established patient visit, level 2', chargeCents: 8500 },
    { code: '99213', description: 'Established patient visit, level 3', chargeCents: 11000 },
    { code: '99214', description: 'Established patient visit, level 4', chargeCents: 15000 },
    { code: '99215', description: 'Established patient visit, level 5', chargeCents: 19500 },
    { code: '90833', description: 'Psychotherapy add-on, 16–37 minutes', chargeCents: 6000 },
    { code: '90836', description: 'Psychotherapy add-on, 38–52 minutes', chargeCents: 8000 },
    { code: '90838', description: 'Psychotherapy add-on, 53+ minutes', chargeCents: 9500 },
    { code: '90785', description: 'Interactive complexity add-on', chargeCents: 1500 },
    { code: '99417', description: 'Prolonged service, each 15 minutes past 99215', chargeCents: 6000 },
  ],
  policy: { smallBalanceWriteOffCents: 500, writeOffNeedsApproval: true, refundReviewAfterDays: 30, statementMinimumCents: 500, statementCycleDays: 28, autoPostEra: true, noShowFeeCents: 0, lateCancelFeeCents: 0 },
  disabledScrubRules: [],
};

// --- Dates -------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A real YYYY-MM-DD calendar date (rejects 2026-02-30). */
export function isCalendarDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Whole days from one calendar date to another; negative when `to` is earlier. */
export function daysBetweenDates(from: string, to: string): number {
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw new Error(`billing: not a calendar date: ${from} or ${to}`);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export function addCalendarDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new Error(`billing: not a calendar date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// --- Charge capture ----------------------------------------------------------------------------

const TELEHEALTH_MODIFIERS: readonly string[] = ['93', '95', 'GT'];
const isTelehealth = (pos: string): boolean => pos === '02' || pos === '10';
const EM_CODES: ReadonlySet<string> = new Set(['99212', '99213', '99214', '99215']);
const isEm = (code: string): boolean => EM_CODES.has(code);
const PSYCHOTHERAPY_ADDONS: ReadonlySet<string> = new Set(['90833', '90836', '90838']);
/** Primary services a 90785 interactive-complexity add-on may ride on. */
const PRIMARY_FOR_90785: ReadonlySet<string> = new Set(['90792', '90832', '90834', '90837', '99212', '99213', '99214', '99215']);
const POS_CODES: ReadonlySet<string> = new Set(['02', '10', '11', '12', '13', '14', '17', '19', '20', '21', '22', '23', '31', '32', '33', '34', '50', '81']);
const ICD10_FORMAT = /^[A-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/;

export interface ChargeLine {
  readonly code: string;
  readonly modifiers: readonly string[];
  /** One for every E/M and psychotherapy code; the scrubber refuses anything else. */
  readonly units: number;
  /** 1-based pointers into the claim's diagnoses, at most four. */
  readonly diagnosisPointers: readonly number[];
  readonly chargeCents: number;
  readonly pos: string;
  /** The code came from an AI proposal; billable only once the provider accepts it. */
  readonly aiSuggested?: boolean;
  readonly providerAccepted?: boolean;
}

export interface ChargeOptions {
  /** The payer the claim will go to; supplies the telehealth modifier. */
  readonly payer: PayerConfig;
  /** Codes an AI tool proposed for this note. */
  readonly aiProposedCodes?: readonly string[];
  /** Codes the provider has accepted. A code not proposed by AI was entered by the provider. */
  readonly acceptedCodes?: readonly string[];
}

/**
 * Charge lines for a note: primary code, then add-on. Telehealth modifiers come from the payer,
 * never from the note. Session length never enters billing; only the documented time or MDM does.
 */
export function chargeLinesFromNote(note: NoteData, fees: readonly FeeScheduleEntry[], opts: ChargeOptions): ChargeLine[] {
  const b = note.billing;
  if (!b.primaryCode) return [];
  const pos = b.pos ?? '';
  const modifiers = b.modifiers.filter((m) => !TELEHEALTH_MODIFIERS.includes(m));
  if (isTelehealth(pos) && opts.payer.telehealthModifier !== 'none') modifiers.push(opts.payer.telehealthModifier);
  const pointers = Array.from({ length: Math.min(note.diagnoses.length, 4) }, (_, i) => i + 1);
  return [b.primaryCode, b.addOnCode].filter((code): code is string => !!code).map((code) => {
    const aiSuggested = !!opts.aiProposedCodes?.includes(code);
    return {
      code,
      modifiers: [...modifiers],
      units: 1,
      diagnosisPointers: pointers,
      chargeCents: fees.find((f) => f.code === code)?.chargeCents ?? 0,
      pos,
      aiSuggested,
      providerAccepted: !aiSuggested || !!opts.acceptedCodes?.includes(code),
    };
  });
}

/** Why the charges for a note cannot be released yet. Empty when they can. */
export function chargeCaptureProblems(note: Pick<NoteData, 'billing'>, lines: readonly ChargeLine[]): string[] {
  const problems: string[] = [];
  if (!note.billing.primaryCode) problems.push('Choose the visit code');
  for (const l of lines) {
    if (l.aiSuggested && !l.providerAccepted) problems.push(`${l.code} was suggested by AI; the provider must accept it before it can be billed`);
  }
  if (note.billing.emMethod === 'time' && (note.billing.totalMinutes ?? 0) < 10) {
    problems.push('Time-based E/M needs the documented total provider time (at least 10 minutes); appointment or session length is not billable time');
  }
  return problems;
}

// --- Claim scrubber ----------------------------------------------------------------------------

export interface PersonName {
  readonly given: string;
  readonly family: string;
}

export interface ClaimAddress {
  readonly line?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
}

export interface ProviderInfo {
  readonly npi?: string;
  readonly taxonomy?: string;
  readonly taxId?: string;
  readonly licensedStates: readonly string[];
}

/** Everything the scrubber needs, as plain data. The 837 is built only from a claim that scrubs clean. */
export interface ClaimDraft {
  /** Teleemon Claim id, sent as the patient control number (CLM01). */
  readonly id: string;
  readonly patient: { readonly id: string; readonly name: PersonName; readonly birthDate?: string; readonly sex?: 'male' | 'female' | 'unknown'; readonly address?: ClaimAddress };
  readonly subscriber: { readonly relationship?: 'self' | 'spouse' | 'child' | 'other' };
  readonly coverage: { readonly payerId: string; readonly memberId?: string; readonly groupNumber?: string; readonly periodStart: string; readonly periodEnd?: string };
  readonly providers: { readonly rendering: ProviderInfo; readonly billing: ProviderInfo };
  /** YYYY-MM-DD. */
  readonly serviceDate: string;
  readonly placeOfService: string;
  /** State where the patient was physically located for a telehealth visit. */
  readonly patientLocationState?: string;
  readonly lines: readonly ChargeLine[];
  readonly diagnoses: readonly { readonly code: string }[];
  readonly priorAuth?: string;
  /** YYYY-MM-DD the claim is sent; defaults to the scrub date. */
  readonly submittedAt?: string;
  readonly frequencyCode: '1' | '7' | '8';
  readonly originalClaimId?: string;
}

export interface ScrubContext {
  /** Scrub date, YYYY-MM-DD. Passed in so results never depend on the clock. */
  readonly today: string;
  /** The payer for coverage.payerId from billing settings; undefined when it is not configured. */
  readonly payer?: PayerConfig;
  readonly fees: readonly FeeScheduleEntry[];
  /** IDs from BillingSettings.disabledScrubRules. */
  readonly disabledRules?: readonly string[];
}

export interface ScrubRule {
  readonly id: string;
  readonly title: string;
  readonly severity: 'error' | 'warning';
  /** Runs even when switched off in settings: identity, licensure, payer set-up and AI acceptance. */
  readonly mandatory: boolean;
  /** The problem with the claim, or undefined when the claim passes this rule. */
  readonly check: (c: ClaimDraft, ctx: ScrubContext) => string | undefined;
}

export interface ScrubFinding {
  readonly ruleId: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

const rule = (id: string, title: string, check: ScrubRule['check'], severity: ScrubRule['severity'] = 'error', mandatory = false): ScrubRule => ({ id, title, severity, mandatory, check });

/** Thirty checks, each a distinct payer or coding rule. Ids are stable: settings and tests refer to them. */
export const SCRUB_RULES: readonly ScrubRule[] = [
  rule('SCR-001', 'Rendering and billing NPIs are valid', (c) => {
    const bad = (['rendering', 'billing'] as const).filter((k) => !isValidNpi(c.providers[k].npi ?? ''));
    return bad.length ? `${bad.join(' and ')} NPI is missing or fails the check digit` : undefined;
  }, 'error', true),
  rule('SCR-002', 'Billing tax ID has the EIN format', (c) =>
    /^\d{2}-\d{7}$/.test(c.providers.billing.taxId ?? '') ? undefined : 'Billing tax ID must be an EIN in the form NN-NNNNNNN'),
  rule('SCR-003', 'Member ID is present', (c) =>
    /^[A-Za-z0-9]{4,30}$/.test(c.coverage.memberId ?? '') ? undefined : 'Member ID is missing or malformed (4–30 letters and digits)', 'error', true),
  rule('SCR-004', 'Date of birth is a real date before the date of service', (c) => {
    const dob = c.patient.birthDate;
    if (!isCalendarDate(dob)) return 'Patient date of birth is missing or not a real date';
    return isCalendarDate(c.serviceDate) && dob >= c.serviceDate ? 'Patient was born on or after the date of service' : undefined;
  }),
  rule('SCR-005', 'Date of service is a real date and not in the future', (c, ctx) => {
    if (!isCalendarDate(c.serviceDate)) return 'Date of service is not a real date';
    return c.serviceDate > ctx.today ? `Date of service ${c.serviceDate} is after ${ctx.today}` : undefined;
  }),
  rule('SCR-006', 'Claim is filed within the payer timely-filing window', (c, ctx) => {
    const payer = ctx.payer;
    if (!payer || !isCalendarDate(c.serviceDate)) return undefined;
    const filed = c.submittedAt ?? ctx.today;
    if (!isCalendarDate(filed)) return 'Submission date is not a real date';
    const days = daysBetweenDates(c.serviceDate, filed);
    return days > payer.timelyFilingDays ? `Filed ${days} days after service; ${payer.name} allows ${payer.timelyFilingDays}` : undefined;
  }),
  rule('SCR-007', 'Coverage is active on the date of service', (c) => {
    const { periodStart, periodEnd } = c.coverage;
    if (!isCalendarDate(periodStart)) return 'Coverage start date is missing or not a real date';
    if (c.serviceDate < periodStart) return `Coverage starts ${periodStart}, after the date of service`;
    if (periodEnd && c.serviceDate > periodEnd) return `Coverage ended ${periodEnd}, before the date of service`;
    return undefined;
  }),
  rule('SCR-008', 'Payer is configured and active', (c, ctx) => {
    if (!ctx.payer || ctx.payer.id !== c.coverage.payerId) return `Payer ${c.coverage.payerId} is not configured in billing settings`;
    return ctx.payer.active ? undefined : `${ctx.payer.name} is inactive`;
  }, 'error', true),
  rule('SCR-009', 'Place of service is a known code', (c) =>
    POS_CODES.has(c.placeOfService) ? undefined : `Place of service "${c.placeOfService}" is not a known two-digit code`),
  rule('SCR-010', 'Every line uses the claim place of service', (c) => {
    const bad = c.lines.filter((l) => l.pos !== c.placeOfService).map((l) => l.code);
    return bad.length ? `${bad.join(', ')} placed at a different place of service than the claim` : undefined;
  }),
  rule('SCR-011', 'Payer accepts place of service 10', (c, ctx) =>
    c.placeOfService === '10' && ctx.payer && !ctx.payer.acceptsPos10 ? `${ctx.payer.name} does not accept place of service 10; use 02` : undefined),
  rule('SCR-012', 'Telehealth modifier is present where the payer requires it', (c, ctx) => {
    const payer = ctx.payer;
    if (!payer || !isTelehealth(c.placeOfService) || payer.telehealthModifier === 'none') return undefined;
    const want = payer.telehealthModifier;
    const bad = c.lines.filter((l) => !l.modifiers.includes(want)).map((l) => l.code);
    return bad.length ? `${bad.join(', ')} lacks modifier ${want} required by ${payer.name}` : undefined;
  }),
  rule('SCR-013', 'No telehealth modifier where the payer does not use one', (c, ctx) => {
    const payer = ctx.payer;
    if (!payer || payer.telehealthModifier !== 'none') return undefined;
    const bad = c.lines.filter((l) => l.modifiers.some((m) => TELEHEALTH_MODIFIERS.includes(m))).map((l) => l.code);
    return bad.length ? `${bad.join(', ')} carries a telehealth modifier ${payer.name} does not use` : undefined;
  }),
  rule('SCR-014', 'Rendering provider is licensed where the patient is located', (c) => {
    if (!isTelehealth(c.placeOfService)) return undefined;
    if (!c.patientLocationState) return 'Telehealth visit has no patient location state';
    return c.providers.rendering.licensedStates.includes(c.patientLocationState)
      ? undefined
      : `Rendering provider is not licensed in ${c.patientLocationState}, where the patient was located`;
  }, 'error', true),
  rule('SCR-015', 'Diagnosis codes are in ICD-10-CM format', (c) => {
    const bad = c.diagnoses.map((d) => d.code).filter((code) => !ICD10_FORMAT.test(code));
    return bad.length ? `Not ICD-10-CM format: ${bad.join(', ')}` : undefined;
  }),
  rule('SCR-016', 'Diagnosis codes are billable in the catalogue', (c) => {
    const bad = c.diagnoses.map((d) => d.code).filter((code) => !findDiagnosis(code));
    return bad.length ? `Not billable in the diagnosis catalogue: ${bad.join(', ')}` : undefined;
  }),
  rule('SCR-017', 'Claim has at least one line and 1–12 diagnoses', (c) => {
    if (c.lines.length === 0) return 'Claim has no service lines';
    return c.diagnoses.length >= 1 && c.diagnoses.length <= 12 ? undefined : `Claim has ${c.diagnoses.length} diagnoses; 1–12 are allowed`;
  }),
  rule('SCR-018', 'Each line points to one to four existing diagnoses', (c) => {
    const bad = c.lines
      .filter((l) => {
        const p = l.diagnosisPointers;
        return p.length < 1 || p.length > 4 || new Set(p).size !== p.length || p.some((n) => !Number.isInteger(n) || n < 1 || n > c.diagnoses.length);
      })
      .map((l) => l.code);
    return bad.length ? `Diagnosis pointers missing, repeated or out of range on ${bad.join(', ')}` : undefined;
  }),
  rule('SCR-019', 'Charge is positive and matches the fee schedule', (c, ctx) => {
    const problems = c.lines
      .map((l) => {
        if (!Number.isSafeInteger(l.chargeCents) || l.chargeCents <= 0) return `${l.code} charge must be a positive whole-cent amount`;
        const fee = ctx.fees.find((f) => f.code === l.code);
        if (!fee) return `${l.code} is not in the fee schedule`;
        return fee.chargeCents === l.chargeCents ? undefined : `${l.code} is ${formatCents(l.chargeCents)}; the fee schedule says ${formatCents(fee.chargeCents)}`;
      })
      .filter((m): m is string => m !== undefined);
    return problems.length ? problems.join('; ') : undefined;
  }),
  rule('SCR-020', 'Each line is billed for one unit', (c) => {
    const bad = c.lines.filter((l) => l.units !== 1).map((l) => l.code);
    return bad.length ? `${bad.join(', ')} billed with units other than 1` : undefined;
  }),
  rule('SCR-021', 'No code is repeated on the claim', (c) => {
    const codes = c.lines.map((l) => l.code);
    const repeated = [...new Set(codes.filter((code, i) => codes.indexOf(code) !== i))];
    return repeated.length ? `Repeated line code: ${repeated.join(', ')}` : undefined;
  }),
  rule('SCR-022', 'Psychotherapy add-on follows an E/M visit code', (c) => {
    const codes = c.lines.map((l) => l.code);
    const addOns = codes.filter((code) => PSYCHOTHERAPY_ADDONS.has(code));
    return addOns.length && !codes.some(isEm) ? `${addOns.join(', ')} needs a 99212–99215 visit on the same claim` : undefined;
  }),
  rule('SCR-023', '90785 is billed with a primary service', (c) => {
    const codes = c.lines.map((l) => l.code);
    return codes.includes('90785') && !codes.some((code) => code !== '90785' && PRIMARY_FOR_90785.has(code))
      ? '90785 needs a primary psychiatric service or E/M visit on the claim'
      : undefined;
  }),
  rule('SCR-024', '90792 is not billed the same day as an E/M visit', (c) => {
    const codes = c.lines.map((l) => l.code);
    return codes.includes('90792') && codes.some(isEm) ? '90792 and an E/M visit cannot both be billed for the same date' : undefined;
  }),
  rule('SCR-025', '99417 is billed only with 99215', (c) => {
    const codes = c.lines.map((l) => l.code);
    return codes.includes('99417') && !codes.includes('99215') ? '99417 (prolonged service) needs 99215 on the same date' : undefined;
  }),
  rule('SCR-026', 'Prior authorization is attached when the payer requires it', (c, ctx) => {
    const payer = ctx.payer;
    if (!payer) return undefined;
    const need = c.lines.filter((l) => payer.requiresPriorAuthCodes.includes(l.code)).map((l) => l.code);
    return need.length && !c.priorAuth ? `${payer.name} requires prior authorization for ${need.join(', ')}` : undefined;
  }),
  rule('SCR-027', 'Frequency code matches the original claim reference', (c) => {
    if (!['1', '7', '8'].includes(c.frequencyCode)) return `Frequency code ${c.frequencyCode} is not 1, 7 or 8`;
    if (c.frequencyCode !== '1' && !c.originalClaimId) return `Frequency code ${c.frequencyCode} needs the original claim ID`;
    return c.frequencyCode === '1' && c.originalClaimId ? 'An original claim ID is only sent with frequency code 7 or 8' : undefined;
  }),
  rule('SCR-028', 'Patient ZIP is five or nine digits', (c) =>
    /^\d{5}(\d{4})?$/.test(c.patient.address?.zip ?? '') ? undefined : 'Patient ZIP must be 5 or 9 digits, without a hyphen'),
  rule('SCR-029', 'Subscriber relationship is recorded', (c) =>
    c.subscriber.relationship ? undefined : 'Subscriber relationship to the patient is not recorded', 'warning'),
  rule('SCR-030', 'AI-suggested codes are accepted by the provider', (c) => {
    const open = c.lines.filter((l) => l.aiSuggested && !l.providerAccepted).map((l) => l.code);
    return open.length ? `AI-suggested ${open.join(', ')} not accepted by the provider` : undefined;
  }, 'error', true),
];

/** Every enabled rule that fails. Mandatory rules run regardless of ctx.disabledRules. */
export function scrubClaim(c: ClaimDraft, ctx: ScrubContext): ScrubFinding[] {
  const off = new Set(ctx.disabledRules ?? []);
  const findings: ScrubFinding[] = [];
  for (const r of SCRUB_RULES) {
    if (!r.mandatory && off.has(r.id)) continue;
    const message = r.check(c, ctx);
    if (message) findings.push({ ruleId: r.id, severity: r.severity, message });
  }
  return findings;
}

/** True when nothing blocks submission. Warnings are shown but do not block. */
export function scrubClean(findings: readonly ScrubFinding[]): boolean {
  return !findings.some((f) => f.severity === 'error');
}

// --- 835 remittance (ERA) ----------------------------------------------------------------------

export type AdjustmentGroup = 'CO' | 'PR' | 'OA' | 'PI' | 'CR';
const ADJUSTMENT_GROUPS: ReadonlySet<string> = new Set<string>(['CO', 'PR', 'OA', 'PI', 'CR']);
/** Claim statuses (CLP02) that post automatically: processed as primary, secondary, tertiary or forwarded. */
const POSTABLE_STATUS: ReadonlySet<string> = new Set(['1', '2', '3', '19']);

export interface RemitAdjustment {
  readonly group: AdjustmentGroup;
  /** CARC code, e.g. '197'. */
  readonly reason: string;
  readonly cents: number;
}

export interface RemitServiceLine {
  readonly code: string;
  readonly chargeCents: number;
  readonly paidCents: number;
  readonly adjustments: readonly RemitAdjustment[];
}

export interface RemitClaim {
  /** Our Claim id (CLP01). */
  readonly patientControlNumber: string;
  /** Payer's claim control number (CLP07). */
  readonly payerClaimControl: string;
  /** CLP02: 1, 2, 3 processed; 4 denied; 19 forwarded; 20 received; 22 reversal of a prior payment; 23 predetermination. */
  readonly statusCode: string;
  readonly chargeCents: number;
  readonly paidCents: number;
  /** Equals the PR (patient responsibility) adjustments on the claim. */
  readonly patientResponsibilityCents: number;
  readonly adjustments: readonly RemitAdjustment[];
  readonly lines?: readonly RemitServiceLine[];
}

/** A normalized 835 (Stedi returns JSON). Provider adjustments: positive amounts reduce the payment. */
export interface Remittance {
  readonly traceNumber: string;
  /** Payer key (`payer:<code>`), matching PayerConfig.id. */
  readonly payerId: string;
  /** YYYY-MM-DD, from BPR16. */
  readonly paymentDate: string;
  /** BPR02: the EFT total. Claim payments less provider adjustments must equal it. */
  readonly totalPaidCents: number;
  readonly claims: readonly RemitClaim[];
  readonly providerAdjustments?: readonly { readonly reason: string; readonly cents: number }[];
}

/** A problem with one claim (patientControlNumber set) or with the whole remittance (not set). */
export interface RemitProblem {
  readonly patientControlNumber?: string;
  readonly reason: string;
}

/** What the posting plan needs to know about one of our claims. */
export interface RemitLookup {
  readonly claimRef: string;
  readonly patientRef: string;
  readonly payerRef: string;
  readonly encounterRef?: string;
}

/**
 * Checks that the remittance ties: each claim balances (charge − paid − adjustments = 0), PR
 * adjustments match the patient share, and claim payments less provider adjustments equal the EFT total.
 */
export function remittanceProblems(r: Remittance): RemitProblem[] {
  const out: RemitProblem[] = [];
  const whole = (reason: string): void => {
    out.push({ reason });
  };
  const claim = (c: RemitClaim, reason: string): void => {
    out.push({ patientControlNumber: c.patientControlNumber, reason });
  };
  if (!isCalendarDate(r.paymentDate)) whole('payment date is not a real date');
  if (!r.traceNumber || r.traceNumber.length > 100) whole('trace number is missing or longer than 100 characters');
  const payerProblem = accountProblem(insuranceReceivable(r.payerId));
  if (payerProblem) whole(payerProblem);
  if (!Number.isSafeInteger(r.totalPaidCents)) whole('total paid is not whole cents');
  const plbs = r.providerAdjustments ?? [];
  const plbsWhole = plbs.every((p) => Number.isSafeInteger(p.cents));
  if (!plbsWhole) whole('a provider adjustment is not whole cents');

  let amountsWhole = true;
  const seen = new Set<string>();
  for (const c of r.claims) {
    const amounts = [c.chargeCents, c.paidCents, c.patientResponsibilityCents, ...c.adjustments.map((a) => a.cents), ...(c.lines ?? []).flatMap((l) => [l.chargeCents, l.paidCents, ...l.adjustments.map((a) => a.cents)])];
    if (c.adjustments.some((a) => a.group === 'CR') || c.lines?.some((l) => l.adjustments.some((a) => a.group === 'CR'))) {
      claim(c, 'a CR correction or reversal needs manual review before posting; automatic reversal processing is not configured');
    }
    if (amounts.some((n) => !Number.isSafeInteger(n))) {
      amountsWhole = false;
      claim(c, 'an amount is not whole cents');
      continue;
    }
    if (seen.has(c.patientControlNumber)) claim(c, 'this claim appears more than once in the remittance');
    seen.add(c.patientControlNumber);
    if (c.adjustments.some((a) => !ADJUSTMENT_GROUPS.has(a.group))) claim(c, 'an adjustment uses a group other than CO, PR, OA, PI or CR');
    const adjustments = sumCents(c.adjustments.map((a) => a.cents));
    const left = c.chargeCents - c.paidCents - adjustments;
    if (left !== 0) claim(c, `charge ${formatCents(c.chargeCents)} less paid ${formatCents(c.paidCents)} less adjustments ${formatCents(adjustments)} leaves ${formatCents(left)}`);
    const pr = sumCents(c.adjustments.filter((a) => a.group === 'PR').map((a) => a.cents));
    if (pr !== c.patientResponsibilityCents) claim(c, `patient responsibility ${formatCents(c.patientResponsibilityCents)} does not match the PR adjustments ${formatCents(pr)}`);
    for (const l of c.lines ?? []) {
      const lineLeft = l.chargeCents - l.paidCents - sumCents(l.adjustments.map((a) => a.cents));
      if (lineLeft !== 0) claim(c, `line ${l.code} does not balance by ${formatCents(lineLeft)}`);
    }
    if (c.lines && sumCents(c.lines.map((l) => l.paidCents)) !== c.paidCents) claim(c, 'service lines do not add up to the claim payment');
  }
  if (amountsWhole && plbsWhole && Number.isSafeInteger(r.totalPaidCents)) {
    const paid = sumCents(r.claims.map((c) => c.paidCents));
    const plb = sumCents(plbs.map((p) => p.cents));
    if (paid - plb !== r.totalPaidCents) {
      whole(`claim payments ${formatCents(paid)} less provider adjustments ${formatCents(plb)} is ${formatCents(paid - plb)}, but the EFT total is ${formatCents(r.totalPaidCents)}`);
    }
  }
  return out;
}

// --- Denials -----------------------------------------------------------------------------------

export type DenialCategory = 'eligibility' | 'authorization' | 'coding' | 'timely-filing' | 'duplicate' | 'medical-necessity' | 'other';

/** CARC codes that identify a denial, and the work queue they belong to. */
const DENIAL_CODES: ReadonlyMap<string, DenialCategory> = new Map<string, DenialCategory>([
  ['27', 'eligibility'], ['26', 'eligibility'], ['31', 'eligibility'],
  ['197', 'authorization'], ['15', 'authorization'], ['62', 'authorization'],
  ['4', 'coding'], ['11', 'coding'], ['16', 'coding'], ['181', 'coding'],
  ['29', 'timely-filing'],
  ['18', 'duplicate'],
  ['50', 'medical-necessity'], ['96', 'medical-necessity'],
]);

export const DENIAL_ACTIONS: Readonly<Record<DenialCategory, string>> = {
  eligibility: 'Re-verify coverage with the payer; correct the member record and resubmit, or ask the patient for current insurance.',
  authorization: 'Look for an authorization on file; if one exists, appeal with it. If not, a write-off decision is needed before anything moves to the patient.',
  coding: 'Compare the claim codes, modifiers and diagnoses with the signed note; correct and resubmit if the error is ours.',
  'timely-filing': 'Search for proof of timely filing; if none, a write-off needs approval under the billing policy.',
  duplicate: 'Check whether the original claim was paid; void this one if so, otherwise correct and resubmit.',
  'medical-necessity': 'Review the documentation and appeal with clinical notes if the service was necessary.',
  other: 'Read the remittance remark codes and decide the next step.',
};

export interface DenialItem {
  readonly claimRef: string;
  readonly carc: readonly string[];
  readonly category: DenialCategory;
  /** YYYY-MM-DD: remittance date plus the payer appeal window. */
  readonly appealDeadline: string;
  readonly recommendedAction: string;
}

/** Category of the first CARC code in the table; 'other' when none is known. */
export function categorizeDenial(carcCodes: readonly string[]): DenialCategory {
  for (const code of carcCodes) {
    const category = DENIAL_CODES.get(code);
    if (category) return category;
  }
  return 'other';
}

// --- Posting plan ------------------------------------------------------------------------------

export interface RemitPlanOptions {
  readonly autoPostEra: boolean;
  /** The payer's appeal window in days (PayerConfig.appealDays). */
  readonly appealDays: number;
}

export interface RemitPlan {
  /** Balanced journals to post, in remittance order: claim payments, then provider adjustments. */
  readonly journals: JournalDraft[];
  /** Everything a person must look at. Nothing in here has been posted. */
  readonly exceptions: RemitProblem[];
  /** Denied claims: they stay open on the claim and go to the denial queue. Nothing posts for them. */
  readonly denials: DenialItem[];
}

/**
 * Turns a remittance into postable journals. A remittance that does not tie is held whole. A claim
 * with a problem, an unmatched claim, or (when auto-posting is off) any claim goes to exceptions.
 * Denied claims produce denial items and no journal. Whenever `exceptions` is empty, the cash lines
 * of `journals` sum to `totalPaidCents`.
 */
export function remittancePlan(r: Remittance, lookup: (patientControlNumber: string) => RemitLookup | undefined, opts: RemitPlanOptions): RemitPlan {
  const problems = remittanceProblems(r);
  const journals: JournalDraft[] = [];
  const exceptions: RemitProblem[] = problems.filter((p) => p.patientControlNumber === undefined);
  const denials: DenialItem[] = [];
  if (exceptions.length > 0) return { journals, exceptions, denials };

  const occurredAt = `${r.paymentDate}T12:00:00Z`;
  for (const c of r.claims) {
    const pcn = c.patientControlNumber;
    const reasons = problems.filter((p) => p.patientControlNumber === pcn).map((p) => p.reason);
    const match = lookup(pcn);
    if (!match) reasons.push('no claim in our records has this patient control number');
    else if (match.payerRef !== r.payerId) reasons.push(`our claim is with ${match.payerRef}, but this remittance is from ${r.payerId}`);

    const coPr = [...new Set(c.adjustments.filter((a) => a.group === 'CO' || a.group === 'PR').map((a) => a.reason))];
    const denied = c.statusCode === '4' || coPr.some((code) => DENIAL_CODES.has(code));
    if (denied && match) {
      const category = categorizeDenial(coPr);
      denials.push({ claimRef: match.claimRef, carc: coPr, category, appealDeadline: addCalendarDays(r.paymentDate, opts.appealDays), recommendedAction: DENIAL_ACTIONS[category] });
    }
    if (denied && c.paidCents !== 0) reasons.push('denied claim carries a payment; review and post by hand');
    if (!denied && !POSTABLE_STATUS.has(c.statusCode)) reasons.push(`claim status ${c.statusCode} needs review before posting`);
    if (!denied && !opts.autoPostEra) reasons.push('ERA auto-posting is off; post by hand');

    for (const reason of reasons) exceptions.push({ patientControlNumber: pcn, reason });
    if (reasons.length > 0 || denied || !match) continue;
    try {
      journals.push(
        eraClaimJournal({
          traceNumber: r.traceNumber,
          payerClaimControl: c.payerClaimControl,
          claimRef: match.claimRef,
          payerRef: match.payerRef,
          patientRef: match.patientRef,
          occurredAt,
          paidCents: c.paidCents,
          contractualCents: sumCents(c.adjustments.filter((a) => a.group !== 'PR').map((a) => a.cents)),
          patientResponsibilityCents: c.patientResponsibilityCents,
          encounterRef: match.encounterRef,
        }),
      );
    } catch (e) {
      exceptions.push({ patientControlNumber: pcn, reason: (e as Error).message.replace(/^ledger: /, '') });
    }
  }

  // Provider adjustments (PLB): cash out, and the payer's receivable comes back up, as with a take-back.
  (r.providerAdjustments ?? []).forEach((p, i) => {
    if (p.cents === 0) return;
    if (!opts.autoPostEra) {
      exceptions.push({ reason: `provider adjustment ${p.reason} of ${formatCents(p.cents)}: ERA auto-posting is off` });
      return;
    }
    const j: JournalDraft = {
      kind: 'payment',
      idempotencyKey: `plb:${r.traceNumber}:${i}`,
      occurredAt,
      source: `era:${r.traceNumber}`.slice(0, 200),
      memo: p.reason.slice(0, 500) || undefined,
      lines: [
        { account: practiceAccount('cash'), cents: -p.cents },
        { account: insuranceReceivable(r.payerId), cents: p.cents },
      ],
    };
    const problem = journalProblem(j);
    if (problem) exceptions.push({ reason: problem });
    else journals.push(j);
  });
  return { journals, exceptions, denials };
}

// --- Eligibility (270/271) ---------------------------------------------------------------------

export interface EligibilityResult {
  readonly active: boolean;
  readonly planName?: string;
  readonly coverageStart?: string;
  readonly coverageEnd?: string;
  readonly copayCents?: number;
  readonly coinsurancePct?: number;
  readonly deductibleRemainingCents?: number;
  readonly mentalHealthCovered?: boolean;
  readonly telehealthCovered?: boolean;
  /** Payer or clearinghouse errors. Any error means the answer cannot be trusted yet. */
  readonly errors: readonly string[];
}

/** Short staff-readable lines and a badge status. Any error makes the status 'check'. */
export function eligibilitySummary(r: EligibilityResult): { status: 'active' | 'inactive' | 'check'; lines: string[] } {
  const covered = (v: boolean | undefined): string => (v === undefined ? 'unknown' : v ? 'covered' : 'not covered');
  const lines: string[] = [];
  if (r.planName) lines.push(`Plan: ${r.planName}`);
  if (r.coverageStart || r.coverageEnd) lines.push(`Coverage: ${r.coverageStart ?? '?'} to ${r.coverageEnd ?? 'open'}`);
  if (r.copayCents !== undefined) lines.push(`Copay: ${formatCents(r.copayCents)}`);
  if (r.coinsurancePct !== undefined) lines.push(`Coinsurance: ${r.coinsurancePct}%`);
  if (r.deductibleRemainingCents !== undefined) lines.push(`Deductible remaining: ${formatCents(r.deductibleRemainingCents)}`);
  lines.push(`Mental health: ${covered(r.mentalHealthCovered)}`);
  lines.push(`Telehealth: ${covered(r.telehealthCovered)}`);
  for (const e of r.errors) lines.push(`Check: ${e}`);
  const status = r.errors.length > 0 ? 'check' : r.active ? 'active' : 'inactive';
  return { status, lines };
}

// --- Aging, statements and policy --------------------------------------------------------------

export type AgingBucket = '0-30' | '31-60' | '61-90' | '91-120' | '120+';
export const AGING_BUCKETS: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '91-120', '120+'];

/** Bucket by days since the date of service. Future dates fall in 0-30. */
export function agingBucket(serviceDate: string, asOf: string): AgingBucket {
  const days = daysBetweenDates(serviceDate, asOf);
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  if (days <= 120) return '91-120';
  return '120+';
}

export interface AgingItem {
  readonly payerRef?: string;
  readonly patientRef?: string;
  readonly cents: number;
  readonly serviceDate: string;
}

/** Totals per bucket. The buckets sum exactly to totalCents, the sum of every item. */
export function agingReport(items: readonly AgingItem[], asOf: string): { byBucket: Record<AgingBucket, number>; totalCents: number } {
  const byBucket = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const i of items) {
    const bucket = agingBucket(i.serviceDate, asOf);
    byBucket[bucket] = sumCents([byBucket[bucket], i.cents]);
  }
  return { byBucket, totalCents: sumCents(items.map((i) => i.cents)) };
}

export interface PatientStatementLine {
  readonly occurredAt: string;
  readonly description: string;
  readonly changeCents: number;
  /** Running balance after this line; positive is owed, negative is credit. */
  readonly balanceCents: number;
}

export interface PatientStatement {
  readonly lines: PatientStatementLine[];
  /** Never negative. */
  readonly amountDueCents: number;
  /** Credit held for the patient, shown separately from what is due. */
  readonly creditCents: number;
}

const KIND_LABEL: Readonly<Record<JournalDraft['kind'], string>> = {
  charge: 'Visit charge',
  payment: 'Payment',
  adjustment: 'Adjustment',
  refund: 'Refund',
  transfer: 'Transfer',
  reversal: 'Reversal',
};

/** Patient-facing statement from journals: only patient receivable and credit accounts appear. */
export function statementLines(patientRef: string, journals: readonly JournalDraft[]): PatientStatement {
  const ownLines = (j: JournalDraft) => j.lines.filter((l) => (l.account.kind === 'patient_receivable' || l.account.kind === 'patient_credit') && l.account.patientRef === patientRef);
  const ordered = journals
    .filter((j) => ownLines(j).length > 0)
    .slice()
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || (a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0));
  const lines: PatientStatementLine[] = [];
  let balance = 0;
  for (const j of ordered) {
    const change = sumCents(ownLines(j).map((l) => l.cents));
    if (change === 0) continue;
    balance = sumCents([balance, change]);
    // Patient-facing: the kind label only. Memos are staff text (approvers, reasons) and never shown.
    lines.push({ occurredAt: j.occurredAt, description: KIND_LABEL[j.kind], changeCents: change, balanceCents: balance });
  }
  return { lines, amountDueCents: Math.max(0, balance), creditCents: Math.max(0, -balance) };
}

/** Whether a patient statement should go out now, and why not if it should not. */
export function statementDue(balanceCents: number, lastStatementAt: string | undefined, asOf: string, policy: BillingPolicy): { due: boolean; reason: string } {
  if (balanceCents <= 0) return { due: false, reason: 'nothing owed' };
  if (balanceCents < policy.statementMinimumCents) return { due: false, reason: `balance is below the ${formatCents(policy.statementMinimumCents)} statement minimum` };
  if (!lastStatementAt) return { due: true, reason: 'no statement has been sent' };
  const days = daysBetweenDates(lastStatementAt, asOf);
  return days >= policy.statementCycleDays
    ? { due: true, reason: `last statement was ${days} days ago` }
    : { due: false, reason: `last statement was ${days} days ago; the cycle is ${policy.statementCycleDays}` };
}

/** Small enough to write off under policy (approval still required). */
export function smallBalanceCandidate(balanceCents: number, policy: BillingPolicy): boolean {
  return balanceCents > 0 && balanceCents <= policy.smallBalanceWriteOffCents;
}

/** Credit held long enough that someone should decide whether to refund it. */
export function refundReviewDue(creditCents: number, creditSince: string | undefined, asOf: string, policy: BillingPolicy): { due: boolean; reason: string } {
  if (creditCents <= 0) return { due: false, reason: 'no credit held' };
  if (!creditSince) return { due: true, reason: 'credit date is unknown; review it' };
  const days = daysBetweenDates(creditSince, asOf);
  return days >= policy.refundReviewAfterDays
    ? { due: true, reason: `credit held for ${days} days` }
    : { due: false, reason: `credit held for ${days} days; review after ${policy.refundReviewAfterDays}` };
}

// --- Claim status ------------------------------------------------------------------------------

export type ClaimStatus = 'draft' | 'scrubbed' | 'submitted' | 'accepted' | 'rejected' | 'paid' | 'partially-paid' | 'denied' | 'appealed' | 'closed';

export const CLAIM_STATUSES: readonly ClaimStatus[] = ['draft', 'scrubbed', 'submitted', 'accepted', 'rejected', 'paid', 'partially-paid', 'denied', 'appealed', 'closed'];

/** Allowed moves. A submitted claim never returns to draft; only a rejected one is corrected. */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  // A claim never sent, or rejected, can be closed (created by mistake, or the visit is not billed).
  draft: ['scrubbed', 'closed'],
  scrubbed: ['draft', 'submitted', 'closed'],
  submitted: ['accepted', 'rejected'],
  rejected: ['draft', 'closed'],
  accepted: ['paid', 'partially-paid', 'denied'],
  'partially-paid': ['paid', 'denied', 'closed'],
  paid: ['partially-paid', 'closed'],
  denied: ['appealed', 'closed'],
  appealed: ['paid', 'partially-paid', 'denied', 'closed'],
  closed: [],
};

/** Why a status change is refused, or undefined when it is allowed. */
export function claimTransitionProblem(from: ClaimStatus, to: ClaimStatus): string | undefined {
  if (from === to) return `claim is already ${to}`;
  if (CLAIM_TRANSITIONS[from].includes(to)) return undefined;
  if (to === 'submitted') return `claim is ${from}, so it cannot be submitted; scrub it first`;
  if (to === 'draft') return `claim is ${from}; only a rejected claim goes back to draft for correction`;
  return `claim cannot move from ${from} to ${to}`;
}
