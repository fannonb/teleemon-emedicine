// Pre-commit Bot on ChargeItem (P30; SYSTEM-DESIGN.md §6, §7.3). Medplum runs one pre-commit Bot
// per resource type, so every ChargeItem rule lives here.
//
// - Status moves only along planned → billable → billed, with holds (not-billable) and
//   entered-in-error needing a reason. Only the worker marks a charge billed.
// - A charge is billable only with a payer, a positive whole-cent amount, at least one
//   diagnosis, a valid charge line, and every AI-suggested code accepted by the provider.
// - Only the rendering provider can accept an AI-suggested code; the flag can never be removed.
// - Once the ledger has posted the charge, what was billed (code, patient, visit, amount, payer,
//   line) is frozen: corrections are entered-in-error (the worker posts the reversal) and a new charge.
// - Every write recomputes the work-queue tags (status, ledger pending, reversal pending).
// - Only the worker records the ledger posting, and never removes it; it also records the
//   reversal when a posted charge is entered in error (the only change to a voided charge).

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { ChargeItem } from '@medplum/fhirtypes';
import type { ChargeLine } from '@teleemon/core';
import { REVENUE_EXT, chargeLineOf, moneyCents, withChargeQueueTags } from '@teleemon/core';
import { previous } from './previous';

type Status = ChargeItem['status'];
const MOVES: Record<Status, Status[]> = {
  planned: ['billable', 'not-billable', 'entered-in-error'],
  billable: ['planned', 'billed', 'not-billable', 'entered-in-error'],
  billed: ['billable', 'entered-in-error'],
  'not-billable': ['planned', 'entered-in-error'],
  aborted: [],
  'entered-in-error': [],
  unknown: [],
};

const ext = (c: ChargeItem | undefined, url: string) => c?.extension?.find((e) => e.url === url);
const isService = (author: string | undefined) => !!author && /^(ClientApplication|Bot)\//.test(author);

/** What the ledger posted; these fields cannot change afterwards. */
const billedContent = (c: ChargeItem) =>
  JSON.stringify([c.code?.coding?.[0]?.code, c.subject?.reference, c.context?.reference, moneyCents(c.priceOverride), ext(c, REVENUE_EXT.billingPayer)?.valueString, ext(c, REVENUE_EXT.chargeLine)?.valueString, c.occurrenceDateTime]);

export async function handler(medplum: MedplumClient, event: BotEvent<ChargeItem>): Promise<ChargeItem | boolean> {
  const charge = event.input;
  if (Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource')) {
    reject('Charges are never deleted. Mark the charge entered in error with a reason.');
  }
  const before = await previous(medplum, charge);
  const author = charge.meta?.author?.reference;
  const from: Status = before?.status ?? 'planned';
  const to = charge.status;

  if (!before && to !== 'planned') reject('A new charge starts in charge review (planned).');
  if (before?.status === 'entered-in-error') {
    // The one change allowed: the worker records the ledger reversal of a voided posted charge.
    const strip = (c: ChargeItem) => JSON.stringify({ ...c, meta: undefined, extension: c.extension?.filter((e) => e.url !== REVENUE_EXT.ledgerReversal) });
    const recordingReversal = isService(author) && !ext(before, REVENUE_EXT.ledgerReversal) && ext(charge, REVENUE_EXT.ledgerReversal) && strip(before) === strip(charge);
    if (!recordingReversal) reject('A charge entered in error cannot be changed.');
    return withChargeQueueTags(charge);
  }
  if (before && from !== to && !MOVES[from].includes(to)) reject(`A charge cannot move from ${from} to ${to}.`);
  if (to === 'billed' || (from === 'billed' && to === 'billable')) {
    if (!isService(author)) reject('Only claim submission marks a charge billed.');
  }

  const line = chargeLineOf(charge);
  if (!line) reject('The charge has no valid charge line.');
  if (!charge.subject?.reference?.startsWith('Patient/') || !charge.context?.reference?.startsWith('Encounter/')) reject('A charge belongs to a patient and a visit.');
  const cents = moneyCents(charge.priceOverride);
  if (cents === undefined || cents < 0 || Math.abs((charge.priceOverride?.value ?? 0) * 100 - cents) > 1e-6) reject('The charge amount must be whole cents.');

  // AI acceptance: never cleared, and accepted only by the rendering provider.
  const was = before ? chargeLineOf(before) : undefined;
  if (was?.aiSuggested && !line.aiSuggested) reject('The AI-suggested flag on a code cannot be removed.');
  // The charge-capture Bot creates charges from a note the provider signed, which is their acceptance.
  const accepting = line.aiSuggested && line.providerAccepted && !was?.providerAccepted;
  if (accepting && !(!before && author?.startsWith('Bot/'))) {
    const performer = charge.performer?.[0]?.actor?.reference;
    if (!performer || performer !== author) reject('Only the rendering provider can accept an AI-suggested code.');
  }
  if (before && was?.providerAccepted && line.aiSuggested && !line.providerAccepted) reject('A provider acceptance cannot be withdrawn here; mark the charge not billable instead.');

  // Ledger posting: recorded only by the worker, never removed; posted content is frozen.
  const posted = ext(before, REVENUE_EXT.ledgerJournal)?.valueString;
  const now = ext(charge, REVENUE_EXT.ledgerJournal)?.valueString;
  if (posted && now !== posted) reject('The ledger posting on a charge cannot be changed or removed.');
  if (!posted && now && !isService(author)) reject('Only the ledger worker records a posting.');
  if (posted && before && billedContent(before) !== billedContent(charge)) {
    reject('This charge is posted to the ledger. Mark it entered in error and create a corrected charge.');
  }

  if (to === 'billable' || to === 'billed') billableCheck(charge, line, cents as number);
  if (to === 'not-billable' || to === 'entered-in-error') {
    const reason = ext(charge, REVENUE_EXT.holdReason)?.valueString?.trim() ?? '';
    if (reason.length < 5) reject('Give the reason this charge is not billed.');
  }
  // R4 has no ChargeItem status search; queue tags stand in for it (chargeQueues in core).
  return withChargeQueueTags(charge);
}

function billableCheck(charge: ChargeItem, line: ChargeLine, cents: number): void {
  const payer = ext(charge, REVENUE_EXT.billingPayer)?.valueString;
  if (!payer) reject('Choose the payer (or self-pay) before releasing the charge.');
  if (cents <= 0) reject('A billable charge needs a positive amount.');
  if (!charge.reason?.length) reject('A billable charge needs at least one diagnosis.');
  if (charge.code?.coding?.[0]?.code !== line.code) reject('The charge code and its charge line disagree.');
  if (line.chargeCents !== cents) reject('The charge amount and its charge line disagree.');
  if (line.aiSuggested && !line.providerAccepted) reject(`${line.code} was suggested by AI; the provider must accept it before it can be billed.`);
  if (!charge.performer?.[0]?.actor?.reference?.startsWith('Practitioner/')) reject('A billable charge names the rendering provider.');
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
