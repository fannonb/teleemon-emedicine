import type { BillingSettings, FeeScheduleEntry, PayerConfig } from '@teleemon/core';

// Checks for the billing settings editor (P40). They stop obviously wrong or duplicate entries from
// being saved; the claim scrubber and the server remain the final checks on what is billed.
// A money field that cannot be read is stored as NaN, which every check here rejects.

export const CPT_CODE = /^[0-9A-Z]{5}$/;
/** Internal payer code; the payer id becomes `payer:<code>` and is the ledger's payer reference. */
export const PAYER_CODE = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** 837 payer ID (clearinghouse routing number). */
export const PAYER_ID_CODE = /^[A-Za-z0-9]{2,10}$/;

const whole = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;

export function payerProblems(p: PayerConfig, others: readonly PayerConfig[], isNew: boolean): string[] {
  const out: string[] = [];
  if (!p.name.trim() || p.name.length > 80) out.push('Name is needed, up to 80 characters.');
  if (isNew) {
    if (!PAYER_CODE.test(p.id.replace(/^payer:/, ''))) out.push('Internal code: 2 to 41 lower-case letters, numbers or dashes.');
    else if (others.some((o) => o.id === p.id)) out.push('Another payer already uses that internal code.');
  }
  if (!PAYER_ID_CODE.test(p.payerIdCode)) out.push('Payer ID: 2 to 10 letters or numbers (the 837 payer ID).');
  else if (others.some((o) => o.payerIdCode.toUpperCase() === p.payerIdCode.toUpperCase())) out.push(`Payer ID ${p.payerIdCode} belongs to another payer already.`);
  if (!whole(p.timelyFilingDays, 1, 1095)) out.push('Timely filing: a whole number of days from 1 to 1095.');
  if (!whole(p.appealDays, 1, 730)) out.push('Appeal window: a whole number of days from 1 to 730.');
  if (p.requiresPriorAuthCodes.some((c) => !CPT_CODE.test(c))) out.push('Prior-authorization codes must be 5-character procedure codes.');
  if (p.stediTradingPartnerId !== undefined && p.stediTradingPartnerId.length > 64) out.push('Trading partner ID is too long.');
  return out;
}

export function feeProblems(f: FeeScheduleEntry, others: readonly FeeScheduleEntry[], isNew: boolean): string[] {
  const out: string[] = [];
  if (!CPT_CODE.test(f.code)) out.push('Code: 5 characters, digits or capital letters (for example 99214).');
  else if (isNew && others.some((o) => o.code === f.code)) out.push(`${f.code} is already in the fee schedule.`);
  if (!f.description.trim() || f.description.length > 200) out.push('Description is needed, up to 200 characters.');
  if (!Number.isSafeInteger(f.chargeCents) || f.chargeCents <= 0) out.push('Charge: an amount above $0.00 in dollars and cents.');
  for (const [payer, cents] of Object.entries(f.allowedCents ?? {})) {
    if (!Number.isSafeInteger(cents) || cents < 0) out.push(`Allowed amount for ${payer} must be $0.00 or more, or blank.`);
  }
  return out;
}

/** Everything wrong with the whole billing settings. Empty when they can be saved. */
export function billingProblems(s: BillingSettings): string[] {
  const out: string[] = [];
  s.payers.forEach((p, i) => {
    const others = s.payers.filter((_, j) => j !== i);
    out.push(...payerProblems(p, others, false).map((m) => `${p.name || 'Payer'}: ${m}`));
  });
  if (new Set(s.payers.map((p) => p.id)).size !== s.payers.length) out.push('Two payers share an internal code.');
  s.fees.forEach((f, i) => {
    const others = s.fees.filter((_, j) => j !== i);
    out.push(...feeProblems(f, others, false).map((m) => `${f.code || 'Fee'}: ${m}`));
  });
  if (new Set(s.fees.map((f) => f.code)).size !== s.fees.length) out.push('A procedure code appears twice in the fee schedule.');
  const pol = s.policy;
  if (!Number.isSafeInteger(pol.smallBalanceWriteOffCents) || pol.smallBalanceWriteOffCents < 0) out.push('Policy: the small-balance write-off limit must be $0.00 or more.');
  if (!whole(pol.refundReviewAfterDays, 1, 365)) out.push('Policy: refund review after 1 to 365 days.');
  if (!Number.isSafeInteger(pol.statementMinimumCents) || pol.statementMinimumCents < 0) out.push('Policy: the statement minimum must be $0.00 or more.');
  if (!whole(pol.statementCycleDays, 1, 365)) out.push('Policy: statement cycle of 1 to 365 days.');
  return out;
}
