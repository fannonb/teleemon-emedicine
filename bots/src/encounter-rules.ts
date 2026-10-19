// Pre-commit Bot on Encounter (P21; SYSTEM-DESIGN.md §6). A visit cannot start (status
// "in-progress") unless the patient's current location is confirmed and the provider holds a
// valid licence there today. This completes the Phase 2 rule: check-in records where the patient
// is; starting the visit is what licensure gates.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest, getExtensionValue } from '@medplum/core';
import type { Encounter, Practitioner, Reference } from '@medplum/fhirtypes';
import { EXT, PRACTICE_TIME_ZONE, checkLicensure, zonedDate } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<Encounter>): Promise<boolean> {
  const encounter = event.input;
  if (encounter.status !== 'in-progress') {
    return true;
  }
  const state = getExtensionValue(encounter, EXT.patientLocationState) as string | undefined;
  const previous = encounter.id ? await medplum.readResource('Encounter', encounter.id).catch(() => undefined) : undefined;
  // Only check when the visit starts or the patient's location changes.
  if (previous?.status === 'in-progress' && getExtensionValue(previous, EXT.patientLocationState) === state) {
    return true;
  }
  const ref = encounter.participant?.find((p) => p.individual?.reference?.startsWith('Practitioner/'))?.individual as Reference<Practitioner> | undefined;
  if (!ref) {
    reject('Add the provider to the visit before starting it.');
  }
  const practitioner = await medplum.readReference(ref as Reference<Practitioner>);
  const result = checkLicensure(practitioner, state, zonedDate(new Date(), PRACTICE_TIME_ZONE));
  if (!result.ok) {
    reject(`This visit can't start: ${result.reason} Reschedule, or confirm the patient's location again.`);
  }
  return true;
}

function reject(message: string): never {
  throw new OperationOutcomeError(badRequest(message));
}
