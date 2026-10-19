import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, badRequest } from '@medplum/core';
import type { QuestionnaireResponse } from '@medplum/fhirtypes';
import { measureFromQuestionnaireUrl } from '@teleemon/core';

export async function handler(_medplum: MedplumClient, event: BotEvent<QuestionnaireResponse>): Promise<QuestionnaireResponse> {
  const qr = event.input;
  const def = measureFromQuestionnaireUrl(qr.questionnaire);
  if (event.headers?.['X-Medplum-Deleted-Resource'] || !def || qr.status !== 'completed') return qr;
  if (!qr.subject?.reference?.startsWith('Patient/')) throw new OperationOutcomeError(badRequest('A completed measure must reference a patient.'));
  for (const item of def.items) {
    const matches = qr.item?.filter((i) => i.linkId === item.linkId) ?? [];
    const answers = matches[0]?.answer;
    const value = answers?.[0]?.valueInteger ?? Number(answers?.[0]?.valueCoding?.code);
    if (matches.length !== 1 || answers?.length !== 1 || !item.options.some((o) => o.value === value)) {
      throw new OperationOutcomeError(badRequest(`Answer every item using one of the available options: ${item.text}`));
    }
  }
  return qr;
}
