// Revenue cycle worker step (Phase 8, SYSTEM-DESIGN §3). Each pass runs these in order, and each
// is idempotent, so a crash or a retry never double-posts money or double-submits a claim:
//   a. charges      billable ChargeItems post to the ledger; EXT.ledgerJournal records the key
//   b. submission   scrub-clean submitted Claims go to the clearinghouse; the id is recorded
//   c. acks         277CA acknowledgements become ClaimResponses; rejections become Tasks
//   d. remittances  835s are kept as Binary + DocumentReference, posted to the ledger, and their
//                   claims move to paid, partially-paid or denied; exceptions and denials become Tasks
//   e. eligibility  270/271 checks for active requests, and daily requests for tomorrow's patients
//   f. statements   statement-run Tasks produce Invoices and portal notices, and refund and
//                   small-balance review Tasks
// A failure on one item becomes a biller Task (identifier-keyed, so it is opened once) and the
// pass carries on. Only a whole step failing (for example Medplum unreachable) is logged, and the
// next step still runs. Logs carry counts and ids, never names, amounts or clinical text.

import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Appointment, ChargeItem, Claim, ClaimResponse, Communication, Coverage, CoverageEligibilityRequest, CoverageEligibilityResponse, DocumentReference, Encounter, Invoice, Money, Organization, Patient, PaymentReconciliation, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import {
  BILLING_NOTICE_CATEGORY, BILLING_TASKS, chargeQueueTag, fetchClaimSources, CLEARINGHOUSE_IDENTIFIER_SYSTEM, CODE_SYSTEMS, GENERATED_IDENTIFIER_SYSTEM, REMITTANCE_IDENTIFIER_SYSTEM, REVENUE_EXT, TELEEMON_BASE,
  addCalendarDays, chargeItemCents, claimDraftFromFhir, claimPayerId, claimStatusOf, claimTransitionProblem, eligibilitySummary, formatCents,
  payerIdOf, readSettings, refundReviewDue, remittancePlan, scrubClaim, scrubClean, scrubCurrentAndClean, searchAll, smallBalanceCandidate,
  statementDue, statementLines, teamCoding,
} from '@teleemon/core';
import type { BillingSettings, ClaimDraft, ClaimSources, ClaimStatus, EligibilityResult, JournalDraft, JournalLine, PayerConfig, Remittance, RemitLookup } from '@teleemon/core';
import type { Clearinghouse, ClaimAcknowledgement, RemittanceEnvelope } from './clearinghouse';
import type { ClaimProjectionJob, LedgerClient, LedgerEntry, RemittanceRecord } from './ledgerClient';
import { transportsFromEnv } from './transport';

/** Biller Task for a failure that no specific queue covers (charge posting, a write-back, a statement). */
export const BILLING_ERROR_CODE = BILLING_TASKS.billingError;
/** Carries the eligibility result for a CoverageEligibilityResponse (no clean FHIR mapping for it). */
export const ELIGIBILITY_RESULT_EXT = REVENUE_EXT.eligibilityResult;
/** Communication category for the portal notice that a statement is ready. */
export const STATEMENT_NOTICE_CATEGORY = BILLING_NOTICE_CATEGORY;
const STATEMENT_NOTICE_TEXT = 'You have a new statement in your portal';

export interface BillingCounts {
  charges: number;
  submitted: number;
  submissionsRefused: number;
  acknowledged: number;
  rejected: number;
  remittances: number;
  denials: number;
  exceptions: number;
  eligibilityChecks: number;
  eligibilityRequestsQueued: number;
  statements: number;
  statementNotices: number;
  refundReviews: number;
  smallBalances: number;
  failures: number;
}

const emptyCounts = (): BillingCounts => ({
  charges: 0, submitted: 0, submissionsRefused: 0, acknowledged: 0, rejected: 0, remittances: 0, denials: 0, exceptions: 0,
  eligibilityChecks: 0, eligibilityRequestsQueued: 0, statements: 0, statementNotices: 0, refundReviews: 0, smallBalances: 0, failures: 0,
});

const reason = (err: unknown): string => normalizeErrorString(err).slice(0, 300);
const money = (cents: number): Money => ({ value: cents / 100, currency: 'USD' });
const dayOf = (iso: string): string => iso.slice(0, 10);
const bareId = (ref: string | undefined): string | undefined => ref?.split('/').pop();

/** The day the last eligibility scan ran (per process). The requests themselves are idempotent per day. */
let lastEligibilityScanDay: string | undefined;

/**
 * Scan windows. A claim is only sent while it is `submitted` without an id, and a status change
 * bumps lastUpdated, so 120 days covers every claim still awaiting its send. FHIR has no 'completed'
 * state for CoverageEligibilityRequest, so only requests from the last 7 days are re-checked.
 */
const CLAIM_SCAN_DAYS = 120;
const ELIGIBILITY_SCAN_DAYS = 7;
const daysAgo = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

// --- Entry point -------------------------------------------------------------------------------

export async function processBilling(medplum: MedplumClient, ch: Clearinghouse, ledger: LedgerClient, now: Date): Promise<BillingCounts> {
  const counts = emptyCounts();
  const today = dayOf(now.toISOString());
  const settings = await readSettings(medplum, 'billing');
  const run = (name: string, fn: () => Promise<void>) => step(name, counts, fn);

  await run('charges', () => postCharges(medplum, ledger, counts));
  await run('voided charges', () => reverseVoidedCharges(medplum, ledger, counts));
  await run('submission', () => submitClaims(medplum, ch, settings, today, now, counts));
  await run('acknowledgements', () => acknowledgements(medplum, ch, settings, now, counts));
  await run('remittances', () => remittances(medplum, ch, ledger, settings, now, counts));
  await run('manual ERA claim projections', () => processClaimProjections(medplum, ledger, now, counts));
  await run('eligibility', () => eligibility(medplum, ch, settings, today, now, counts));
  await run('statements', () => statementRuns(medplum, ledger, settings, now, counts));
  await run('statement notices', () => issuedStatementNotices(medplum, now, counts));
  return counts;
}

async function step(name: string, counts: BillingCounts, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    counts.failures++;
    console.error(`[worker] billing ${name} stopped: ${reason(err)}`);
  }
}

// --- Tasks -------------------------------------------------------------------------------------

interface TaskSpec {
  readonly code: string;
  /** Unique within the code. Same key, same Task: that is what makes every step idempotent. */
  readonly key: string;
  readonly text: string;
  readonly description: string;
  readonly now: Date;
  readonly focus?: Reference;
  readonly patient?: Reference;
  readonly priority?: Task['priority'];
  readonly note?: string;
  readonly input?: { trace?: string; patientControlNumber?: string };
  /** Appeal deadline (YYYY-MM-DD). Also the Task's restriction end, so it shows as overdue. */
  readonly appealDeadline?: string;
}

/** Opens a biller Task once per (code, key). Returns true when it was created by this call. */
export async function openTask(medplum: MedplumClient, spec: TaskSpec): Promise<boolean> {
  const value = `${spec.code}:${spec.key}`;
  const query = { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${value}` };
  if (await medplum.searchOne('Task', query, { cache: 'no-cache' })) return false;
  const task: Task = {
    resourceType: 'Task',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value }],
    status: 'requested',
    intent: 'order',
    priority: spec.priority ?? 'routine',
    code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: spec.code }], text: spec.text },
    description: spec.description.slice(0, 500),
    focus: spec.focus,
    for: spec.patient,
    performerType: teamCoding('biller'),
    authoredOn: spec.now.toISOString(),
    note: spec.note ? [{ text: spec.note.slice(0, 2000), time: spec.now.toISOString() }] : undefined,
    input: spec.input
      ? [
          ...(spec.input.trace ? [{ type: { text: 'trace number' }, valueString: spec.input.trace }] : []),
          ...(spec.input.patientControlNumber ? [{ type: { text: 'patient control number' }, valueString: spec.input.patientControlNumber }] : []),
        ]
      : undefined,
    restriction: spec.appealDeadline ? { period: { end: `${spec.appealDeadline}T23:59:59Z` } } : undefined,
    extension: spec.appealDeadline ? [{ url: REVENUE_EXT.appealDeadline, valueDate: spec.appealDeadline }] : undefined,
  };
  await medplum.createResourceIfNoneExist(task, new URLSearchParams(query).toString());
  return true;
}

// --- Write helpers -----------------------------------------------------------------------------

/**
 * Updates with the optimistic-lock header. On a version conflict it re-reads and reapplies the
 * change, so `mutate` must be safe to run twice (filter the old value, then add the new one).
 */
async function patch<T extends Claim | ChargeItem | Task>(medplum: MedplumClient, resource: T, mutate: (r: T) => T): Promise<T> {
  let current = resource;
  for (let attempt = 0; ; attempt++) {
    try {
      return (await medplum.updateResource(mutate(current), { headers: { 'If-Match': `W/"${current.meta?.versionId}"` } })) as T;
    } catch (err) {
      if (attempt >= 2) throw err;
      current = (await medplum.readResource(resource.resourceType as 'Claim' | 'ChargeItem' | 'Task', resource.id as string, { cache: 'no-cache' })) as T;
    }
  }
}

const claimStatusExt = (status: ClaimStatus) => ({ url: REVENUE_EXT.claimStatus, valueCode: status });

async function setClaimStatus(medplum: MedplumClient, claim: Claim, to: ClaimStatus): Promise<boolean> {
  const from = claimStatusOf(claim);
  if (claimTransitionProblem(from, to)) return false;
  await patch(medplum, claim, (c) => ({ ...c, extension: [...(c.extension ?? []).filter((e) => e.url !== REVENUE_EXT.claimStatus), claimStatusExt(to)] }));
  return true;
}

// --- a. Charges --------------------------------------------------------------------------------

async function postCharges(medplum: MedplumClient, ledger: LedgerClient, counts: BillingCounts): Promise<void> {
  const billable = await searchAll(medplum, 'ChargeItem', { _tag: chargeQueueTag('ledger-pending'), _count: '100' });
  for (const c of billable) {
    if (c.extension?.some((e) => e.url === REVENUE_EXT.ledgerJournal)) continue;
    try {
      await postCharge(medplum, ledger, c);
      counts.charges++;
    } catch (err) {
      counts.failures++;
      await openTask(medplum, {
        code: BILLING_ERROR_CODE, key: `charge:${c.id}`, text: 'Charge not posted', description: `A billable charge could not be posted to the ledger: ${reason(err)}`,
        now: new Date(), focus: { reference: `ChargeItem/${c.id}` }, patient: c.subject, priority: 'urgent',
      });
    }
  }
}

async function postCharge(medplum: MedplumClient, ledger: LedgerClient, c: ChargeItem): Promise<void> {
  const cents = chargeItemCents(c);
  if (cents === undefined || !Number.isSafeInteger(cents) || cents <= 0) throw new Error('the charge has no positive whole-cent price');
  const patientRef = c.subject?.reference;
  if (!patientRef?.startsWith('Patient/')) throw new Error('the charge is not for a patient');
  const version = c.meta?.versionId;
  if (!version) throw new Error('the charge has no version');
  const occurredAt = c.occurrenceDateTime;
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) throw new Error('the charge has no date of service');
  const payer = c.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString;
  const payerRef = payer && payer !== 'self-pay' ? payer : undefined;
  const encounterRef = c.context?.reference?.startsWith('Encounter/') ? c.context.reference : undefined;
  const key = `charge:${c.id}:${version}`;
  const results = await ledger.postCharge({ chargeItemId: c.id as string, version, patientRef, payerRef, cents, occurredAt, encounterRef, postedFrom: 'charge-review' });
  if (!results.some((r) => r.idempotencyKey === key)) throw new Error('the ledger did not return the charge journal');
  // Written back after posting. If this fails the next pass posts the same key again, which the ledger treats as a replay.
  await patch(medplum, c, (x) => ({ ...x, extension: [...(x.extension ?? []).filter((e) => e.url !== REVENUE_EXT.ledgerJournal), { url: REVENUE_EXT.ledgerJournal, valueString: key }] }));
}

/** A posted charge later entered in error is reversed in the ledger, once. */
async function reverseVoidedCharges(medplum: MedplumClient, ledger: LedgerClient, counts: BillingCounts): Promise<void> {
  const voided = await searchAll(medplum, 'ChargeItem', { _tag: chargeQueueTag('reversal-pending'), _count: '100' });
  for (const c of voided) {
    const key = c.extension?.find((e) => e.url === REVENUE_EXT.ledgerJournal)?.valueString;
    if (!key || c.extension?.some((e) => e.url === REVENUE_EXT.ledgerReversal)) continue;
    try {
      const why = c.extension?.find((e) => e.url === REVENUE_EXT.holdReason)?.valueString ?? 'Charge entered in error';
      const result = await ledger.reverse(key, `ChargeItem/${c.id} entered in error: ${why}`.slice(0, 500));
      await patch(medplum, c, (x) => ({ ...x, extension: [...(x.extension ?? []), { url: REVENUE_EXT.ledgerReversal, valueString: result.idempotencyKey }] }));
      counts.charges++;
    } catch (err) {
      counts.failures++;
      await openTask(medplum, {
        code: BILLING_ERROR_CODE, key: `reverse:${c.id}`, text: 'Charge not reversed', description: `A voided charge could not be reversed in the ledger: ${reason(err)}`,
        now: new Date(), focus: { reference: `ChargeItem/${c.id}` }, patient: c.subject, priority: 'urgent',
      });
    }
  }
}

// --- b. Submission -----------------------------------------------------------------------------

/** Everything the claim builder needs, fetched by reference. Missing pieces are left out, so the scrubber reports them. */
const claimSources = fetchClaimSources;

async function submitClaims(medplum: MedplumClient, ch: Clearinghouse, settings: BillingSettings, today: string, now: Date, counts: BillingCounts): Promise<void> {
  // claimStatus is an extension, not a search parameter, so active claims are read and filtered here.
  const active = await searchAll(medplum, 'Claim', { status: 'active', _lastUpdated: `ge${daysAgo(now, CLAIM_SCAN_DAYS)}`, _count: '100' });
  for (const claim of active) {
    if (claimStatusOf(claim) !== 'submitted') continue;
    if (claim.identifier?.some((i) => i.system === CLEARINGHOUSE_IDENTIFIER_SYSTEM)) continue;
    try {
      await submitOne(medplum, ch, claim, settings, today, now, counts);
    } catch (err) {
      counts.failures++;
      await openTask(medplum, { code: BILLING_ERROR_CODE, key: `submit:${claim.id}`, text: 'Claim not sent', description: `The claim could not be sent: ${reason(err)}`, now, focus: { reference: `Claim/${claim.id}` }, priority: 'urgent' });
    }
  }
}

async function refuseClaim(medplum: MedplumClient, claim: Claim, now: Date, problems: string[], counts: BillingCounts): Promise<void> {
  counts.submissionsRefused++;
  await openTask(medplum, {
    code: BILLING_TASKS.claimRejected, key: `unsent:${claim.id}`, text: 'Claim not sent', description: 'The claim was not sent: it is not scrubbed clean.',
    now, focus: { reference: `Claim/${claim.id}` }, patient: claim.patient, priority: 'urgent', note: problems.join('\n') || 'Scrub the claim again before sending.',
  });
}

async function submitOne(medplum: MedplumClient, ch: Clearinghouse, claim: Claim, settings: BillingSettings, today: string, now: Date, counts: BillingCounts): Promise<void> {
  if (!scrubCurrentAndClean(claim)) {
    await refuseClaim(medplum, claim, now, ['The scrub result does not match the claim as it is now, or it has errors.'], counts);
    return;
  }
  const sources = await claimSources(medplum, claim);
  const draft: ClaimDraft = claimDraftFromFhir(sources);
  const payer: PayerConfig | undefined = settings.payers.find((p) => p.id === draft.coverage.payerId);
  // Scrub again against today's settings: a payer or fee change since the stamp must still block the send.
  const findings = scrubClaim(draft, { today, payer, fees: settings.fees, disabledRules: settings.disabledScrubRules });
  if (!payer || !scrubClean(findings)) {
    await refuseClaim(medplum, claim, now, [payer ? '' : `Payer ${draft.coverage.payerId} is not configured.`, ...findings.map((f) => `${f.ruleId}: ${f.message}`)].filter(Boolean), counts);
    return;
  }
  const { clearinghouseId } = await ch.submitClaim({ ...draft, payer });
  try {
    await patch(medplum, claim, (c) => ({ ...c, identifier: [...(c.identifier ?? []).filter((i) => i.system !== CLEARINGHOUSE_IDENTIFIER_SYSTEM), { system: CLEARINGHOUSE_IDENTIFIER_SYSTEM, value: clearinghouseId }] }));
  } catch (err) {
    // The claim is out but its id is not recorded: a resend would be a duplicate, so a person must look.
    await openTask(medplum, {
      code: BILLING_ERROR_CODE, key: `unrecorded:${claim.id}`, text: 'Claim sent, id not recorded', priority: 'urgent', now, focus: { reference: `Claim/${claim.id}` },
      description: `The claim was sent to the clearinghouse but its id could not be saved (${reason(err)}). Do not resend it until this is checked.`,
    });
    throw err;
  }
  for (const ci of sources.chargeItems) {
    if (ci.status !== 'billable') continue;
    await patch(medplum, ci, (c) => ({ ...c, status: 'billed' }));
  }
  counts.submitted++;
}

// --- c. Acknowledgements -----------------------------------------------------------------------

async function acknowledgements(medplum: MedplumClient, ch: Clearinghouse, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  for (const ack of await ch.fetchAcknowledgements()) {
    const claim = await medplum.searchOne('Claim', { identifier: `${CLEARINGHOUSE_IDENTIFIER_SYSTEM}|${ack.clearinghouseId}` }, { cache: 'no-cache' });
    if (!claim) {
      counts.failures++;
      await openTask(medplum, { code: BILLING_ERROR_CODE, key: `unmatched-ack:${ack.clearinghouseId}`, text: 'Acknowledgement not matched', description: 'An acknowledgement came back for a submission we cannot match to a claim.', now, priority: 'urgent' });
      continue;
    }
    try {
      await applyAck(medplum, claim, ack, settings, now, counts);
    } catch (err) {
      counts.failures++;
      console.error(`[worker] billing acknowledgement ${ack.clearinghouseId}: ${reason(err)}`);
    }
  }
}

async function applyAck(medplum: MedplumClient, claim: Claim, ack: ClaimAcknowledgement, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  const key = `ack:${ack.clearinghouseId}`;
  const payerName = settings.payers.find((p) => p.id === claimPayerId(claim, undefined))?.name ?? 'Payer';
  const response: ClaimResponse = {
    resourceType: 'ClaimResponse',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: key }],
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    request: { reference: `Claim/${claim.id}` },
    patient: claim.patient,
    created: now.toISOString(),
    insurer: { display: payerName },
    outcome: ack.accepted ? 'complete' : 'error',
    disposition: ack.accepted ? 'Accepted by the clearinghouse (277CA)' : 'Rejected by the clearinghouse (277CA)',
    processNote: ack.messages.length ? ack.messages.map((text) => ({ text: text.slice(0, 500) })) : undefined,
  };
  await medplum.createResourceIfNoneExist(response, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${key}` }).toString());
  counts.acknowledged++;
  const target: ClaimStatus = ack.accepted ? 'accepted' : 'rejected';
  if (claimStatusOf(claim) === 'submitted') await setClaimStatus(medplum, claim, target);
  if (!ack.accepted) {
    counts.rejected++;
    await openTask(medplum, {
      code: BILLING_TASKS.claimRejected, key, text: 'Claim rejected', now, focus: { reference: `Claim/${claim.id}` }, patient: claim.patient, priority: 'urgent',
      description: 'The clearinghouse rejected this claim. Correct it and send it again.', note: ack.messages.join('\n') || 'No reason was given.',
    });
  }
}

// --- d. Remittances (835) ----------------------------------------------------------------------

/** Tag on a stored 835 that has not been fully applied yet; removed as the last step. */
const ERA_PENDING = { system: CODE_SYSTEMS.billing, code: 'era-pending' };

/**
 * Keeps the raw 835 and its normalized form as Binaries on one DocumentReference with no patient
 * (it covers several), tagged pending until every step has run. Idempotent by trace number.
 */
async function storeRaw(medplum: MedplumClient, env: RemittanceEnvelope, now: Date): Promise<DocumentReference> {
  const trace = env.remittance.traceNumber;
  const identifier = `${GENERATED_IDENTIFIER_SYSTEM}|era-raw:${trace}`;
  const existing = await medplum.searchOne('DocumentReference', { identifier }, { cache: 'no-cache' });
  if (existing) return existing;
  const binary = await medplum.createBinary(env.raw, `era-${trace}.json`, 'application/json');
  const normalized = await medplum.createBinary(JSON.stringify(env.remittance), `era-${trace}-normalized.json`, 'application/json');
  const doc: DocumentReference = {
    resourceType: 'DocumentReference',
    meta: { tag: [ERA_PENDING] },
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: `era-raw:${trace}` }],
    status: 'current',
    type: { coding: [{ system: CODE_SYSTEMS.billing, code: 'era' }] },
    category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'billing', display: 'Billing' }] }],
    date: now.toISOString(),
    description: `Electronic remittance advice ${trace}`,
    content: [
      { attachment: { url: `Binary/${binary.id}`, contentType: 'application/json', title: `era-${trace}.json` } },
      { attachment: { url: `Binary/${normalized.id}`, contentType: 'application/json', title: `era-${trace}-normalized.json` } },
    ],
  };
  return medplum.createResource(doc);
}

/** Re-applies 835s stored earlier but not finished (a crash or failure after storing). */
async function pendingRemittances(medplum: MedplumClient): Promise<RemittanceEnvelope[]> {
  const docs = await medplum.searchResources('DocumentReference', { _tag: `${ERA_PENDING.system}|${ERA_PENDING.code}`, _count: '50' }, { cache: 'no-cache' });
  const out: RemittanceEnvelope[] = [];
  for (const doc of docs) {
    const [raw, normalized] = doc.content.map((c) => c.attachment.url ?? '');
    if (!raw || !normalized) continue;
    const text = async (url: string) => (await medplum.download(url)).text();
    out.push({ raw: await text(raw), remittance: JSON.parse(await text(normalized)) as Remittance });
  }
  return out;
}

async function remittances(medplum: MedplumClient, ch: Clearinghouse, ledger: LedgerClient, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  const pending = await pendingRemittances(medplum);
  const fresh = (await ch.fetchRemittances()).filter((e) => !pending.some((p) => p.remittance.traceNumber === e.remittance.traceNumber));
  for (const env of [...pending, ...fresh]) {
    try {
      await applyRemittance(medplum, ledger, env, settings, now, counts);
      counts.remittances++;
    } catch (err) {
      counts.failures++;
      const trace = env.remittance.traceNumber;
      await openTask(medplum, {
        code: BILLING_TASKS.eraException, key: `remittance:${trace}`, text: 'Remittance not posted', priority: 'urgent', now,
        description: `The 835 could not be posted; it is retried automatically: ${reason(err)}`, input: { trace },
      });
    }
  }
}

/**
 * Applies durable claim-status projections created by staff-entered ERA journals. The ledger owns
 * the money transaction; FHIR is updated with an If-Match write, then and only then is the outbox
 * job acknowledged. A crash between those steps is safe: the next pass sees the target status and
 * acknowledges the same job without writing again.
 */
export async function processClaimProjections(medplum: MedplumClient, ledger: LedgerClient, now: Date, counts: BillingCounts): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await ledger.pendingClaimProjections(cursor);
    if (!page || !Array.isArray(page.jobs)) throw new Error('ledger returned an invalid claim projection page');
    for (const job of page.jobs) {
      try {
        await projectClaimStatus(medplum, ledger, job, now);
      } catch (err) {
        counts.failures++;
        try {
          await openProjectionTask(medplum, job, now, `The claim status update failed and will be retried automatically: ${reason(err)}`);
        } catch (taskErr) {
          console.error(`[worker] could not open ERA projection task ${String(job?.id ?? 'unknown')}: ${reason(taskErr)}`);
        }
      }
    }
    const next = page.nextCursor;
    if (next !== undefined) {
      if (!next || seenCursors.has(next)) throw new Error('ledger repeated a claim projection cursor');
      seenCursors.add(next);
    }
    cursor = next;
  } while (cursor);
}

async function projectClaimStatus(
  medplum: MedplumClient,
  ledger: LedgerClient,
  job: ClaimProjectionJob,
  now: Date,
): Promise<void> {
  const claimMatch = job.claimRef.match(/^Claim\/([A-Za-z0-9.-]{1,64})$/);
  if (!claimMatch || !job.id || !job.sourceKey || !job.journalId || !['paid', 'partially-paid'].includes(job.targetStatus) || !Number.isFinite(Date.parse(job.occurredAt))) {
    throw new Error('ledger returned an incomplete claim projection job');
  }

  const claim = await medplum.readResource('Claim', claimMatch[1], { cache: 'no-cache' });
  const current = claimStatusOf(claim);

  if (job.reversed) {
    // Reversals remain a human decision. Alert the biller, but never re-open or reverse a claim here.
    await openProjectionTask(medplum, job, now, 'The ledger payment was reversed. Review the claim status and any related payer response.', claim.patient);
    await ledger.completeClaimProjection(job.id);
    return;
  }

  if (current === job.targetStatus) {
    await completeProjectionTask(medplum, job, now);
    await ledger.completeClaimProjection(job.id);
    return;
  }

  if (current === 'closed') {
    await openProjectionTask(medplum, job, now, 'The ledger recorded an ERA payment for a closed claim. Review the payment and claim manually.', claim.patient);
    await ledger.completeClaimProjection(job.id);
    return;
  }

  // A denied claim needs a biller/provider decision first. Keep its job pending so that an approved
  // appeal can later move through the existing denied -> appealed -> paid/partially-paid workflow.
  if (current === 'denied') {
    await openProjectionTask(medplum, job, now, 'The claim is denied. Review the ERA and appeal decision before changing the claim status.', claim.patient);
    return;
  }

  const jobTime = Date.parse(job.occurredAt);
  const claimUpdateTime = Date.parse(claim.meta?.lastUpdated ?? '');
  if (current !== 'appealed' && Number.isFinite(claimUpdateTime) && claimUpdateTime >= jobTime) {
    // The Claim changed after this ledger event. Do not replace a newer payer or staff decision.
    await openProjectionTask(medplum, job, now, 'The claim changed after this ERA posting. Review the newer claim decision before applying the ledger status.', claim.patient);
    return;
  }

  const transitionProblem = claimTransitionProblem(current, job.targetStatus);
  if (transitionProblem) {
    await openProjectionTask(medplum, job, now, `The claim cannot move from ${current} to ${job.targetStatus}. Review the ERA and update the claim manually.`, claim.patient);
    return;
  }

  const version = claim.meta?.versionId;
  if (!claim.id || !version) throw new Error('claim is missing its id or FHIR version for a conditional update');
  const updated = await medplum.updateResource({
    ...claim,
    extension: [...(claim.extension ?? []).filter((e) => e.url !== REVENUE_EXT.claimStatus), claimStatusExt(job.targetStatus)],
  }, { headers: { 'If-Match': `W/"${version}"` } });
  if (claimStatusOf(updated) !== job.targetStatus) throw new Error('FHIR did not save the requested claim status');
  await completeProjectionTask(medplum, job, now);
  await ledger.completeClaimProjection(job.id);
}

async function openProjectionTask(
  medplum: MedplumClient,
  job: ClaimProjectionJob,
  now: Date,
  description: string,
  patient?: Reference,
): Promise<void> {
  const claimId = job.claimRef.match(/^Claim\/([A-Za-z0-9.-]{1,64})$/)?.[1];
  const trace = typeof job.sourceKey === 'string' ? job.sourceKey.match(/^era:([^:]{1,80}):/)?.[1] : undefined;
  await openTask(medplum, {
    code: BILLING_TASKS.eraException,
    key: `claim-projection:${job.id}`,
    text: 'ERA claim status needs review',
    description,
    now,
    focus: claimId ? { reference: `Claim/${claimId}` } : undefined,
    patient,
    priority: 'urgent',
    input: { trace, patientControlNumber: claimId },
  });
}

async function completeProjectionTask(
  medplum: MedplumClient,
  job: ClaimProjectionJob,
  now: Date,
): Promise<void> {
  const key = `${BILLING_TASKS.eraException}:claim-projection:${job.id}`;
  const task = await medplum.searchOne('Task', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${key}` }, { cache: 'no-cache' });
  if (!task || !['requested', 'received', 'accepted', 'in-progress'].includes(task.status)) return;
  const version = task.meta?.versionId;
  if (!version) throw new Error('claim projection review Task is missing its FHIR version');
  await medplum.updateResource({
    ...task,
    status: 'completed',
    lastModified: now.toISOString(),
    note: [...(task.note ?? []), { text: 'The ledger ERA claim status was applied by the worker.', time: now.toISOString() }],
  }, { headers: { 'If-Match': `W/"${version}"` } });
}

async function applyRemittance(medplum: MedplumClient, ledger: LedgerClient, env: RemittanceEnvelope, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  const r: Remittance = env.remittance;
  const trace = r.traceNumber;
  const payer = settings.payers.find((p) => p.id === r.payerId);
  if (!payer) throw new Error(`payer ${r.payerId} is not configured in billing settings`);
  const rawDoc = await storeRaw(medplum, env, now);

  // Look up each claim by its patient control number (our Claim id) and collect what posting needs.
  const matched = new Map<string, { claim: Claim; lookup: RemitLookup }>();
  for (const rc of r.claims) {
    const claim = await medplum.readResource('Claim', rc.patientControlNumber, { cache: 'no-cache' }).catch(() => undefined);
    if (!claim) continue;
    const encounterRef = claim.item?.flatMap((i) => i.encounter ?? []).find((e) => e.reference?.startsWith('Encounter/'))?.reference;
    matched.set(rc.patientControlNumber, {
      claim,
      lookup: {
        claimRef: `Claim/${claim.id}`,
        patientRef: claim.patient.reference ?? '',
        payerRef: claim.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString ?? '',
        encounterRef,
      },
    });
  }

  const plan = remittancePlan(r, (pcn) => matched.get(pcn)?.lookup, { autoPostEra: settings.policy.autoPostEra, appealDays: payer.appealDays });

  // The ledger is posted before the PaymentReconciliation exists, so a PR's presence means the ledger has this 835.
  const existingPR = await medplum.searchOne('PaymentReconciliation', { identifier: `${REMITTANCE_IDENTIFIER_SYSTEM}|${trace}` }, { cache: 'no-cache' });
  if (!existingPR) {
    const record: RemittanceRecord = { traceNumber: trace, payerRef: r.payerId, paidCents: r.totalPaidCents, paymentDate: r.paymentDate, claimCount: r.claims.length };
    await ledger.postRemittance(record, plan.journals);
  }

  // ClaimResponse per matched claim payment (idempotent by trace and claim control number).
  const responseIds = new Map<string, string>();
  for (const rc of r.claims) {
    const hit = matched.get(rc.patientControlNumber);
    if (!hit) continue;
    const key = `era:${trace}:${rc.payerClaimControl}`;
    const response: ClaimResponse = {
      resourceType: 'ClaimResponse',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: key }],
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
      use: 'claim',
      request: { reference: `Claim/${hit.claim.id}` },
      patient: hit.claim.patient,
      created: now.toISOString(),
      insurer: { display: payer.name },
      outcome: 'complete',
      disposition: `Claim status ${rc.statusCode} on remittance ${trace}`,
      payment: { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-paymenttype', code: 'complete' }] }, amount: money(rc.paidCents) },
    };
    const saved = await medplum.createResourceIfNoneExist(response, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${key}` }).toString());
    responseIds.set(rc.patientControlNumber, saved.id as string);
  }

  // The PaymentReconciliation is the 835's record; its exceptions and denials point at it.
  const newPR: PaymentReconciliation = {
    resourceType: 'PaymentReconciliation',
    identifier: [{ system: REMITTANCE_IDENTIFIER_SYSTEM, value: trace }],
    status: 'active',
    created: now.toISOString(),
    paymentDate: r.paymentDate,
    paymentAmount: money(r.totalPaidCents),
    outcome: plan.exceptions.length ? 'partial' : 'complete',
    detail: r.claims.flatMap((rc) => {
      const hit = matched.get(rc.patientControlNumber);
      const response = responseIds.get(rc.patientControlNumber);
      if (!hit || !response) return [];
      return [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-paymenttype', code: 'payment' }] }, request: { reference: `Claim/${hit.claim.id}` }, response: { reference: `ClaimResponse/${response}` }, amount: money(rc.paidCents) }];
    }),
  };
  const pr: PaymentReconciliation = existingPR ?? (await medplum.createResource(newPR));

  // Claim statuses: posted claims move to paid or partially-paid; denied claims move to denied.
  const posted = new Set(plan.journals.map((j) => j.idempotencyKey));
  for (const d of plan.denials) {
    const claim = [...matched.values()].find((m) => m.lookup.claimRef === d.claimRef)?.claim;
    if (!claim) continue;
    if (await setClaimStatus(medplum, claim, 'denied')) counts.denials++;
    await openTask(medplum, {
      code: BILLING_TASKS.denial, key: `${trace}:${claim.id}`, text: 'Denied claim', now, focus: { reference: `Claim/${claim.id}` }, patient: claim.patient,
      priority: 'urgent', appealDeadline: d.appealDeadline,
      description: `Denied (${d.category}). Appeal by ${d.appealDeadline}.`,
      note: `${d.category}: ${d.recommendedAction} (reason codes ${d.carc.join(', ') || 'none'})`,
    });
  }
  for (const rc of r.claims) {
    const hit = matched.get(rc.patientControlNumber);
    if (!hit || plan.denials.some((d) => d.claimRef === hit.lookup.claimRef)) continue;
    if (!posted.has(`era:${trace}:${rc.payerClaimControl}`)) continue;
    const target: ClaimStatus = rc.patientResponsibilityCents === 0 ? 'paid' : 'partially-paid';
    await setClaimStatus(medplum, hit.claim, target);
  }

  // Exceptions: nothing for these claims posted. Each gets a Task on the reconciliation.
  for (const [i, ex] of plan.exceptions.entries()) {
    counts.exceptions++;
    await openTask(medplum, {
      code: BILLING_TASKS.eraException, key: `${trace}:${i}`, text: 'Remittance exception', now, focus: { reference: `PaymentReconciliation/${pr.id}` },
      patient: ex.patientControlNumber ? matched.get(ex.patientControlNumber)?.claim.patient : undefined,
      description: ex.reason.slice(0, 500), input: { trace, patientControlNumber: ex.patientControlNumber },
      priority: 'urgent',
    });
  }

  // Last step: the 835 is fully applied, so it is no longer retried.
  if (rawDoc.meta?.tag?.some((t) => t.system === ERA_PENDING.system && t.code === ERA_PENDING.code)) {
    await medplum.updateResource({ ...rawDoc, meta: { ...rawDoc.meta, tag: rawDoc.meta.tag.filter((t) => !(t.system === ERA_PENDING.system && t.code === ERA_PENDING.code)) } });
  }
}

// --- e. Eligibility ----------------------------------------------------------------------------

async function eligibility(medplum: MedplumClient, ch: Clearinghouse, settings: BillingSettings, today: string, now: Date, counts: BillingCounts): Promise<void> {
  const requests = await searchAll(medplum, 'CoverageEligibilityRequest', { status: 'active', created: `ge${daysAgo(now, ELIGIBILITY_SCAN_DAYS)}`, _count: '100' });
  for (const req of requests) {
    try {
      const answered = await medplum.searchOne('CoverageEligibilityResponse', { request: `CoverageEligibilityRequest/${req.id}` }, { cache: 'no-cache' });
      if (answered) continue;
      await checkEligibility(medplum, ch, req, settings, today, now, counts);
    } catch (err) {
      counts.failures++;
      await openTask(medplum, { code: BILLING_ERROR_CODE, key: `eligibility:${req.id}`, text: 'Eligibility not checked', description: `The eligibility check could not be completed: ${reason(err)}`, now, focus: { reference: `CoverageEligibilityRequest/${req.id}` }, patient: req.patient });
    }
  }
  if (lastEligibilityScanDay !== today) {
    await queueTomorrowsEligibility(medplum, settings, today, now, counts);
    lastEligibilityScanDay = today;
  }
}

async function checkEligibility(medplum: MedplumClient, ch: Clearinghouse, req: CoverageEligibilityRequest, settings: BillingSettings, today: string, now: Date, counts: BillingCounts): Promise<void> {
  const coverage = await medplum.readReference(req.insurance?.[0]?.coverage as Reference<Coverage>);
  const patient = await medplum.readReference(req.patient as Reference<Patient>);
  const payerId = payerIdOf(coverage) ?? '';
  const payer = settings.payers.find((p) => p.id === payerId);
  const memberId = coverage.subscriberId ?? coverage.identifier?.[0]?.value ?? '';
  const name = patient.name?.find((n) => n.use === 'official') ?? patient.name?.[0];
  let result: EligibilityResult;
  if (!payer) result = { active: false, errors: [`Payer ${payerId || '(none)'} is not configured in billing settings`] };
  else if (!memberId) result = { active: false, errors: ['The coverage has no member ID'] };
  else {
    const provider = req.provider?.reference?.startsWith('Practitioner/') ? await medplum.readReference(req.provider as Reference<Practitioner>) : undefined;
    result = await ch.checkEligibility({
      payer, memberId,
      subscriber: { given: name?.given?.[0] ?? '', family: name?.family ?? '', birthDate: patient.birthDate },
      serviceDate: req.servicedDate ?? today,
      providerNpi: provider?.identifier?.find((i) => i.system === 'http://hl7.org/fhir/sid/us-npi')?.value,
    });
    counts.eligibilityChecks++;
  }
  const summary = eligibilitySummary(result);
  const response: CoverageEligibilityResponse = {
    resourceType: 'CoverageEligibilityResponse',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: `eligibility-response:${req.id}` }],
    status: 'active',
    purpose: ['benefits'],
    patient: req.patient,
    created: now.toISOString(),
    request: { reference: `CoverageEligibilityRequest/${req.id}` },
    outcome: result.errors.length ? 'error' : 'complete',
    disposition: `Eligibility: ${summary.status}`,
    insurer: { display: payer?.name ?? (payerId || 'Payer') },
    insurance: [{ coverage: { reference: `Coverage/${coverage.id}` }, inforce: result.active }],
    extension: [{ url: ELIGIBILITY_RESULT_EXT, valueString: JSON.stringify(result) }],
  };
  await medplum.createResourceIfNoneExist(response, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|eligibility-response:${req.id}` }).toString());
  if (summary.status !== 'active') {
    await openTask(medplum, {
      code: BILLING_TASKS.eligibilityIssue, key: req.id as string, text: 'Eligibility needs attention', now, focus: { reference: `Coverage/${coverage.id}` },
      patient: req.patient, description: summary.status === 'inactive' ? 'Coverage is not active on the payer side.' : 'The eligibility check returned errors.',
      note: summary.lines.join('\n'),
    });
  }
}

/** Once a day: a request for each patient booked tomorrow with active coverage and no request in the last 24 hours. */
async function queueTomorrowsEligibility(medplum: MedplumClient, settings: BillingSettings, today: string, now: Date, counts: BillingCounts): Promise<void> {
  const tomorrow = addCalendarDays(today, 1);
  const appointments = await searchAll(medplum, 'Appointment', [['date', `ge${tomorrow}`], ['date', `lt${addCalendarDays(today, 2)}`], ['status', 'booked,pending']]);
  const patients = new Set(appointments.flatMap((a: Appointment) => (a.participant ?? []).map((p) => p.actor?.reference).filter((r): r is string => !!r?.startsWith('Patient/'))));
  const since = daysAgo(now, 1);
  for (const patientRef of patients) {
    const coverage = await medplum.searchOne('Coverage', { beneficiary: patientRef, status: 'active', _sort: '-_lastUpdated' }, { cache: 'no-cache' });
    if (!coverage) continue;
    const recent = await medplum.searchOne('CoverageEligibilityRequest', { patient: patientRef, created: `ge${since}` }, { cache: 'no-cache' });
    if (recent) continue;
    const payerId = payerIdOf(coverage) ?? '';
    const request: CoverageEligibilityRequest = {
      resourceType: 'CoverageEligibilityRequest',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: `eligibility-daily:${bareId(patientRef)}:${tomorrow}` }],
      status: 'active',
      purpose: ['benefits'],
      patient: { reference: patientRef },
      created: now.toISOString(),
      servicedDate: tomorrow,
      insurer: { display: settings.payers.find((p) => p.id === payerId)?.name ?? (payerId || 'Payer') },
      insurance: [{ focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
    };
    const query = new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${request.identifier?.[0]?.value}` }).toString();
    const existed = await medplum.searchOne('CoverageEligibilityRequest', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${request.identifier?.[0]?.value}` }, { cache: 'no-cache' });
    if (existed) continue;
    await medplum.createResourceIfNoneExist(request, query);
    counts.eligibilityRequestsQueued++;
  }
}

// --- f. Statement runs -------------------------------------------------------------------------

async function statementRuns(medplum: MedplumClient, ledger: LedgerClient, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  const runs = await searchAll(medplum, 'Task', { code: `${CODE_SYSTEMS.taskCode}|${BILLING_TASKS.statementRun}`, status: 'requested', _count: '20' });
  for (const run of runs) {
    const before = { ...counts };
    const balances = await ledger.patientBalances();
    for (const bal of balances) {
      try {
        await statementForPatient(medplum, ledger, bal, settings, now, counts);
      } catch (err) {
        counts.failures++;
        await openTask(medplum, { code: BILLING_ERROR_CODE, key: `statement:${bareId(bal.patientRef)}:${dayOf(now.toISOString())}`, text: 'Statement not produced', description: `The statement could not be produced: ${reason(err)}`, now, patient: { reference: bal.patientRef } });
      }
    }
    const summary = `statements ${counts.statements - before.statements} · refund reviews ${counts.refundReviews - before.refundReviews} · small balances ${counts.smallBalances - before.smallBalances} · failures ${counts.failures - before.failures}`;
    await patch(medplum, run, (t) => ({ ...t, status: 'completed', note: [...(t.note ?? []), { text: summary, time: now.toISOString() }] }));
  }
}

/**
 * Rebuilds journal drafts from a patient's ledger entries, one per journal, so statementLines can
 * run its own rules. Only the patient's own lines are kept; statementLines filters them anyway.
 */
export function journalsFromEntries(entries: readonly LedgerEntry[]): JournalDraft[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) groups.set(e.idempotencyKey, [...(groups.get(e.idempotencyKey) ?? []), e]);
  return [...groups.values()].map((rows) => {
    const first = rows[0];
    const lines: JournalLine[] = rows.map((e) => ({ account: e.account, cents: e.cents }));
    return { kind: first.kind, idempotencyKey: first.idempotencyKey, occurredAt: first.occurredAt, source: first.source, memo: first.memo, lines };
  });
}

async function statementForPatient(medplum: MedplumClient, ledger: LedgerClient, bal: { patientRef: string; owedCents: number; creditCents: number; lastCreditAt?: string }, settings: BillingSettings, now: Date, counts: BillingCounts): Promise<void> {
  const patientRef = bal.patientRef;
  const id = bareId(patientRef) as string;
  const today = dayOf(now.toISOString());
  const month = today.slice(0, 7);
  const policy = settings.policy;

  // A statement waiting for the biller's review blocks another one for the same patient.
  const waiting = await medplum.searchOne('Invoice', { subject: patientRef, status: 'draft' }, { cache: 'no-cache' });
  const lastInvoice = await medplum.searchOne('Invoice', { subject: patientRef, status: 'issued', _sort: '-date' }, { cache: 'no-cache' });
  const due = waiting ? { due: false } : statementDue(bal.owedCents, lastInvoice?.date ? dayOf(lastInvoice.date) : undefined, today, policy);
  if (due.due) {
    const detail = await ledger.patientBalance(id);
    const statement = statementLines(patientRef, journalsFromEntries(detail.entries));
    const invoice: Invoice = {
      resourceType: 'Invoice',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: `statement:${id}:${today}` }],
      // Drafts until a biller reviews and issues them in P35; only issued statements reach the patient.
      status: 'draft',
      subject: { reference: patientRef },
      recipient: { reference: patientRef },
      date: now.toISOString(),
      totalNet: money(statement.amountDueCents),
      lineItem: statement.lines.map((l, i) => ({
        sequence: i + 1,
        chargeItemCodeableConcept: { text: `${dayOf(l.occurredAt)} ${l.description}`.slice(0, 200) },
        priceComponent: [{ type: 'base', amount: money(l.changeCents) }],
      })),
    };
    const before = await medplum.searchOne('Invoice', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|statement:${id}:${today}` }, { cache: 'no-cache' });
    if (!before) {
      await medplum.createResourceIfNoneExist(invoice, new URLSearchParams({ identifier: `${GENERATED_IDENTIFIER_SYSTEM}|statement:${id}:${today}` }).toString());
      counts.statements++;
    }
  }

  const refund = refundReviewDue(bal.creditCents, bal.lastCreditAt ? dayOf(bal.lastCreditAt) : undefined, today, policy);
  if (refund.due) {
    if (await openTask(medplum, { code: BILLING_TASKS.refundReview, key: `${id}:${month}`, text: 'Credit to review', now, patient: { reference: patientRef }, description: `Credit of ${formatCents(bal.creditCents)} is held on the account.`, note: refund.reason })) counts.refundReviews++;
  }
  if (smallBalanceCandidate(bal.owedCents, policy)) {
    if (await openTask(medplum, { code: BILLING_TASKS.smallBalance, key: `${id}:${month}`, text: 'Small balance to review', now, patient: { reference: patientRef }, description: `A small balance of ${formatCents(bal.owedCents)} is open; a write-off needs approval.` })) counts.smallBalances++;
  }
}

/** Statements issued by a biller in the last week get their patient notice, once each. */
async function issuedStatementNotices(medplum: MedplumClient, now: Date, counts: BillingCounts): Promise<void> {
  const issued = await searchAll(medplum, 'Invoice', { status: 'issued', _lastUpdated: `ge${daysAgo(now, 7)}`, _count: '100' });
  for (const inv of issued) {
    const patientRef = inv.subject?.reference;
    if (!patientRef?.startsWith('Patient/') || !inv.id) continue;
    if (await noticeOnce(medplum, patientRef, inv.id, now)) counts.statementNotices++;
  }
}

/** The portal notice, once per issued statement. The email carries no amounts and no clinical text. */
async function noticeOnce(medplum: MedplumClient, patientRef: string, invoiceId: string, now: Date): Promise<boolean> {
  const value = `statement-notice:${invoiceId}`;
  const query = { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${value}` };
  if (await medplum.searchOne('Communication', query, { cache: 'no-cache' })) return false;
  const notice: Communication = {
    resourceType: 'Communication',
    identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value }],
    status: 'completed',
    category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: STATEMENT_NOTICE_CATEGORY, display: 'Statement notice' }] }],
    subject: { reference: patientRef },
    recipient: [{ reference: patientRef }],
    sent: now.toISOString(),
    payload: [{ contentString: STATEMENT_NOTICE_TEXT }],
  };
  await medplum.createResourceIfNoneExist(notice, new URLSearchParams(query).toString());
  const patient = await medplum.readReference<Patient>({ reference: patientRef }).catch(() => undefined);
  const email = patient?.telecom?.find((t) => t.system === 'email')?.value;
  if (email) await transportsFromEnv().email.send(email, STATEMENT_NOTICE_TEXT, 'Teleemon: new statement');
  return true;
}

