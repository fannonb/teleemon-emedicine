import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { Condition } from '@medplum/fhirtypes';
import { ICD10CM_SYSTEM, findDiagnosis } from '@teleemon/core';

/** Validate the same catalogue and duplicate rule for API, imports and browser writes. */
export async function handler(medplum: MedplumClient, event: BotEvent<Condition>): Promise<Condition> {
  const condition = event.input;
  if (event.headers?.['X-Medplum-Deleted-Resource']) return condition;
  const code = condition.code?.coding?.find((c) => c.system === ICD10CM_SYSTEM)?.code;
  if (!findDiagnosis(code)) throw new OperationOutcomeError(badRequest('Choose a billable diagnosis from the practice ICD-10-CM catalogue.'));
  if (!condition.subject.reference?.startsWith('Patient/')) throw new OperationOutcomeError(badRequest('A diagnosis must reference a patient.'));
  const status = condition.clinicalStatus?.coding?.[0]?.code ?? 'active';
  if (status !== 'resolved' && condition.verificationStatus?.coding?.[0]?.code !== 'entered-in-error') {
    const matches = await medplum.searchResources('Condition', { subject: condition.subject.reference, code: `${ICD10CM_SYSTEM}|${code}`, _count: '1000' });
    if (matches.some((c) => c.id !== condition.id && c.clinicalStatus?.coding?.[0]?.code !== 'resolved' && c.verificationStatus?.coding?.[0]?.code !== 'entered-in-error')) {
      throw new OperationOutcomeError(badRequest('This diagnosis is already on the active problem list.'));
    }
  }
  return condition;
}
