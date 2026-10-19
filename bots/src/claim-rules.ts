// Pre-commit Bot on Claim (P31; SYSTEM-DESIGN.md §6, §7.3). Medplum runs one pre-commit Bot per
// resource type, so every Claim rule lives here.
//
// - The work status (EXT claim-status) moves only along CLAIM_TRANSITIONS. Payer outcomes
//   (accepted, rejected, paid, partially paid, denied) are recorded only by the worker.
// - Moving to scrubbed or submitted re-runs the scrubber here, on the server, against the claim
//   as it will be sent, and stores that result: a scrub result written by the client is replaced,
//   so it cannot be forged. Submission is refused while any error remains.
// - After submission the billed content is locked; corrections go through a rejected claim
//   (back to draft) or a replacement claim (frequency 7 or 8) naming the original.
// - One live claim per visit, and every line names a billable charge of that visit and patient.
// - Claims are never deleted.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { Claim } from '@medplum/fhirtypes';
import type { ClaimStatus, ScrubStamp } from '@teleemon/core';
import {
  REVENUE_EXT, claimContentHash, claimDraftFromFhir, claimPayerId, claimStatusOf, claimTransitionProblem, fetchClaimSources, readSettings, scrubClaim, searchAll,
} from '@teleemon/core';
import { previous } from './previous';

const PAYER_OUTCOMES: readonly ClaimStatus[] = ['accepted', 'rejected', 'paid', 'partially-paid', 'denied'];
const LIVE: readonly ClaimStatus[] = ['draft', 'scrubbed', 'submitted', 'accepted', 'paid', 'partially-paid', 'denied', 'appealed'];
const REPLACEABLE: readonly ClaimStatus[] = ['submitted', 'accepted', 'paid', 'partially-paid', 'denied', 'appealed'];
const RELATED_CLAIM_SYSTEM = 'http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship';
const isService = (author: string | undefined) => !!author && /^(ClientApplication|Bot)\//.test(author);

export async function handler(medplum: MedplumClient, event: BotEvent<Claim>): Promise<Claim | boolean> {
  const claim = event.input;
  if (Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource')) reject('Claims are never deleted. Close the claim with a reason instead.');
  const before = await previous(medplum, claim);
  const author = claim.meta?.author?.reference;
  const from = before ? claimStatusOf(before) : 'draft';
  const to = claimStatusOf(claim);

  if (!before && to !== 'draft') reject('A new claim starts as a draft.');
  if (from !== to) {
    const problem = claimTransitionProblem(from, to);
    if (problem) reject(`This claim cannot move from ${from} to ${to}: ${problem}.`);
    if (PAYER_OUTCOMES.includes(to) && !isService(author)) reject('Payer outcomes are recorded from the clearinghouse, not entered by hand.');
  }

  // Locked once submitted: the content the payer has must not change underneath it.
  const locked = before && !['draft', 'scrubbed'].includes(from) && !(from === 'rejected' && to === 'draft');
  if (locked && claimContentHash(before) !== claimContentHash(claim)) reject('A submitted claim cannot be edited. Correct it with a replacement claim.');
  const clearinghouseIds = (c: Claim) => JSON.stringify((c.identifier ?? []).filter((i) => i.system?.includes('/identifier/clearinghouse')));
  if (before && clearinghouseIds(before) !== clearinghouseIds(claim) && !isService(author)) reject('Only claim submission records the clearinghouse id.');
  if (!locked) await linesProblem(medplum, claim);

  // Editing a scrubbed claim sends it back to draft: the earlier scrub no longer describes it.
  if (before && from === 'scrubbed' && to === 'scrubbed' && claimContentHash(before) !== claimContentHash(claim)) {
    return {
      ...claim,
      extension: [...(claim.extension ?? []).filter((e) => e.url !== REVENUE_EXT.claimStatus && e.url !== REVENUE_EXT.scrubResult), { url: REVENUE_EXT.claimStatus, valueCode: 'draft' }],
    };
  }

  if (to === 'scrubbed' || (to === 'submitted' && from !== 'submitted')) {
    const stamp = await serverScrub(medplum, claim);
    const errors = stamp.findings.filter((f) => f.severity === 'error');
    if (errors.length) reject(`The claim does not pass the scrubber: ${errors.slice(0, 5).map((e) => `${e.ruleId} ${e.message}`).join('; ')}`);
    return { ...claim, extension: [...(claim.extension ?? []).filter((e) => e.url !== REVENUE_EXT.scrubResult), { url: REVENUE_EXT.scrubResult, valueString: JSON.stringify(stamp) }] };
  }
  // Any other edit to an unlocked claim invalidates an earlier scrub result; keep only the server's own.
  if (!locked && before) {
    const stamp = claim.extension?.find((e) => e.url === REVENUE_EXT.scrubResult)?.valueString;
    const was = before.extension?.find((e) => e.url === REVENUE_EXT.scrubResult)?.valueString;
    if (stamp !== was) reject('Scrub results are recorded by the server when the claim is scrubbed.');
  } else if (!before && claim.extension?.some((e) => e.url === REVENUE_EXT.scrubResult)) {
    reject('Scrub results are recorded by the server when the claim is scrubbed.');
  }
  return true;
}

async function serverScrub(medplum: MedplumClient, claim: Claim): Promise<ScrubStamp> {
  const [settings, sources] = await Promise.all([readSettings(medplum, 'billing'), fetchClaimSources(medplum, claim).catch((err: unknown) => reject(`The claim is incomplete: ${err instanceof Error ? err.message : 'missing records'}.`))]);
  const payerId = claimPayerId(claim, sources.coverage);
  const today = new Date().toISOString().slice(0, 10);
  const findings = scrubClaim(claimDraftFromFhir(sources), { today, payer: settings.payers.find((p) => p.id === payerId), fees: settings.fees, disabledRules: settings.disabledScrubRules });
  return { at: new Date().toISOString(), hash: claimContentHash(claim), findings };
}

/** Every line names a billable charge of this patient and visit, and no other live claim bills the visit. */
async function linesProblem(medplum: MedplumClient, claim: Claim): Promise<void> {
  if (!claim.patient?.reference?.startsWith('Patient/')) reject('A claim names its patient.');
  const refs = (claim.item ?? []).map((i) => i.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference);
  if (refs.some((r) => !r?.startsWith('ChargeItem/'))) reject('Every claim line names the charge it bills.');
  if (new Set(refs).size !== refs.length) reject('A charge can appear on a claim only once.');
  const charges = await Promise.all(refs.map((r) => medplum.readReference({ reference: r as string })));
  const visits = new Set<string>();
  for (const c of charges) {
    if (c.resourceType !== 'ChargeItem') reject('Every claim line names the charge it bills.');
    if (c.subject?.reference !== claim.patient.reference) reject('Every charge on a claim belongs to the claim patient.');
    if (c.status !== 'billable' && c.status !== 'billed') reject(`Charge ${c.code?.coding?.[0]?.code ?? ''} has not been released in charge review.`);
    if (!c.context?.reference?.startsWith('Encounter/')) reject('Every charge on a claim belongs to one visit.');
    visits.add(c.context.reference);
  }
  const items = claim.item ?? [];
  const itemVisits = new Set(items.flatMap((i) => (i.encounter ?? []).map((e) => e.reference).filter((ref): ref is string => !!ref)));
  if (visits.size !== 1 || itemVisits.size !== 1 || [...itemVisits][0] !== [...visits][0] || items.some((i) => !i.encounter?.some((e) => e.reference === [...visits][0]))) {
    reject('Every claim line and charge must name the same visit.');
  }
  const visit = [...visits][0];
  if (visit && claimStatusOf(claim) !== 'closed') {
    const original = await replacementOriginal(medplum, claim, visit);
    const others = await searchAll(medplum, 'Claim', { encounter: visit });
    const live = others.filter((o) => o.id !== claim.id && LIVE.includes(claimStatusOf(o)) && o.status === 'active');
    const conflicts = live.filter((o) => o.id !== original?.id);
    if (conflicts.length) {
      if (!original) reject('This visit already has a live claim. Correct that claim, or create a replacement that names it.');
      if (conflicts.some((o) => o.related?.some((r) => r.claim?.reference === `Claim/${original.id}`))) {
        reject('This claim already has a live replacement. Finish or close it before creating another replacement.');
      }
      reject('A replacement must be the only live claim for this visit besides the claim it corrects.');
    }
    if (original && !live.some((o) => o.id === original.id)) reject('The claim being replaced is not an eligible live claim for this visit.');
  }
}

/** A frequency-7 replacement must point to one eligible prior claim for the same visit, patient and payer. */
async function replacementOriginal(medplum: MedplumClient, claim: Claim, visit: string): Promise<Claim | undefined> {
  const related = claim.related ?? [];
  if (related.length === 0) return undefined;
  if (related.length !== 1) reject('A replacement claim must name exactly one original claim.');
  const [link] = related;
  const originalRef = link.claim?.reference;
  if (!originalRef || !/^Claim\/[^/]+$/.test(originalRef)) reject('A replacement claim must name an existing original claim.');
  if (!link.relationship?.coding?.some((c) => c.system === RELATED_CLAIM_SYSTEM && c.code === 'prior')) {
    reject('A replacement claim must identify its original with the prior-claim relationship.');
  }
  if (originalRef === `Claim/${claim.id}`) reject('A claim cannot replace itself.');

  let original: Claim;
  try {
    original = await medplum.readReference({ reference: originalRef });
  } catch {
    reject('The original claim named by this replacement does not exist or cannot be read.');
  }
  if (original.resourceType !== 'Claim' || original.status !== 'active' || !REPLACEABLE.includes(claimStatusOf(original))) {
    reject('The original claim is not in a status that can be replaced.');
  }
  if (!claim.patient?.reference || original.patient?.reference !== claim.patient.reference) reject('The original claim belongs to a different patient.');

  const originalVisits = new Set((original.item ?? []).flatMap((item) => (item.encounter ?? []).map((e) => e.reference).filter((ref): ref is string => !!ref)));
  if (originalVisits.size !== 1 || !originalVisits.has(visit) || (original.item ?? []).some((item) => !item.encounter?.some((e) => e.reference === visit))) {
    reject('The original claim belongs to a different visit.');
  }

  const payerFor = async (candidate: Claim): Promise<string | undefined> => {
    const coverageRef = candidate.insurance?.find((i) => i.focal)?.coverage?.reference ?? candidate.insurance?.[0]?.coverage?.reference;
    const ownPayer = candidate.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString;
    if (ownPayer) return ownPayer;
    if (!coverageRef?.startsWith('Coverage/')) return undefined;
    const coverage = await medplum.readReference({ reference: coverageRef });
    return coverage.resourceType === 'Coverage' ? claimPayerId(candidate, coverage) : undefined;
  };
  let newPayer: string | undefined;
  let originalPayer: string | undefined;
  try {
    [newPayer, originalPayer] = await Promise.all([payerFor(claim), payerFor(original)]);
  } catch {
    reject('The original and replacement claim payers could not be verified.');
  }
  if (!newPayer || !originalPayer || newPayer !== originalPayer) reject('The original and replacement claims must use the same payer.');
  return original;
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
