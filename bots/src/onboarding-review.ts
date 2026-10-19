// Post-commit Bot on completed QuestionnaireResponses (docs/PATIENT-ONBOARDING-PLAN.md, stage 9).
// When a patient submits their new-patient forms in the portal, the front desk gets one review
// Task to verify identity, insurance, card and consents. Idempotent: one review per patient.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { getReferenceString } from '@medplum/core';
import type { QuestionnaireResponse, Task } from '@medplum/fhirtypes';
import { INTAKE_QUESTIONNAIRE_URL, buildOnboardingReviewTask, onboardingReviewIdentifier } from '@teleemon/core';

export async function handler(medplum: MedplumClient, event: BotEvent<QuestionnaireResponse>): Promise<Task | undefined> {
  const qr = event.input;
  const subject = qr.subject?.reference;
  if (qr.questionnaire !== INTAKE_QUESTIONNAIRE_URL || qr.status !== 'completed' || !subject?.startsWith('Patient/') || !qr.id) return undefined;
  const patientId = subject.split('/')[1];
  const id = onboardingReviewIdentifier(patientId);
  return medplum.createResourceIfNoneExist(buildOnboardingReviewTask(patientId, qr.id), `identifier=${id.system}|${id.value}`).then((t) => {
    console.log(`onboarding review ${getReferenceString(t)} for ${subject}`);
    return t;
  });
}
