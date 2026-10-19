// Phase 8 regression tests: billing rules (charge capture, the claim scrubber, the 835 posting plan,
// denials, eligibility, aging, statements, claim status) and the ledger builders they call. Pure
// functions only; no server needed.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChargeLine, ClaimDraft, JournalDraft, NoteData, Remittance, RemitClaim, RemitLookup, ScrubContext } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, NPI_SYSTEM, PAYER_IDENTIFIER_SYSTEM, REVENUE_EXT, chargeItemCents, claimDraftFromFhir } from '@teleemon/core';
import type { ChargeItem, Claim, Coverage, Encounter, Organization, Patient, Practitioner } from '@medplum/fhirtypes';
import { MockClearinghouse, remittanceFromStedi } from '../services/worker/src/clearinghouse';
import { LedgerClient, LedgerRequestError } from '../services/worker/src/ledgerClient';
import { journalsFromEntries } from '../services/worker/src/billing';
import {
  AGING_BUCKETS, CLAIM_TRANSITIONS, CLAIM_STATUSES, DEFAULT_BILLING, NOTE_TEMPLATES, SCRUB_RULES,
  addCalendarDays, agingBucket, agingReport, categorizeDenial, chargeCaptureProblems, chargeJournal, chargeLinesFromNote, claimTransitionProblem,
  daysBetweenDates, eligibilitySummary, emptyNote, eraClaimJournal, formatCents, isCalendarDate, journalProblem, parseDollars, patientPaymentJournal,
  refundReviewDue, remittancePlan, remittanceProblems, reversalJournal, scrubClaim, scrubClean, smallBalanceCandidate, statementDue, statementLines, writeOffJournal,
} from '@teleemon/core';

// --- Fixtures ----------------------------------------------------------------------------------

const FEES = DEFAULT_BILLING.fees;
const [COMMERCIAL, MEDICARE, STEDI] = DEFAULT_BILLING.payers;
const POLICY = DEFAULT_BILLING.policy;
const TODAY = '2026-10-18';
const ctx: ScrubContext = { today: TODAY, payer: COMMERCIAL, fees: FEES };
const feeCents = (code: string): number => FEES.find((f) => f.code === code)?.chargeCents ?? 0;

const line = (code: string, pointers: number[] = [1], modifiers: string[] = ['95'], pos = '10'): ChargeLine => ({
  code,
  modifiers,
  units: 1,
  diagnosisPointers: pointers,
  chargeCents: feeCents(code),
  pos,
});

/** A telehealth claim that scrubs clean against the commercial payer. */
function cleanClaim(): ClaimDraft {
  return {
    id: 'claim-1',
    patient: { id: 'patient-1', name: { given: 'Synthetic', family: 'Patient' }, birthDate: '1980-05-14', sex: 'female', address: { line: '1 Test Way', city: 'Seattle', state: 'WA', zip: '98004' } },
    subscriber: { relationship: 'self' },
    coverage: { payerId: COMMERCIAL.id, memberId: 'SYN123456789', groupNumber: 'GRP1', periodStart: '2026-01-01' },
    providers: {
      rendering: { npi: '1234567893', taxonomy: '2084P0800X', licensedStates: ['WA'] },
      billing: { npi: '1245319599', taxId: '12-3456789', licensedStates: ['WA'] },
    },
    serviceDate: '2026-10-10',
    placeOfService: '10',
    patientLocationState: 'WA',
    lines: [line('99214', [1, 2]), line('90833', [1, 2])],
    diagnoses: [{ code: 'F32.1' }, { code: 'F41.1' }],
    frequencyCode: '1',
  };
}

type Case = { id: string; what: string; mutate: (c: ClaimDraft) => ClaimDraft; ctx?: Partial<ScrubContext> };

/** At least one crafted violation per rule; each fires its own rule ID. SCR-017 has two cases,
 *  one per half of that rule (no service lines; 1–12 diagnoses), so the coverage check dedupes by id. */
const CASES: Case[] = [
  { id: 'SCR-001', what: 'rendering NPI fails the check digit', mutate: (c) => ({ ...c, providers: { ...c.providers, rendering: { ...c.providers.rendering, npi: '1234567890' } } }) },
  { id: 'SCR-002', what: 'tax ID without the hyphen', mutate: (c) => ({ ...c, providers: { ...c.providers, billing: { ...c.providers.billing, taxId: '123456789' } } }) },
  { id: 'SCR-003', what: 'member ID missing', mutate: (c) => ({ ...c, coverage: { ...c.coverage, memberId: undefined } }) },
  { id: 'SCR-004', what: 'born after the date of service', mutate: (c) => ({ ...c, patient: { ...c.patient, birthDate: '2026-10-11' } }) },
  { id: 'SCR-005', what: 'date of service in the future', mutate: (c) => ({ ...c, serviceDate: '2026-11-02' }) },
  { id: 'SCR-006', what: 'filed past the timely-filing limit', mutate: (c) => ({ ...c, serviceDate: '2025-01-03' }) },
  { id: 'SCR-007', what: 'coverage starts after the service', mutate: (c) => ({ ...c, coverage: { ...c.coverage, periodStart: '2026-11-01' } }) },
  { id: 'SCR-008', what: 'payer not in billing settings', mutate: (c) => c, ctx: { payer: undefined } },
  { id: 'SCR-009', what: 'unknown place of service code', mutate: (c) => ({ ...c, placeOfService: '99', lines: c.lines.map((l) => ({ ...l, pos: '99' })) }) },
  { id: 'SCR-010', what: 'one line at another place of service', mutate: (c) => ({ ...c, lines: [{ ...c.lines[0], pos: '11' }, c.lines[1]] }) },
  { id: 'SCR-011', what: 'POS 10 sent to a payer that refuses it', mutate: (c) => ({ ...c, coverage: { ...c.coverage, payerId: MEDICARE.id } }), ctx: { payer: MEDICARE } },
  { id: 'SCR-012', what: 'telehealth modifier missing where the payer needs it', mutate: (c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, modifiers: [] })) }) },
  { id: 'SCR-013', what: 'telehealth modifier sent to a payer that does not use one', mutate: (c) => ({ ...c, coverage: { ...c.coverage, payerId: STEDI.id } }), ctx: { payer: STEDI } },
  { id: 'SCR-014', what: 'patient located in a state the provider is not licensed in', mutate: (c) => ({ ...c, patientLocationState: 'CA' }) },
  { id: 'SCR-015', what: 'diagnosis not in ICD-10-CM format', mutate: (c) => ({ ...c, diagnoses: [{ code: 'f32.1' }, { code: 'F41.1' }] }) },
  { id: 'SCR-016', what: 'diagnosis not in the catalogue', mutate: (c) => ({ ...c, diagnoses: [{ code: 'F99.9' }, { code: 'F41.1' }] }) },
  { id: 'SCR-017', what: 'no service lines', mutate: (c) => ({ ...c, lines: [] }) },
  { id: 'SCR-017', what: 'more than twelve diagnoses', mutate: (c) => ({ ...c, diagnoses: Array.from({ length: 13 }, () => ({ code: 'F41.1' })) }) },
  { id: 'SCR-018', what: 'diagnosis pointer beyond the diagnosis list', mutate: (c) => ({ ...c, lines: [c.lines[0], { ...c.lines[1], diagnosisPointers: [3] }] }) },
  { id: 'SCR-019', what: 'charge differs from the fee schedule', mutate: (c) => ({ ...c, lines: [{ ...c.lines[0], chargeCents: c.lines[0].chargeCents + 100 }, c.lines[1]] }) },
  { id: 'SCR-020', what: 'two units on an add-on', mutate: (c) => ({ ...c, lines: [c.lines[0], { ...c.lines[1], units: 2 }] }) },
  { id: 'SCR-021', what: 'same code twice', mutate: (c) => ({ ...c, lines: [c.lines[0], c.lines[0]] }) },
  { id: 'SCR-022', what: 'psychotherapy add-on without an E/M visit', mutate: (c) => ({ ...c, lines: [line('90833', [1, 2])] }) },
  { id: 'SCR-023', what: '90785 without a primary service', mutate: (c) => ({ ...c, lines: [line('90785', [1, 2])] }) },
  { id: 'SCR-024', what: '90792 billed the same day as an E/M visit', mutate: (c) => ({ ...c, lines: [line('90792', [1, 2]), line('99213', [1, 2])] }) },
  { id: 'SCR-025', what: '99417 billed with 99214', mutate: (c) => ({ ...c, lines: [line('99214', [1, 2]), line('99417', [1, 2])] }) },
  { id: 'SCR-026', what: 'prior authorization missing for 90838', mutate: (c) => ({ ...c, lines: [line('99215', [1, 2]), line('90838', [1, 2])] }) },
  { id: 'SCR-027', what: 'replacement claim without the original claim ID', mutate: (c) => ({ ...c, frequencyCode: '7' }) },
  { id: 'SCR-028', what: 'ZIP with four digits', mutate: (c) => ({ ...c, patient: { ...c.patient, address: { ...c.patient.address, zip: '9800' } } }) },
  { id: 'SCR-029', what: 'subscriber relationship missing', mutate: (c) => ({ ...c, subscriber: {} }) },
  { id: 'SCR-030', what: 'AI-suggested code not accepted by the provider', mutate: (c) => ({ ...c, lines: [{ ...c.lines[0], aiSuggested: true, providerAccepted: false }, c.lines[1]] }) },
];

const MANDATORY = ['SCR-001', 'SCR-003', 'SCR-008', 'SCR-014', 'SCR-030'];

// --- Scrubber ----------------------------------------------------------------------------------

test('a clean telehealth claim passes every scrub rule', () => {
  assert.deepEqual(scrubClaim(cleanClaim(), ctx), []);
  assert.equal(scrubClean(scrubClaim(cleanClaim(), ctx)), true);
});

test('the scrubber has 25 to 30 rules with unique IDs and titles', () => {
  assert.ok(SCRUB_RULES.length >= 25 && SCRUB_RULES.length <= 30, `found ${SCRUB_RULES.length}`);
  assert.equal(new Set(SCRUB_RULES.map((r) => r.id)).size, SCRUB_RULES.length);
  assert.equal(new Set(SCRUB_RULES.map((r) => r.title)).size, SCRUB_RULES.length);
});

test('every scrub rule has a crafted violation in the table', () => {
  assert.deepEqual([...new Set(CASES.map((c) => c.id))].sort(), SCRUB_RULES.map((r) => r.id).sort());
});

for (const k of CASES) {
  test(`${k.id} fires when ${k.what}`, () => {
    const findings = scrubClaim(k.mutate(cleanClaim()), { ...ctx, ...k.ctx });
    assert.ok(findings.some((f) => f.ruleId === k.id), `expected ${k.id}; got ${findings.map((f) => f.ruleId).join(', ') || 'nothing'}`);
  });
}

test('mandatory rules cannot be disabled', () => {
  for (const id of MANDATORY) {
    const k = CASES.find((c) => c.id === id);
    assert.ok(k, `no case for ${id}`);
    const findings = scrubClaim(k.mutate(cleanClaim()), { ...ctx, ...k.ctx, disabledRules: [id] });
    assert.ok(findings.some((f) => f.ruleId === id), `${id} was switched off`);
  }
});

test('a non-mandatory rule can be disabled in settings', () => {
  const k = CASES.find((c) => c.id === 'SCR-002');
  assert.ok(k);
  const findings = scrubClaim(k.mutate(cleanClaim()), { ...ctx, disabledRules: ['SCR-002'] });
  assert.equal(findings.some((f) => f.ruleId === 'SCR-002'), false);
});

test('a warning is shown but does not block submission', () => {
  const findings = scrubClaim({ ...cleanClaim(), subscriber: {} }, ctx);
  assert.deepEqual(findings.map((f) => [f.ruleId, f.severity]), [['SCR-029', 'warning']]);
  assert.equal(scrubClean(findings), true);
  assert.equal(scrubClean(scrubClaim({ ...cleanClaim(), serviceDate: '2026-11-02' }, ctx)), false);
});

// --- Charge capture ----------------------------------------------------------------------------

function note(billing: Partial<NoteData['billing']> = {}): NoteData {
  return {
    ...emptyNote(NOTE_TEMPLATES[1], 'video'),
    diagnoses: [
      { code: 'F32.1', display: 'Major depressive disorder, single episode, moderate' },
      { code: 'F41.1', display: 'Generalized anxiety disorder' },
    ],
    billing: { emMethod: 'mdm', mdm: 'moderate', primaryCode: '99214', pos: '10', modifiers: [], ...billing },
  };
}

test('charge lines take the telehealth modifier from the payer, not from the note', () => {
  const n = note({ addOnCode: '90833', modifiers: ['95'] });
  const commercial = chargeLinesFromNote(n, FEES, { payer: COMMERCIAL });
  assert.deepEqual(
    commercial.map((l) => [l.code, l.modifiers, l.diagnosisPointers, l.pos, l.units]),
    [['99214', ['95'], [1, 2], '10', 1], ['90833', ['95'], [1, 2], '10', 1]],
  );
  assert.equal(commercial[0].chargeCents, feeCents('99214'));
  assert.deepEqual(chargeLinesFromNote(n, FEES, { payer: STEDI }).map((l) => l.modifiers), [[], []]);
  assert.deepEqual(chargeLinesFromNote(n, FEES, { payer: MEDICARE })[0].modifiers, ['GT']);
});

test('an office visit carries no telehealth modifier', () => {
  const lines = chargeLinesFromNote(note({ pos: '11', modifiers: ['95'] }), FEES, { payer: COMMERCIAL });
  assert.deepEqual(lines.map((l) => l.modifiers), [[]]);
  assert.equal(lines[0].pos, '11');
});

test('an AI-suggested code is refused until the provider accepts it', () => {
  const n = note({ addOnCode: '90833' });
  const open = chargeLinesFromNote(n, FEES, { payer: COMMERCIAL, aiProposedCodes: ['90833'] });
  assert.equal(open.find((l) => l.code === '90833')?.providerAccepted, false);
  const problems = chargeCaptureProblems(n, open);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /90833 was suggested by AI/);
  const accepted = chargeLinesFromNote(n, FEES, { payer: COMMERCIAL, aiProposedCodes: ['90833'], acceptedCodes: ['90833'] });
  assert.deepEqual(chargeCaptureProblems(n, accepted), []);
});

test('session length alone is never billable time', () => {
  const short = note({ emMethod: 'time', totalMinutes: 8, primaryCode: '99213' });
  assert.ok(chargeCaptureProblems(short, chargeLinesFromNote(short, FEES, { payer: COMMERCIAL })).some((p) => /not billable time/.test(p)));
  const documented = note({ emMethod: 'time', totalMinutes: 30, primaryCode: '99214' });
  assert.deepEqual(chargeCaptureProblems(documented, chargeLinesFromNote(documented, FEES, { payer: COMMERCIAL })), []);
});

test('a note with no visit code produces no charge lines and a problem', () => {
  const n = note({ primaryCode: undefined });
  assert.deepEqual(chargeLinesFromNote(n, FEES, { payer: COMMERCIAL }), []);
  assert.deepEqual(chargeCaptureProblems(n, []), ['Choose the visit code']);
});

// --- Remittance (835) --------------------------------------------------------------------------

const LOOKUP: Record<string, RemitLookup> = {
  'claim-1': { claimRef: 'Claim/claim-1', patientRef: 'Patient/p1', payerRef: COMMERCIAL.id, encounterRef: 'Encounter/e1' },
  'claim-2': { claimRef: 'Claim/claim-2', patientRef: 'Patient/p2', payerRef: COMMERCIAL.id },
  'claim-3': { claimRef: 'Claim/claim-3', patientRef: 'Patient/p3', payerRef: COMMERCIAL.id },
};
const lookup = (pcn: string): RemitLookup | undefined => LOOKUP[pcn];
const PLAN_OPTS = { autoPostEra: true, appealDays: 120 };

const claim1: RemitClaim = {
  patientControlNumber: 'claim-1', payerClaimControl: 'PCC-1', statusCode: '1', chargeCents: 26000, paidCents: 15000, patientResponsibilityCents: 2000,
  adjustments: [{ group: 'CO', reason: '45', cents: 9000 }, { group: 'PR', reason: '1', cents: 2000 }],
};
const claim2: RemitClaim = {
  patientControlNumber: 'claim-2', payerClaimControl: 'PCC-2', statusCode: '1', chargeCents: 15000, paidCents: 11000, patientResponsibilityCents: 2000,
  adjustments: [{ group: 'CO', reason: '45', cents: 2000 }, { group: 'PR', reason: '2', cents: 2000 }],
};
const remit = (over: Partial<Remittance> = {}): Remittance => ({
  traceNumber: 'TRN-1', payerId: COMMERCIAL.id, paymentDate: '2026-10-15', totalPaidCents: 26000, claims: [claim1, claim2], ...over,
});
const cashCents = (journals: readonly JournalDraft[]): number =>
  journals.flatMap((j) => j.lines).filter((l) => l.account.kind === 'cash').reduce((t, l) => t + l.cents, 0);

test('a remittance that ties has no problems', () => {
  assert.deepEqual(remittanceProblems(remit()), []);
});

test('a claim that does not balance is an exception for that claim only', () => {
  const bad = { ...claim2, adjustments: [{ group: 'CO' as const, reason: '45', cents: 1900 }, { group: 'PR' as const, reason: '2', cents: 2000 }] };
  const r = remit({ claims: [claim1, bad] });
  assert.deepEqual(remittanceProblems(r).map((p) => p.patientControlNumber), ['claim-2']);
  const plan = remittancePlan(r, lookup, PLAN_OPTS);
  assert.equal(plan.journals.length, 1);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-2']);
  assert.match(plan.exceptions[0].reason, /leaves \$1\.00/);
});

test('patient responsibility must equal the PR adjustments', () => {
  const bad = { ...claim1, patientResponsibilityCents: 3000 };
  assert.ok(remittanceProblems(remit({ claims: [bad, claim2] })).some((p) => p.patientControlNumber === 'claim-1' && /does not match the PR adjustments/.test(p.reason)));
});

test('an unknown adjustment group is refused', () => {
  const bad = { ...claim1, adjustments: [{ group: 'XX' as 'CO', reason: '45', cents: 9000 }, claim1.adjustments[1]] };
  assert.ok(remittanceProblems(remit({ claims: [bad, claim2] })).some((p) => /group other than CO, PR, OA, PI or CR/.test(p.reason ?? '')));
});

test('a total that does not tie holds the whole remittance', () => {
  const r = remit({ totalPaidCents: 25000 });
  assert.ok(remittanceProblems(r).some((p) => p.patientControlNumber === undefined && /EFT total/.test(p.reason)));
  const plan = remittancePlan(r, lookup, PLAN_OPTS);
  assert.deepEqual(plan.journals, []);
  assert.ok(plan.exceptions.every((e) => e.patientControlNumber === undefined));
});

test('a clean remittance posts one balanced journal per claim, and cash ties to the EFT total', () => {
  const plan = remittancePlan(remit(), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions, []);
  assert.deepEqual(plan.denials, []);
  assert.equal(plan.journals.length, 2);
  for (const j of plan.journals) {
    assert.equal(j.kind, 'payment');
    assert.equal(journalProblem(j), undefined);
    assert.equal(j.lines.reduce((t, l) => t + l.cents, 0), 0);
  }
  assert.equal(plan.journals[0].idempotencyKey, 'era:TRN-1:PCC-1');
  assert.equal(cashCents(plan.journals), 26000);
});

test('an unmatched claim is an exception and the rest of the remittance still posts', () => {
  const orphan: RemitClaim = { patientControlNumber: 'claim-9', payerClaimControl: 'PCC-9', statusCode: '1', chargeCents: 5000, paidCents: 5000, patientResponsibilityCents: 0, adjustments: [] };
  const plan = remittancePlan(remit({ claims: [claim1, claim2, orphan], totalPaidCents: 31000 }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-9']);
  assert.equal(plan.journals.length, 2);
});

test('a claim filed with another payer is an exception, not a posting', () => {
  const other = (pcn: string): RemitLookup | undefined => (pcn === 'claim-2' ? { ...LOOKUP['claim-2'], payerRef: 'payer:synthetic-medicare' } : lookup(pcn));
  const plan = remittancePlan(remit(), other, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-2']);
  assert.equal(plan.journals.length, 1);
});

test('claim-level CR correction adjustments are held for manual review and never posted as contractual', () => {
  const corrected = { ...claim1, adjustments: [{ group: 'CR' as const, reason: '22', cents: 9000 }, { group: 'PR' as const, reason: '1', cents: 2000 }] };
  const plan = remittancePlan(remit({ claims: [corrected, claim2] }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-1']);
  assert.match(plan.exceptions[0].reason, /CR correction or reversal needs manual review/);
  assert.deepEqual(plan.journals.map((j) => j.idempotencyKey), ['era:TRN-1:PCC-2']);
});

test('service-line CR correction adjustments also route the claim to a manual posting exception', () => {
  const withLineCr = { ...claim1, lines: [{ code: '99214', chargeCents: 26000, paidCents: 15000, adjustments: [{ group: 'CR' as const, reason: '22', cents: 9000 }, { group: 'PR' as const, reason: '1', cents: 2000 }] }] };
  const problems = remittanceProblems(remit({ claims: [withLineCr, claim2] }));
  assert.ok(problems.some((p) => p.patientControlNumber === 'claim-1' && /CR correction or reversal needs manual review/.test(p.reason)));
  const plan = remittancePlan(remit({ claims: [withLineCr, claim2] }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-1']);
  assert.deepEqual(plan.journals.map((j) => j.idempotencyKey), ['era:TRN-1:PCC-2']);
});

test('with auto-posting off, nothing posts and every claim is an exception', () => {
  const plan = remittancePlan(remit(), lookup, { autoPostEra: false, appealDays: 120 });
  assert.deepEqual(plan.journals, []);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-1', 'claim-2']);
});

test('a denied claim produces a denial item with the appeal deadline and no journal', () => {
  const denied: RemitClaim = {
    patientControlNumber: 'claim-1', payerClaimControl: 'PCC-D', statusCode: '4', chargeCents: 26000, paidCents: 0, patientResponsibilityCents: 0,
    adjustments: [{ group: 'CO', reason: '197', cents: 26000 }],
  };
  const plan = remittancePlan(remit({ claims: [denied], totalPaidCents: 0, paymentDate: '2026-10-01' }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.journals, []);
  assert.deepEqual(plan.exceptions, []);
  assert.equal(plan.denials.length, 1);
  const [d] = plan.denials;
  assert.equal(d.claimRef, 'Claim/claim-1');
  assert.deepEqual(d.carc, ['197']);
  assert.equal(d.category, 'authorization');
  assert.equal(d.appealDeadline, '2027-01-29');
  assert.match(d.recommendedAction, /authorization/i);
});

test('a denied claim that carries a payment is an exception for review', () => {
  const odd: RemitClaim = { ...claim1, statusCode: '4', adjustments: [{ group: 'CO', reason: '50', cents: 11000 }], patientResponsibilityCents: 0 };
  const plan = remittancePlan(remit({ claims: [odd], totalPaidCents: 15000 }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-1']);
  assert.equal(plan.denials[0]?.category, 'medical-necessity');
});

test('a take-back (negative payment) posts and keeps cash tied', () => {
  const takeBack: RemitClaim = { patientControlNumber: 'claim-1', payerClaimControl: 'PCC-T', statusCode: '1', chargeCents: 26000, paidCents: -5000, patientResponsibilityCents: 0, adjustments: [{ group: 'CO', reason: '45', cents: 31000 }] };
  const plan = remittancePlan(remit({ claims: [takeBack], totalPaidCents: -5000 }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions, []);
  assert.equal(cashCents(plan.journals), -5000);
});

test('a reversal of a prior payment (status 22) is held for review', () => {
  const reversal = { ...claim1, statusCode: '22' };
  const plan = remittancePlan(remit({ claims: [reversal, claim2], totalPaidCents: 26000 }), lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions.map((e) => e.patientControlNumber), ['claim-1']);
  assert.equal(plan.journals.length, 1);
});

test('a provider adjustment posts as a payer-level journal and cash still ties to the EFT total', () => {
  const r = remit({ totalPaidCents: 25000, providerAdjustments: [{ reason: 'WO', cents: 1000 }] });
  assert.deepEqual(remittanceProblems(r), []);
  const plan = remittancePlan(r, lookup, PLAN_OPTS);
  assert.deepEqual(plan.exceptions, []);
  const plb = plan.journals.find((j) => j.idempotencyKey.startsWith('plb:'));
  assert.ok(plb);
  assert.deepEqual(plb.lines.map((l) => [l.account.kind, l.cents]), [['cash', -1000], ['insurance_receivable', 1000]]);
  assert.equal(cashCents(plan.journals), 25000);
});

// --- Denials and aging -------------------------------------------------------------------------

test('denial CARCs map to the right work queue, first known code wins', () => {
  assert.equal(categorizeDenial(['197']), 'authorization');
  assert.equal(categorizeDenial(['27']), 'eligibility');
  assert.equal(categorizeDenial(['4']), 'coding');
  assert.equal(categorizeDenial(['29']), 'timely-filing');
  assert.equal(categorizeDenial(['18']), 'duplicate');
  assert.equal(categorizeDenial(['96']), 'medical-necessity');
  assert.equal(categorizeDenial(['999']), 'other');
  assert.equal(categorizeDenial(['999', '197']), 'authorization');
  assert.equal(categorizeDenial([]), 'other');
});

test('aging buckets change at 30, 60, 90 and 120 days', () => {
  const expected: [number, string][] = [[0, '0-30'], [30, '0-30'], [31, '31-60'], [60, '31-60'], [61, '61-90'], [90, '61-90'], [91, '91-120'], [120, '91-120'], [121, '120+']];
  for (const [days, bucket] of expected) assert.equal(agingBucket(addCalendarDays(TODAY, -days), TODAY), bucket, `${days} days`);
});

test('aging totals per bucket add up exactly to the input total', () => {
  const items = [
    { payerRef: COMMERCIAL.id, cents: 10000, serviceDate: '2026-10-01' },
    { patientRef: 'Patient/p1', cents: 2500, serviceDate: '2026-08-01' },
    { patientRef: 'Patient/p2', cents: -500, serviceDate: '2026-05-01' },
  ];
  const report = agingReport(items, TODAY);
  assert.equal(report.totalCents, 12000);
  assert.equal(Object.values(report.byBucket).reduce((t, v) => t + v, 0), report.totalCents);
  assert.deepEqual(report.byBucket, { '0-30': 10000, '31-60': 0, '61-90': 2500, '91-120': 0, '120+': -500 });
  assert.deepEqual(AGING_BUCKETS, ['0-30', '31-60', '61-90', '91-120', '120+']);
});

test('calendar date helpers reject impossible dates', () => {
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-2-3'), false);
  assert.equal(daysBetweenDates('2026-10-01', '2026-10-18'), 17);
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
});

// --- Statements and policy ---------------------------------------------------------------------

const P = 'Patient/p1';

test('a patient statement runs a balance in date order and never shows a negative amount due', () => {
  const charge = chargeJournal({ chargeItemId: 'ci-1', version: '1', patientRef: P, cents: 15000, occurredAt: '2026-10-01T12:00:00Z' });
  const payment = patientPaymentJournal({ paymentId: 'ch_1', patientRef: P, method: 'card', cents: 5000, owedCents: 15000, occurredAt: '2026-10-05T12:00:00Z', source: 'portal' });
  const st = statementLines(P, [payment, charge]);
  assert.deepEqual(st.lines.map((l) => l.balanceCents), [15000, 10000]);
  assert.equal(st.amountDueCents, 10000);
  assert.equal(st.creditCents, 0);
});

test('an overpayment shows as credit, separate from amount due', () => {
  const charge = chargeJournal({ chargeItemId: 'ci-2', version: '1', patientRef: P, cents: 15000, occurredAt: '2026-10-01T12:00:00Z' });
  const over = patientPaymentJournal({ paymentId: 'ch_2', patientRef: P, method: 'card', cents: 17000, owedCents: 15000, occurredAt: '2026-10-02T12:00:00Z', source: 'portal' });
  const st = statementLines(P, [charge, over]);
  assert.equal(st.amountDueCents, 0);
  assert.equal(st.creditCents, 2000);
});

test('insurance-only charges do not appear on the patient statement', () => {
  const insurer = chargeJournal({ chargeItemId: 'ci-3', version: '1', patientRef: P, payerRef: COMMERCIAL.id, cents: 15000, occurredAt: '2026-10-01T12:00:00Z' });
  assert.deepEqual(statementLines(P, [insurer]).lines, []);
});

test('statements go out only for a real balance above the minimum, once per cycle', () => {
  assert.equal(statementDue(0, undefined, TODAY, POLICY).due, false);
  assert.equal(statementDue(-300, undefined, TODAY, POLICY).due, false);
  assert.equal(statementDue(400, undefined, TODAY, POLICY).due, false);
  assert.equal(statementDue(2000, undefined, TODAY, POLICY).due, true);
  assert.equal(statementDue(2000, '2026-10-01', TODAY, POLICY).due, false);
  assert.equal(statementDue(2000, '2026-09-15', TODAY, POLICY).due, true);
});

test('small balances are write-off candidates only within the policy limit', () => {
  assert.equal(smallBalanceCandidate(500, POLICY), true);
  assert.equal(smallBalanceCandidate(501, POLICY), false);
  assert.equal(smallBalanceCandidate(0, POLICY), false);
  assert.equal(smallBalanceCandidate(-300, POLICY), false);
  assert.equal(POLICY.writeOffNeedsApproval, true);
});

test('credit is flagged for refund review after the policy window', () => {
  assert.equal(refundReviewDue(2000, '2026-09-01', TODAY, POLICY).due, true);
  assert.equal(refundReviewDue(2000, '2026-10-10', TODAY, POLICY).due, false);
  assert.equal(refundReviewDue(0, '2026-09-01', TODAY, POLICY).due, false);
});

test('eligibility summary badges active, inactive or check, and any error means check', () => {
  const active = eligibilitySummary({ active: true, planName: 'Synthetic PPO', copayCents: 2500, mentalHealthCovered: true, telehealthCovered: true, errors: [] });
  assert.equal(active.status, 'active');
  assert.ok(active.lines.includes('Copay: $25.00'));
  assert.equal(eligibilitySummary({ active: false, errors: [] }).status, 'inactive');
  assert.equal(eligibilitySummary({ active: true, errors: ['AAA: member not found'] }).status, 'check');
});

test('DEFAULT_BILLING has three synthetic payers and every fee the scrubber and note rules use', () => {
  assert.equal(DEFAULT_BILLING.payers.length, 3);
  assert.equal(new Set(DEFAULT_BILLING.payers.map((p) => p.id)).size, 3);
  assert.ok(DEFAULT_BILLING.payers.every((p) => p.id.startsWith('payer:')));
  for (const code of ['90792', '99212', '99213', '99214', '99215', '90833', '90836', '90838', '90785', '99417']) {
    assert.ok(FEES.some((f) => f.code === code && f.chargeCents > 0), `fee for ${code}`);
  }
  assert.equal(POLICY.smallBalanceWriteOffCents, 500);
  assert.equal(POLICY.statementCycleDays, 28);
});

// --- Claim status ------------------------------------------------------------------------------

test('a claim cannot be submitted until it is scrubbed', () => {
  assert.match(claimTransitionProblem('draft', 'submitted') ?? '', /scrub it first/);
  assert.equal(claimTransitionProblem('scrubbed', 'submitted'), undefined);
});

test('a submitted claim never returns to draft; only a rejected claim is corrected', () => {
  assert.match(claimTransitionProblem('submitted', 'draft') ?? '', /only a rejected claim/);
  assert.match(claimTransitionProblem('paid', 'draft') ?? '', /only a rejected claim/);
  assert.equal(claimTransitionProblem('rejected', 'draft'), undefined);
});

test('the claim lifecycle follows the allowed path to payment, denial and appeal', () => {
  const path = ['draft', 'scrubbed', 'submitted', 'accepted', 'denied', 'appealed', 'paid', 'closed'] as const;
  for (let i = 1; i < path.length; i++) assert.equal(claimTransitionProblem(path[i - 1], path[i]), undefined, `${path[i - 1]} to ${path[i]}`);
  assert.match(claimTransitionProblem('closed', 'draft') ?? '', /only a rejected claim/);
  assert.match(claimTransitionProblem('closed', 'paid') ?? '', /cannot move from closed to paid/);
  assert.match(claimTransitionProblem('paid', 'paid') ?? '', /already paid/);
  assert.deepEqual(CLAIM_TRANSITIONS.closed, []);
  assert.equal(CLAIM_STATUSES.length, Object.keys(CLAIM_TRANSITIONS).length);
});

// --- Ledger builders and money -----------------------------------------------------------------

test('a charge journal balances, is keyed by charge version, and names the payer when billed to one', () => {
  const j = chargeJournal({ chargeItemId: 'ci-9', version: 'v2', patientRef: P, payerRef: COMMERCIAL.id, cents: 15000, occurredAt: '2026-10-01T12:00:00Z' });
  assert.equal(j.idempotencyKey, 'charge:ci-9:v2');
  assert.equal(journalProblem(j), undefined);
  assert.equal(j.lines.reduce((t, l) => t + l.cents, 0), 0);
  assert.equal(j.lines[0].account.kind, 'insurance_receivable');
  assert.equal(j.lines[0].account.payerRef, COMMERCIAL.id);
  assert.throws(() => chargeJournal({ chargeItemId: 'ci-9', version: 'v2', patientRef: P, cents: 0, occurredAt: '2026-10-01T12:00:00Z' }), /must be positive/);
});

test('a reversal mirrors its original line for line and names it', () => {
  const original = chargeJournal({ chargeItemId: 'ci-9', version: 'v2', patientRef: P, cents: 15000, occurredAt: '2026-10-01T12:00:00Z' });
  const rev = reversalJournal(original, { reason: 'entered in error', occurredAt: '2026-10-02T12:00:00Z', by: 'billing-review' });
  assert.equal(rev.kind, 'reversal');
  assert.equal(rev.reverses, 'charge:ci-9:v2');
  assert.equal(rev.idempotencyKey, 'reversal:charge:ci-9:v2');
  assert.deepEqual(rev.lines.map((l) => [l.account.kind, l.cents]), original.lines.map((l) => [l.account.kind, -l.cents]));
  assert.equal(journalProblem(rev), undefined);
  assert.throws(() => reversalJournal(rev, { reason: 'again', occurredAt: '2026-10-03T12:00:00Z', by: 'billing-review' }), /not reversed/);
});

test('an ERA claim journal is balanced and keyed by trace and payer claim control number', () => {
  const j = eraClaimJournal({
    traceNumber: 'TRN-7', payerClaimControl: 'PCC-7', claimRef: 'Claim/c7', payerRef: COMMERCIAL.id, patientRef: P,
    occurredAt: '2026-10-15T12:00:00Z', paidCents: 15000, contractualCents: 9000, patientResponsibilityCents: 2000,
  });
  assert.equal(j.idempotencyKey, 'era:TRN-7:PCC-7');
  assert.equal(journalProblem(j), undefined);
  const takeBack = eraClaimJournal({
    traceNumber: 'TRN-8', payerClaimControl: 'PCC-7', claimRef: 'Claim/c7', payerRef: COMMERCIAL.id, patientRef: P,
    occurredAt: '2026-10-16T12:00:00Z', paidCents: -15000, contractualCents: 9000, patientResponsibilityCents: 2000,
  });
  assert.deepEqual(takeBack.lines.map((l) => l.cents), [-15000, 9000, 2000, 4000]);
  assert.equal(journalProblem(takeBack), undefined);
});

test('a write-off names its approver and a payment held as credit splits correctly', () => {
  const wo = writeOffJournal({ key: 'wo-1', patientRef: P, cents: 500, reason: 'small-balance', approvedBy: 'Practice Manager', occurredAt: '2026-10-18T12:00:00Z' });
  assert.equal(wo.idempotencyKey, 'writeoff:wo-1');
  assert.match(wo.memo ?? '', /approved by Practice Manager/);
  assert.equal(journalProblem(wo), undefined);
  const pay = patientPaymentJournal({ paymentId: 'ch_3', patientRef: P, method: 'cash', cents: 2000, owedCents: 500, occurredAt: '2026-10-18T12:00:00Z', source: 'front-desk' });
  assert.deepEqual(pay.lines.map((l) => [l.account.kind, l.cents]), [['cash', 2000], ['patient_receivable', -500], ['patient_credit', -1500]]);
});

test('a journal that does not balance is refused with the reason', () => {
  const problem = journalProblem({
    kind: 'charge', idempotencyKey: 'charge:x:1', occurredAt: '2026-10-01T00:00:00Z', source: 'test',
    lines: [{ account: { kind: 'revenue' }, cents: 100 }, { account: { kind: 'revenue' }, cents: -90 }],
  });
  assert.match(problem ?? '', /does not balance/);
});

test('parseDollars reads money exactly and refuses what is not money', () => {
  assert.equal(parseDollars('$1,234.50'), 123450);
  assert.equal(parseDollars('1,234.5'), 123450);
  assert.equal(parseDollars('1234'), 123400);
  assert.equal(parseDollars('-3'), -300);
  assert.equal(parseDollars('-$5.00'), -500);
  assert.equal(parseDollars('-0'), 0);
  assert.equal(parseDollars('0.001'), undefined);
  assert.equal(parseDollars('12.345'), undefined);
  assert.equal(parseDollars('1,23.45'), undefined);
  assert.equal(parseDollars('.50'), undefined);
  assert.equal(parseDollars('5.'), undefined);
  assert.equal(parseDollars(''), undefined);
  assert.equal(parseDollars('$'), undefined);
  assert.equal(parseDollars('9999999999999999'), undefined);
});

test('formatCents shows dollars and cents, with the sign in front', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-500), '-$5.00');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(-1), '-$0.01');
});

// --- Phase 8 step 3: clearinghouse, claim draft mapping, ledger client, worker billing -----------

const WORKER_NOW = () => new Date('2026-10-18T12:00:00Z');
const workerMock = (fees = FEES): MockClearinghouse => new MockClearinghouse({ statePath: null, fees, now: WORKER_NOW });
const payable = (id: string, memberId = 'SYN123456789', payer = COMMERCIAL) => ({
  ...cleanClaim(), id, payer, coverage: { ...cleanClaim().coverage, payerId: payer.id, memberId },
});

test('the mock 835s pass remittanceProblems and their cash ties to the payer total, one per payer', async () => {
  const ch = workerMock();
  await ch.submitClaim(payable('mock-a'));
  await ch.submitClaim(payable('mock-b', 'SYN222222222', MEDICARE));
  await ch.fetchAcknowledgements();
  const envelopes = await ch.fetchRemittances();
  assert.equal(envelopes.length, 2, 'one 835 per payer');
  const traces = new Set(envelopes.map((e) => e.remittance.traceNumber));
  assert.equal(traces.size, 2, 'trace numbers are unique');
  for (const { remittance: r, raw } of envelopes) {
    assert.deepEqual(remittanceProblems(r), []);
    const plan = remittancePlan(r, (pcn) => ({ claimRef: `Claim/${pcn}`, patientRef: 'Patient/patient-1', payerRef: r.payerId }), PLAN_OPTS);
    assert.deepEqual(plan.exceptions, []);
    assert.equal(cashCents(plan.journals), r.totalPaidCents, 'cash posted equals what the payer paid');
    assert.equal(JSON.parse(raw).traceNumber, r.traceNumber);
  }
});

test('the mock pays the allowed amount less the 25 dollar copay, with the rest as contractual', async () => {
  const ch = workerMock();
  await ch.submitClaim(payable('mock-allowed'));
  await ch.fetchAcknowledgements();
  const [{ remittance: r }] = await ch.fetchRemittances();
  // 99214 at $150.00 and 90833 at $60.00: 80% rounded down is $120.00 and $48.00, so allowed is $168.00.
  const c = r.claims[0];
  assert.equal(c.chargeCents, 21000);
  assert.equal(c.patientResponsibilityCents, 2500);
  assert.equal(c.paidCents, 16800 - 2500);
  assert.deepEqual(c.adjustments.map((a) => [a.group, a.reason, a.cents]), [['CO', '45', 4200], ['PR', '3', 2500]]);
});

test('the mock uses the payer allowance from the fee schedule, and the copay never exceeds the allowed amount', async () => {
  const fees = [
    { code: '99214', description: 'x', chargeCents: 15000, allowedCents: { [COMMERCIAL.id]: 9000 } },
    { code: '90833', description: 'x', chargeCents: 6000, allowedCents: { [COMMERCIAL.id]: 1000 } },
  ];
  const ch = workerMock(fees);
  await ch.submitClaim(payable('mock-fee'));
  await ch.fetchAcknowledgements();
  const [{ remittance: r }] = await ch.fetchRemittances();
  // Allowed is 9000 + 1000 = 10000; the copay is 2500; paid 7500; contractual 11000.
  assert.equal(r.claims[0].paidCents, 7500);
  assert.equal(r.claims[0].patientResponsibilityCents, 2500);
  assert.deepEqual(remittanceProblems(r), []);

  const small = [
    { code: '99214', description: 'x', chargeCents: 15000, allowedCents: { [COMMERCIAL.id]: 1000 } },
    { code: '90833', description: 'x', chargeCents: 6000, allowedCents: { [COMMERCIAL.id]: 1000 } },
  ];
  const ch2 = workerMock(small);
  await ch2.submitClaim(payable('mock-small'));
  await ch2.fetchAcknowledgements();
  const [{ remittance: r2 }] = await ch2.fetchRemittances();
  assert.equal(r2.claims[0].patientResponsibilityCents, 2000, 'copay is capped at the allowed amount');
  assert.equal(r2.claims[0].paidCents, 0);
  assert.deepEqual(remittanceProblems(r2), []);
});

test('the mock rejects REJ members with a message and sends no remittance for them', async () => {
  const ch = workerMock();
  const sent = await ch.submitClaim(payable('mock-rej', 'REJ0001'));
  const acks = await ch.fetchAcknowledgements();
  assert.equal(acks.length, 1);
  assert.equal(acks[0].clearinghouseId, sent.clearinghouseId);
  assert.equal(acks[0].accepted, false);
  assert.ok(acks[0].messages.length > 0);
  assert.deepEqual(await ch.fetchRemittances(), []);
});

test('the mock sends DENY members a CO-27 denial of the whole charge with nothing paid', async () => {
  const ch = workerMock();
  await ch.submitClaim(payable('mock-deny', 'DENY0001'));
  await ch.fetchAcknowledgements();
  const [{ remittance: r }] = await ch.fetchRemittances();
  const c = r.claims[0];
  assert.equal(c.statusCode, '4');
  assert.equal(c.paidCents, 0);
  assert.deepEqual(c.adjustments, [{ group: 'CO', reason: '27', cents: 21000 }]);
  assert.deepEqual(remittanceProblems(r), []);
  const plan = remittancePlan(r, (pcn) => ({ claimRef: `Claim/${pcn}`, patientRef: 'Patient/patient-1', payerRef: r.payerId }), PLAN_OPTS);
  assert.equal(plan.denials.length, 1);
  assert.equal(plan.denials[0].category, 'eligibility');
  assert.deepEqual(plan.journals, []);
});

test('the mock submission is idempotent per claim, and each claim is remitted once', async () => {
  const ch = workerMock();
  const first = await ch.submitClaim(payable('mock-once'));
  const second = await ch.submitClaim(payable('mock-once'));
  assert.equal(first.clearinghouseId, second.clearinghouseId);
  await ch.fetchAcknowledgements();
  assert.equal((await ch.fetchRemittances()).length, 1);
  assert.deepEqual(await ch.fetchRemittances(), [], 'nothing is remitted twice');
});

test('the mock eligibility answers INACTIVE members inactive and others active with copay and both benefits covered', async () => {
  const ch = workerMock();
  const req = { payer: COMMERCIAL, subscriber: { given: 'Synthetic', family: 'Patient' }, serviceDate: '2026-10-10' };
  const inactive = await ch.checkEligibility({ ...req, memberId: 'INACTIVE01' });
  assert.equal(inactive.active, false);
  assert.deepEqual(inactive.errors, []);
  assert.equal(eligibilitySummary(inactive).status, 'inactive');
  const active = await ch.checkEligibility({ ...req, memberId: 'SYN123456789' });
  assert.equal(active.active, true);
  assert.equal(active.copayCents, 2500);
  assert.equal(active.mentalHealthCovered, true);
  assert.equal(active.telehealthCovered, true);
  assert.equal(eligibilitySummary(active).status, 'active');
});

// Fixtures for claimDraftFromFhir: a telehealth visit for an active commercial member, all clean.
const NPI = '1245319599';
const TAX = '12-3456789';
function fhirFixtures(): { claim: Claim; patient: Patient; coverage: Coverage; rendering: Practitioner; billing: Organization; chargeItems: ChargeItem[]; encounter: Encounter } {
  const chargeLine = { code: '90792', modifiers: ['95'], units: 1, diagnosisPointers: [1], chargeCents: 25000, pos: '10' };
  const chargeItem = {
    resourceType: 'ChargeItem', id: 'ci-1', status: 'billed',
    code: { coding: [{ code: '90792' }] },
    subject: { reference: 'Patient/pat-1' },
    context: { reference: 'Encounter/enc-1' },
    occurrenceDateTime: '2026-10-10T15:00:00Z',
    priceOverride: { value: 250, currency: 'USD' },
    extension: [{ url: REVENUE_EXT.chargeLine, valueString: JSON.stringify(chargeLine) }],
  } as unknown as ChargeItem;
  const claim = {
    resourceType: 'Claim', id: 'claim-1', status: 'active', use: 'claim', created: '2026-10-10',
    type: { coding: [{ code: 'professional' }] },
    patient: { reference: 'Patient/pat-1' },
    provider: { reference: 'Practitioner/prac-1' },
    billablePeriod: { start: '2026-10-10T15:00:00Z' },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: 'Coverage/cov-1' } }],
    diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ code: 'F41.1' }] } }],
    item: [{ sequence: 1, productOrService: { coding: [{ code: '90792' }] }, extension: [{ url: REVENUE_EXT.chargeItem, valueReference: { reference: 'ChargeItem/ci-1' } }] }],
    extension: [{ url: REVENUE_EXT.billingPayer, valueString: COMMERCIAL.id }],
  } as unknown as Claim;
  const patient = {
    resourceType: 'Patient', id: 'pat-1', name: [{ family: 'Rivera', given: ['Ana'] }], birthDate: '1990-05-04', gender: 'female',
    address: [{ line: ['1 Main St'], city: 'Seattle', state: 'WA', postalCode: '98101-1234' }],
  } as unknown as Patient;
  const coverage = {
    resourceType: 'Coverage', id: 'cov-1', status: 'active', beneficiary: { reference: 'Patient/pat-1' },
    subscriberId: 'MEM1234', relationship: { coding: [{ code: 'self' }] }, period: { start: '2026-01-01' },
    payor: [{ identifier: { system: PAYER_IDENTIFIER_SYSTEM, value: COMMERCIAL.id } }],
    class: [{ type: { coding: [{ code: 'group' }] }, value: 'GRP9' }],
  } as unknown as Coverage;
  const rendering = {
    resourceType: 'Practitioner', id: 'prac-1',
    identifier: [{ system: NPI_SYSTEM, value: NPI }],
    qualification: [{ code: { coding: [{ system: CODE_SYSTEMS.qualificationType, code: 'state-license' }] }, identifier: [{ system: `${CODE_SYSTEMS.qualificationType}/wa`, value: 'MD-1' }], period: { start: '2020-01-01' } }],
  } as unknown as Practitioner;
  const billing = {
    resourceType: 'Organization', id: 'org-1', name: 'Practice',
    identifier: [{ system: NPI_SYSTEM, value: NPI }, { system: 'urn:oid:2.16.840.1.113883.4.4', value: TAX }],
  } as unknown as Organization;
  const encounter = { resourceType: 'Encounter', id: 'enc-1', status: 'finished', class: { code: 'VR' }, extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }] } as unknown as Encounter;
  return { claim, patient, coverage, rendering, billing, chargeItems: [chargeItem], encounter };
}

test('claimDraftFromFhir maps NPI, tax ID, member, group, location and dates, and the result scrubs clean', () => {
  const f = fhirFixtures();
  const draft = claimDraftFromFhir(f);
  assert.equal(draft.id, 'claim-1');
  assert.equal(draft.providers.rendering.npi, NPI);
  assert.deepEqual(draft.providers.rendering.licensedStates, ['WA']);
  assert.equal(draft.providers.billing.npi, NPI);
  assert.equal(draft.providers.billing.taxId, TAX);
  assert.equal(draft.coverage.payerId, COMMERCIAL.id);
  assert.equal(draft.coverage.memberId, 'MEM1234');
  assert.equal(draft.coverage.groupNumber, 'GRP9');
  assert.equal(draft.coverage.periodStart, '2026-01-01');
  assert.equal(draft.patient.address?.zip, '981011234', 'ZIP+4 goes out without the hyphen');
  assert.equal(draft.subscriber.relationship, 'self');
  assert.equal(draft.serviceDate, '2026-10-10');
  assert.equal(draft.placeOfService, '10');
  assert.equal(draft.patientLocationState, 'WA');
  assert.equal(draft.lines[0].chargeCents, 25000);
  assert.equal(draft.frequencyCode, '1');
  assert.deepEqual(scrubClaim(draft, { today: TODAY, payer: COMMERCIAL, fees: FEES }), []);
});

test('claimDraftFromFhir leaves the NPI empty when the rendering provider has none, and the scrub refuses', () => {
  const f = fhirFixtures();
  const draft = claimDraftFromFhir({ ...f, rendering: { ...f.rendering, identifier: [] } as Practitioner });
  assert.equal(draft.providers.rendering.npi, undefined);
  assert.ok(scrubClaim(draft, { today: TODAY, payer: COMMERCIAL, fees: FEES }).some((x) => x.ruleId === 'SCR-001'));
});

test('the claim names its payer, and falls back to the coverage payer only when the claim has none', () => {
  const f = fhirFixtures();
  assert.equal(claimDraftFromFhir(f).coverage.payerId, COMMERCIAL.id, 'the claim wins when both are set');
  const noClaimPayer = { ...f, claim: { ...f.claim, extension: [] } as Claim };
  assert.equal(claimDraftFromFhir(noClaimPayer).coverage.payerId, COMMERCIAL.id, 'coverage payer is used when the claim has none');
  const mismatch = { ...f, claim: { ...f.claim, extension: [{ url: REVENUE_EXT.billingPayer, valueString: MEDICARE.id }] } as Claim };
  assert.equal(claimDraftFromFhir(mismatch).coverage.payerId, MEDICARE.id);
});

test('charge cents from priceOverride are whole cents for every price, and absent prices stay absent', () => {
  for (const value of [0.01, 0.1, 0.29, 19.99, 85, 99.995, 123.456, 250, 1234.56, 0.3 * 3, 999999.99]) {
    const cents = chargeItemCents({ priceOverride: { value, currency: 'USD' } } as ChargeItem);
    assert.ok(cents !== undefined && Number.isSafeInteger(cents), `${value} is whole cents`);
    assert.equal(cents, Math.round(value * 100));
  }
  assert.equal(chargeItemCents({} as ChargeItem), undefined);
  assert.equal(chargeItemCents({ priceOverride: { value: Number.NaN, currency: 'USD' } } as ChargeItem), undefined);
});

test('the ledger client carries the HTTP status and the ledger message, and sends the service headers', async () => {
  const realFetch = globalThis.fetch;
  let seen: { url: string; headers: Record<string, string> } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({ message: 'journal does not balance' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const client = new LedgerClient('http://ledger.test', 'x'.repeat(40));
    await assert.rejects(
      () => client.postCharge({ chargeItemId: 'ci-1', version: '1', patientRef: 'Patient/pat-1', cents: 100, occurredAt: '2026-10-10T15:00:00Z' }),
      (err: unknown) => err instanceof LedgerRequestError && err.status === 400 && err.message === 'journal does not balance',
    );
    assert.equal(seen?.url, 'http://ledger.test/api/ledger/internal/charges');
    assert.equal(seen?.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
    assert.equal(seen?.headers['X-Teleemon-Service'], 'worker');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a Stedi 835 whose amounts are not dollars is refused, and a good one ties', () => {
  const good = remittanceFromStedi({
    traceNumber: 'T-1', payerId: STEDI.id, paymentDate: '2026-10-18', totalPaid: '143.00',
    claims: [{ patientControlNumber: 'c1', payerClaimControl: 'p1', statusCode: '1', chargeAmount: '210.00', paidAmount: '143.00', patientResponsibilityAmount: '25.00', adjustments: [{ group: 'CO', reason: '45', amount: '42.00' }, { group: 'PR', reason: '3', amount: '25.00' }] }],
  });
  assert.deepEqual(remittanceProblems(good), []);
  assert.throws(() => remittanceFromStedi({ traceNumber: 'T-2', payerId: STEDI.id, paymentDate: '2026-10-18', totalPaid: 'about 100', claims: [] }), /not a dollar amount/);
});

test('journals rebuilt from ledger entries give the statement its balance, and only patient lines count', () => {
  const entries = [
    { journalId: '1', idempotencyKey: 'charge:ci-1:1', kind: 'charge' as const, occurredAt: '2026-10-10T12:00:00Z', source: 'charge-review', reversed: false, account: { kind: 'patient_receivable' as const, patientRef: 'Patient/p1' }, cents: 8500 },
    { journalId: '1', idempotencyKey: 'charge:ci-1:1', kind: 'charge' as const, occurredAt: '2026-10-10T12:00:00Z', source: 'charge-review', reversed: false, account: { kind: 'revenue' as const }, cents: -8500 },
    { journalId: '2', idempotencyKey: 'payment:card-1', kind: 'payment' as const, occurredAt: '2026-10-11T12:00:00Z', source: 'portal', reversed: false, account: { kind: 'patient_receivable' as const, patientRef: 'Patient/p1' }, cents: -2000 },
  ];
  const journals = journalsFromEntries(entries);
  assert.equal(journals.length, 2);
  const s = statementLines('Patient/p1', journals);
  assert.equal(s.amountDueCents, 6500);
  assert.equal(s.lines.length, 2);
});

// --- Self-pay missed-visit fees (practice policy; never billed to insurance) -----------------

test('missed-visit fees come from policy, default to none, and post once per appointment', async () => {
  const { DEFAULT_BILLING: defaults, visitFeeCents: feeFor, visitFeeJournal: feeJournal, journalProblem: problem } = await import('@teleemon/core');
  assert.equal(feeFor(defaults.policy, 'no-show'), 0, 'no fee until the practice sets one');
  assert.equal(feeFor({ ...defaults.policy, noShowFeeCents: 7500 }, 'no-show'), 7500);
  assert.equal(feeFor({ ...defaults.policy, lateCancelFeeCents: undefined }, 'late-cancel'), 0, 'older saved settings without the field mean no fee');
  const j = feeJournal({ appointmentId: 'appt-1', patientRef: 'Patient/p1', cents: 7500, kind: 'no-show', postedBy: 'Practitioner/fd', occurredAt: '2026-10-18T16:00:00Z' });
  assert.equal(j.idempotencyKey, 'fee:appt-1');
  assert.equal(problem(j), undefined);
  assert.deepEqual(j.lines.map((l) => [l.account.kind, l.cents]), [['patient_receivable', 7500], ['revenue', -7500]]);
  assert.ok(!j.lines.some((l) => l.account.kind === 'insurance_receivable'), 'never billed to insurance');
  assert.throws(() => feeJournal({ appointmentId: 'appt-2', patientRef: 'Patient/p1', cents: 0, kind: 'late-cancel', postedBy: 'x', occurredAt: '2026-10-18T16:00:00Z' }), /positive/);
});
