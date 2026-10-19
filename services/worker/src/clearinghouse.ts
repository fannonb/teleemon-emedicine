// Clearinghouse adapter (Phase 8). Claims go out, acknowledgements and 835 remittances come back,
// and eligibility is checked in real time. Two implementations behind one interface:
//   - MockClearinghouse (default): a deterministic synthetic test payer. State lives in
//     services/worker/clearinghouse-mock.json (git-ignored). Synthetic data only.
//   - StediClearinghouse, when STEDI_API_KEY is set. UNVERIFIED against the Stedi sandbox: see the
//     endpoint list on that class before relying on it.
// Logging: counts only. Claim payloads and remittances carry PHI and are never logged.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaimDraft, EligibilityResult, FeeScheduleEntry, PayerConfig, PersonName, RemitAdjustment, RemitClaim, Remittance } from '@teleemon/core';
import { DEFAULT_BILLING, parseDollars, sumCents } from '@teleemon/core';

export interface EligibilityRequest {
  readonly payer: PayerConfig;
  readonly memberId: string;
  readonly subscriber: PersonName & { readonly birthDate?: string };
  readonly serviceDate: string;
  readonly providerNpi?: string;
}

export interface ClaimAcknowledgement {
  /** The clearinghouse's id for the submission; the worker matches on it. */
  readonly clearinghouseId: string;
  /** Our Claim id, when the clearinghouse echoes it back. */
  readonly claimId: string;
  readonly accepted: boolean;
  readonly messages: string[];
}

export interface RemittanceEnvelope {
  /** The 835 as received (JSON for the mock and Stedi). Stored unchanged. */
  readonly raw: string;
  readonly remittance: Remittance;
}

export interface Clearinghouse {
  readonly mode: 'mock' | 'stedi';
  /** Idempotent: submitting the same Claim id again returns the id from the first submission. */
  submitClaim(c: ClaimDraft & { payer: PayerConfig }): Promise<{ clearinghouseId: string }>;
  fetchAcknowledgements(): Promise<ClaimAcknowledgement[]>;
  fetchRemittances(): Promise<RemittanceEnvelope[]>;
  checkEligibility(req: EligibilityRequest): Promise<EligibilityResult>;
}

// --- Mock --------------------------------------------------------------------------------------

/** The mock's test payer pays this much of the patient's share: a $25 copay, or the allowed amount if less. */
export const MOCK_COPAY_CENTS = 2500;
/** Allowed amount when the fee schedule has no entry for the payer: 80% of the charge, rounded down. */
const MOCK_ALLOWED_PERCENT = 80;

interface MockClaim {
  readonly claimId: string;
  readonly clearinghouseId: string;
  readonly payerId: string;
  readonly memberId: string;
  readonly lines: readonly { code: string; chargeCents: number }[];
  ackPending: boolean;
  accepted: boolean;
  remitPending: boolean;
}

interface MockState {
  /** Random per mock instance, so ids never repeat across fresh states (tests, a deleted state file). */
  prefix: string;
  seq: number;
  claims: Record<string, MockClaim>;
}

export interface MockOptions {
  /** Where state is kept. null keeps it in memory only (tests). */
  readonly statePath?: string | null;
  /** The fee schedule; its allowedCents per payer decide the allowed amount. */
  readonly fees?: readonly FeeScheduleEntry[];
  readonly now?: () => Date;
}

const DEFAULT_STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'clearinghouse-mock.json');
const pad = (n: number): string => String(n).padStart(6, '0');

export class MockClearinghouse implements Clearinghouse {
  readonly mode = 'mock' as const;
  private readonly statePath: string | null;
  private readonly fees: readonly FeeScheduleEntry[];
  private readonly now: () => Date;
  private state: MockState;

  constructor(opts: MockOptions = {}) {
    this.statePath = opts.statePath === undefined ? DEFAULT_STATE_PATH : opts.statePath;
    this.fees = opts.fees ?? DEFAULT_BILLING.fees;
    this.now = opts.now ?? (() => new Date());
    this.state = this.load();
  }

  async submitClaim(c: ClaimDraft & { payer: PayerConfig }): Promise<{ clearinghouseId: string }> {
    const existing = this.state.claims[c.id];
    if (existing) return { clearinghouseId: existing.clearinghouseId };
    this.state.seq += 1;
    const clearinghouseId = `MOCK-${this.state.prefix}-CH-${pad(this.state.seq)}`;
    this.state.claims[c.id] = {
      claimId: c.id,
      clearinghouseId,
      payerId: c.payer.id,
      memberId: c.coverage.memberId ?? '',
      lines: c.lines.map((l) => ({ code: l.code, chargeCents: l.chargeCents })),
      ackPending: true,
      accepted: false,
      remitPending: false,
    };
    this.save();
    return { clearinghouseId };
  }

  async fetchAcknowledgements(): Promise<ClaimAcknowledgement[]> {
    const out: ClaimAcknowledgement[] = [];
    for (const c of Object.values(this.state.claims)) {
      if (!c.ackPending) continue;
      const rejected = c.memberId.startsWith('REJ');
      c.ackPending = false;
      c.accepted = !rejected;
      c.remitPending = !rejected;
      out.push({
        clearinghouseId: c.clearinghouseId,
        claimId: c.claimId,
        accepted: !rejected,
        messages: rejected ? ['MOCK: synthetic rejection, member ID starts with REJ'] : [],
      });
    }
    if (out.length) this.save();
    return out;
  }

  async fetchRemittances(): Promise<RemittanceEnvelope[]> {
    const byPayer = new Map<string, MockClaim[]>();
    for (const c of Object.values(this.state.claims)) {
      if (!c.remitPending) continue;
      byPayer.set(c.payerId, [...(byPayer.get(c.payerId) ?? []), c]);
    }
    const out: RemittanceEnvelope[] = [];
    const paymentDate = this.now().toISOString().slice(0, 10);
    for (const payerId of [...byPayer.keys()].sort()) {
      const claims = byPayer.get(payerId) ?? [];
      this.state.seq += 1;
      const traceNumber = `MOCK-${this.state.prefix}-TRN-${pad(this.state.seq)}`;
      const remitClaims = claims.map((c) => {
        this.state.seq += 1;
        return this.remitClaimFor(c, payerId, `MOCK-${this.state.prefix}-PCN-${pad(this.state.seq)}`);
      });
      const remittance: Remittance = { traceNumber, payerId, paymentDate, totalPaidCents: sumCents(remitClaims.map((r) => r.paidCents)), claims: remitClaims };
      for (const c of claims) c.remitPending = false;
      out.push({ raw: JSON.stringify(remittance), remittance });
    }
    if (out.length) this.save();
    return out;
  }

  /**
   * The 835 line for one accepted claim. Allowed comes from the fee schedule for this payer, else
   * 80% of the charge. The patient pays min(allowed, copay); the rest of the charge is contractual.
   */
  private remitClaimFor(c: MockClaim, payerId: string, payerClaimControl: string): RemitClaim {
    const charge = sumCents(c.lines.map((l) => l.chargeCents));
    if (c.memberId.startsWith('DENY')) {
      return { patientControlNumber: c.claimId, payerClaimControl, statusCode: '4', chargeCents: charge, paidCents: 0, patientResponsibilityCents: 0, adjustments: [{ group: 'CO', reason: '27', cents: charge }] };
    }
    const allowed = sumCents(c.lines.map((l) => {
      const fee = this.fees.find((f) => f.code === l.code);
      const byPayer = fee?.allowedCents?.[payerId];
      return Math.min(l.chargeCents, byPayer ?? Math.floor((l.chargeCents * MOCK_ALLOWED_PERCENT) / 100));
    }));
    const patientShare = Math.min(allowed, MOCK_COPAY_CENTS);
    const paid = allowed - patientShare;
    const adjustments: RemitAdjustment[] = [];
    if (charge - allowed > 0) adjustments.push({ group: 'CO', reason: '45', cents: charge - allowed });
    if (patientShare > 0) adjustments.push({ group: 'PR', reason: '3', cents: patientShare });
    return { patientControlNumber: c.claimId, payerClaimControl, statusCode: '1', chargeCents: charge, paidCents: paid, patientResponsibilityCents: patientShare, adjustments };
  }

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResult> {
    const planName = `${req.payer.name} plan`;
    if (req.memberId.startsWith('INACTIVE')) return { active: false, planName, errors: [] };
    return { active: true, planName, copayCents: MOCK_COPAY_CENTS, mentalHealthCovered: true, telehealthCovered: true, errors: [] };
  }

  private load(): MockState {
    const empty: MockState = { prefix: randomBytes(4).toString('hex').toUpperCase(), seq: 0, claims: {} };
    if (this.statePath === null || !existsSync(this.statePath)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as MockState;
      return { prefix: parsed.prefix || empty.prefix, seq: Number(parsed.seq) || 0, claims: parsed.claims ?? {} };
    } catch {
      // Refusing beats resetting: a reset could reissue ids the workers have already recorded.
      throw new Error(`Clearinghouse mock state is unreadable (${this.statePath}). Move it aside to start again.`);
    }
  }

  private save(): void {
    if (this.statePath === null) return;
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }
}

// --- Stedi -------------------------------------------------------------------------------------

/**
 * Stedi Healthcare API client. UNVERIFIED against the Stedi sandbox: the request and response
 * shapes below are written from memory of Stedi's public API and must be checked against the
 * sandbox before any claim is sent. Until then the mock is the only adapter used in tests.
 *
 * Endpoints used (base STEDI_BASE_URL, default https://healthcare.us.stedi.com):
 *   POST /2024-04-01/change/medicalnetwork/professionalclaims/v3/submission  submit an 837P as JSON
 *   POST /2024-04-01/change/medicalnetwork/eligibility/v3                    270 to 271, real time
 *   GET  STEDI_PATHS.acknowledgements  277CA retrieval (PLACEHOLDER path, confirm in sandbox)
 *   GET  STEDI_PATHS.remittances       835 retrieval (PLACEHOLDER path, confirm in sandbox)
 * Auth: `Authorization: Key <STEDI_API_KEY>`. Test mode sends usageIndicator 'T' (the default
 * unless STEDI_TEST_MODE=false).
 */
export const STEDI_PATHS = {
  claimSubmission: '/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission',
  eligibility: '/2024-04-01/change/medicalnetwork/eligibility/v3',
  acknowledgements: '/2024-04-01/polling/277ca',
  remittances: '/2024-04-01/polling/835',
} as const;

export interface StediOptions {
  readonly apiKey: string;
  readonly testMode: boolean;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export class StediClearinghouse implements Clearinghouse {
  readonly mode = 'stedi' as const;
  constructor(private readonly opts: StediOptions) {}

  async submitClaim(c: ClaimDraft & { payer: PayerConfig }): Promise<{ clearinghouseId: string }> {
    const body = {
      usageIndicator: this.opts.testMode ? 'T' : 'P',
      tradingPartnerServiceId: c.payer.stediTradingPartnerId,
      submitter: { organizationName: 'Teleemon practice' },
      receiver: { organizationName: c.payer.name, payerId: c.payer.payerIdCode },
      billing: {
        npi: c.providers.billing.npi,
        employerId: c.providers.billing.taxId,
        organizationName: 'Teleemon practice',
      },
      subscriber: {
        memberId: c.coverage.memberId,
        firstName: c.patient.name.given,
        lastName: c.patient.name.family,
        dateOfBirth: c.patient.birthDate?.replace(/-/g, ''),
        gender: c.patient.sex === 'male' ? 'M' : c.patient.sex === 'female' ? 'F' : 'U',
        groupNumber: c.coverage.groupNumber,
      },
      claimInformation: {
        patientControlNumber: c.id,
        claimChargeAmount: (sumCents(c.lines.map((l) => l.chargeCents)) / 100).toFixed(2),
        placeOfServiceCode: c.placeOfService,
        claimFrequencyCode: c.frequencyCode,
        healthCareCodeInformation: c.diagnoses.map((d, i) => ({ diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF', diagnosisCode: d.code.replace('.', '') })),
        serviceLines: c.lines.map((l, i) => ({
          serviceDate: c.serviceDate.replace(/-/g, ''),
          lineNumber: i + 1,
          professionalService: {
            procedureCode: l.code,
            procedureModifiers: l.modifiers,
            lineItemChargeAmount: (l.chargeCents / 100).toFixed(2),
            measurementUnit: 'UN',
            serviceUnitCount: String(l.units),
            compositeDiagnosisCodePointers: { diagnosisCodePointers: l.diagnosisPointers.map(String) },
            placeOfServiceCode: l.pos,
          },
        })),
      },
    };
    const res = await this.request('POST', STEDI_PATHS.claimSubmission, body, 'claim submission');
    const clearinghouseId = String((res as { transactionId?: unknown }).transactionId ?? '');
    if (!clearinghouseId) throw new Error('Stedi accepted the request but returned no transaction id; the claim is not recorded as submitted');
    return { clearinghouseId };
  }

  async fetchAcknowledgements(): Promise<ClaimAcknowledgement[]> {
    const res = (await this.request('GET', STEDI_PATHS.acknowledgements, undefined, '277CA retrieval')) as { items?: { transactionId?: string; claimControlNumber?: string; accepted?: boolean; messages?: string[] }[] };
    return (res.items ?? []).map((i) => ({
      clearinghouseId: String(i.transactionId ?? ''),
      claimId: String(i.claimControlNumber ?? ''),
      accepted: i.accepted === true,
      messages: (i.messages ?? []).map((m) => String(m).slice(0, 200)),
    }));
  }

  async fetchRemittances(): Promise<RemittanceEnvelope[]> {
    const res = (await this.request('GET', STEDI_PATHS.remittances, undefined, '835 retrieval')) as { items?: unknown[] };
    return (res.items ?? []).map((item) => ({ raw: JSON.stringify(item), remittance: remittanceFromStedi(item) }));
  }

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResult> {
    const body = {
      controlNumber: '000000001',
      tradingPartnerServiceId: req.payer.stediTradingPartnerId,
      usageIndicator: this.opts.testMode ? 'T' : 'P',
      provider: { npi: req.providerNpi },
      subscriber: { memberId: req.memberId, firstName: req.subscriber.given, lastName: req.subscriber.family, dateOfBirth: req.subscriber.birthDate?.replace(/-/g, '') },
      encounter: { serviceTypeCodes: ['30'], dateOfService: req.serviceDate.replace(/-/g, '') },
    };
    const res = (await this.request('POST', STEDI_PATHS.eligibility, body, 'eligibility check')) as {
      benefitsInformation?: { code?: string; benefitAmount?: string; name?: string }[];
      errors?: { description?: string; code?: string }[];
    };
    const benefits = res.benefitsInformation ?? [];
    const copay = benefits.find((b) => b.code === 'B' && b.benefitAmount);
    // Mental health and telehealth coverage are left unknown: the 271 mapping is not verified yet.
    return {
      active: benefits.some((b) => b.code === '1') && !benefits.some((b) => b.code === '6'),
      planName: undefined,
      copayCents: copay?.benefitAmount ? parseDollars(copay.benefitAmount) : undefined,
      errors: (res.errors ?? []).map((e) => (e.description ?? e.code ?? 'Unknown eligibility error').slice(0, 200)),
    };
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, what: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Key ${this.opts.apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      // Only the status is reported: response bodies can echo PHI.
      if (!res.ok) throw new Error(`Stedi ${what} failed with HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Maps one Stedi 835 to a Remittance. UNVERIFIED field names (written from memory). Dollar strings
 * are read exactly by parseDollars. remittanceProblems checks the arithmetic, so a wrong mapping
 * fails to tie rather than posting silently.
 */
export function remittanceFromStedi(item: unknown): Remittance {
  const r = item as {
    traceNumber?: string;
    payerId?: string;
    paymentDate?: string;
    totalPaid?: string;
    claims?: {
      patientControlNumber?: string;
      payerClaimControl?: string;
      statusCode?: string;
      chargeAmount?: string;
      paidAmount?: string;
      patientResponsibilityAmount?: string;
      adjustments?: { group?: string; reason?: string; amount?: string }[];
    }[];
  };
  const money = (s: string | undefined, what: string): number => {
    const v = parseDollars(s ?? '');
    if (v === undefined) throw new Error(`835 ${what} is not a dollar amount`);
    return v;
  };
  const claims: RemitClaim[] = (r.claims ?? []).map((c) => ({
    patientControlNumber: c.patientControlNumber ?? '',
    payerClaimControl: c.payerClaimControl ?? '',
    statusCode: c.statusCode ?? '',
    chargeCents: money(c.chargeAmount, 'charge'),
    paidCents: money(c.paidAmount, 'paid'),
    patientResponsibilityCents: money(c.patientResponsibilityAmount, 'patient responsibility'),
    adjustments: (c.adjustments ?? []).map((a) => ({ group: (a.group ?? '') as RemitAdjustment['group'], reason: a.reason ?? '', cents: money(a.amount, 'adjustment') })),
  }));
  if (!r.traceNumber || !r.payerId || !r.paymentDate) throw new Error('835 is missing its trace number, payer or payment date');
  return { traceNumber: r.traceNumber, payerId: r.payerId, paymentDate: r.paymentDate, totalPaidCents: money(r.totalPaid, 'total paid'), claims };
}

/** Stedi when STEDI_API_KEY is set; otherwise the synthetic mock. */
export function clearinghouseFromEnv(env: NodeJS.ProcessEnv = process.env): Clearinghouse {
  const apiKey = env.STEDI_API_KEY;
  if (apiKey) {
    return new StediClearinghouse({ apiKey, testMode: env.STEDI_TEST_MODE !== 'false', baseUrl: env.STEDI_BASE_URL ?? 'https://healthcare.us.stedi.com' });
  }
  return new MockClearinghouse({ fees: DEFAULT_BILLING.fees });
}
