// Pre-commit Bot on MedicationRequest create/update (P25; SYSTEM-DESIGN.md §6). Runs for every
// principal, including admins and direct API calls:
//   - sending (status active) requires the full prescribing rules in @teleemon/core: catalogue
//     drug, sig/quantity/days supply, licence and DEA registration for the patient's location,
//     refill limits by schedule, and a PDMP check in the last 24 hours for controlled substances;
//   - once sent, the clinical content is locked; only the status (stop/cancel) and the worker's
//     transmission fields may change.
// The controlled schedule is derived from the drug on the server, so a client cannot omit it.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { MedicationRequest, Practitioner, Reference } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, ERX_IDENTIFIER_SYSTEM, EXT, currentPdmpCheck, erxStatus, findMedication, prescriptionProblems, readRx, rxMedication, rxUpdateProblem } from '@teleemon/core';
import { previous } from './previous';

export async function handler(medplum: MedplumClient, event: BotEvent<MedicationRequest>): Promise<boolean> {
  const rx = event.input;
  // Deletes are administrator-only (roles have no delete permission) and are not prescribing.
  if (isDelete(event)) return true;
  if (!rx.subject?.reference?.startsWith('Patient/')) reject('A prescription must be for a patient.');

  const before = await previous(medplum, rx);
  const problem = rxUpdateProblem(before, rx);
  if (problem) reject(problem);
  if (rx.extension?.filter((e) => e.url === EXT.erxStatus).length !== (erxStatus(rx) ? 1 : 0)) reject('A prescription must have a single transmission status.');
  if (before && rx.meta?.author?.reference?.startsWith('Practitioner/')) {
    if (rx.meta.author.reference !== before.requester?.reference) reject('Only the named prescriber may change this prescription.');
    if (erxStatus(rx) !== erxStatus(before) && !['queued', 'cancel-requested'].includes(erxStatus(rx) ?? '')) reject('Only the prescribing service may record transmission outcomes.');
    if (JSON.stringify(before.identifier?.filter((i) => i.system === ERX_IDENTIFIER_SYSTEM)) !== JSON.stringify(rx.identifier?.filter((i) => i.system === ERX_IDENTIFIER_SYSTEM))) reject('Only the prescribing service may record the vendor identifier.');
  }

  // Sending, or re-sending after a failed transmission: both re-check every rule with current data.
  const retry = !!before && erxStatus(before) === 'failed' && erxStatus(rx) === 'queued';
  const sending = rx.status === 'active' && (!before || before.status === 'draft' || retry);
  if (!sending) return true;

  const entry = findMedication(rxMedication(rx));
  const declared = rx.extension?.find((e) => e.url === EXT.controlledSchedule)?.valueCode;
  if (entry?.schedule && declared !== entry.schedule) reject(`${entry.name} is a schedule ${entry.schedule} controlled substance; the prescription must say so.`);
  if (rx.extension?.find((e) => e.url === EXT.erxStatus)?.valueCode !== 'queued') reject('A new prescription must be queued for the e-prescribing service.');

  // A prescription is sent by the prescriber named on it, never on someone else's behalf. Medplum
  // stamps the signed-in user (or client) into meta.author before pre-commit Bots run.
  if (!rx.requester?.reference || rx.meta?.author?.reference !== rx.requester.reference) {
    reject('Prescriptions can only be sent by the prescriber named on them.');
  }
  const requester = rx.requester?.reference?.startsWith('Practitioner/')
    ? await medplum.readReference(rx.requester as Reference<Practitioner>).catch(() => undefined)
    : undefined;
  const pdmpChecks = await medplum.searchResources('Task', { subject: rx.subject.reference, code: `${CODE_SYSTEMS.taskCode}|pdmp-check`, status: 'completed', _count: '50', _sort: '-_lastUpdated' });
  // Only the prescriber's own PDMP review counts.
  const own = pdmpChecks.filter((t) => t.owner?.reference === rx.requester?.reference);
  const problems = prescriptionProblems(readRx(rx), { practitioner: requester, pdmpChecks: own });

  // The check the prescription cites must be one of this patient's current checks.
  const cited = rx.extension?.find((e) => e.url === EXT.pdmpCheck)?.valueReference?.reference;
  const citedTask = pdmpChecks.find((t) => `Task/${t.id}` === cited && t.owner?.reference === rx.requester?.reference);
  if (entry?.schedule && problems.length === 0 && !(citedTask && currentPdmpCheck([citedTask], readRx(rx).state))) {
    problems.push('Link a current PDMP check for this patient and state to the prescription.');
  }
  if (problems.length) reject(problems.join(' '));
  return true;
}

function isDelete(event: BotEvent): boolean {
  return Object.keys(event.headers ?? {}).some((h) => h.toLowerCase() === 'x-medplum-deleted-resource');
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
