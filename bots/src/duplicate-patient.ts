// Pre-commit Bot on Patient create/update (P08, SYSTEM-DESIGN.md §6).
// 1. Assigns the chart number (MRN) when a record has none, so every screen and import agrees.
// 2. Rejects a record that looks like an existing patient, unless it carries a duplicate-override
// reason. Only administrators can add that reason: the role AccessPolicies forbid it with a
// writeConstraint (scripts/config/platform.ts). Must stay fast: one FHIR search, no network calls.
// 3. Patients and proxies editing their own record from the portal (X09) may change contact
// details, address, pronouns, pharmacy and emergency contacts only (patientSelfEditProblem).

import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest, formatHumanName, getExtensionValue } from '@medplum/core';
import type { HumanName, Patient } from '@medplum/fhirtypes';
import { EXT, MRN_SYSTEM, chartNumberFor, findDuplicates, hasConfirmedGuardian, isMinor, isPortalAuthor, patientSelfEditProblem } from '@teleemon/core';
import { previous } from './previous';

const MIN_OVERRIDE_REASON = 10;

export async function handler(medplum: MedplumClient, event: BotEvent<Patient>): Promise<Patient | boolean> {
  if (event.headers?.['X-Medplum-Deleted-Resource']) return event.input;
  // Medplum stamps the signed-in user into meta.author before pre-commit Bots run.
  if (isPortalAuthor(event.input.meta?.author?.reference)) {
    const problem = patientSelfEditProblem(await previous(medplum, event.input), event.input);
    if (problem) throw new OperationOutcomeError(badRequest(problem));
  }
  const patient = await withChartNumber(medplum, event.input);
  if (isMinor(patient.birthDate) && !hasConfirmedGuardian(patient)) {
    throw new OperationOutcomeError(badRequest('Patients under 18 require a guardian name, relationship, valid phone number and confirmation of legal authority.'));
  }
  if (!patient.birthDate || patient.active === false) {
    return patient;
  }

  const sameBirthDate = await medplum.searchResources('Patient', { birthdate: patient.birthDate, _count: '100' });
  // A pair already accepted by an administrator is not flagged again when either record is edited.
  const candidates = sameBirthDate.filter((p) => !getExtensionValue(p, EXT.duplicateOverride));
  const duplicates = findDuplicates(patient, candidates);
  if (duplicates.length === 0) {
    return patient;
  }

  const override = (getExtensionValue(patient, EXT.duplicateOverride) as string | undefined)?.trim();
  if (override && override.length >= MIN_OVERRIDE_REASON) {
    return patient;
  }

  const first = duplicates[0];
  const name = formatHumanName(first.patient.name?.[0] as HumanName) || 'an existing patient';
  throw new OperationOutcomeError(
    badRequest(
      `Possible duplicate of ${name} (Patient/${first.patient.id}): ${first.reasons.join('; ')}. ` +
        'Open the existing record instead. If these really are different people, an administrator can save with an override reason.'
    )
  );
}

/** Returning the modified resource from a pre-commit Bot makes the server save that version. */
async function withChartNumber(medplum: MedplumClient, patient: Patient): Promise<Patient> {
  if (!patient.id || patient.identifier?.some((i) => i.system === MRN_SYSTEM)) {
    return patient;
  }
  let mrn = chartNumberFor(patient.id);
  const clash = await medplum.searchOne('Patient', { identifier: `${MRN_SYSTEM}|${mrn}` });
  if (clash && clash.id !== patient.id) {
    mrn = chartNumberFor(patient.id, 12);
  }
  return { ...patient, identifier: [...(patient.identifier ?? []), { system: MRN_SYSTEM, value: mrn }] };
}
