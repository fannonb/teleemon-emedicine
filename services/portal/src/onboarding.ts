// Onboarding in the portal service (docs/PATIENT-ONBOARDING-PLAN.md):
//   - a reminder about 24 hours before a new patient's visit when their forms are not submitted
//     (links and times only, never clinical detail; once per visit);
//   - the good-faith estimate a self-pay patient acknowledges before each visit, recorded with
//     the exact text and its hash, like an e-signed consent.

import type { MedplumClient } from '@medplum/core';
import type { Appointment, Consent } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS, CONSENT_TYPES, EXT, INTAKE_QUESTIONNAIRE_URL, estimateAcknowledged, findVisitType, formatVisitTime, goodFaithEstimate,
} from '@teleemon/core';
import type { GoodFaithEstimate } from '@teleemon/core';
import { createHash } from 'node:crypto';
import { ownAppointment, patientHistory } from './booking';
import { HttpError, badRequest } from './http';
import { emailOf, portalBaseUrl, sendEmail } from './mail';
import type { PortalSession } from './session';

const REMIND_WITHIN_HOURS = 26;

async function intakeSubmitted(service: MedplumClient, patientRef: string): Promise<boolean> {
  const responses = await service.searchResources('QuestionnaireResponse', { subject: patientRef, status: 'completed', _count: '100' }, { cache: 'no-cache' });
  return responses.some((r) => r.questionnaire === INTAKE_QUESTIONNAIRE_URL);
}

/** New patients (no completed visit yet) with a visit in the next day and forms not submitted get one reminder. */
export async function remindIncompleteIntake(service: MedplumClient, now = new Date()): Promise<number> {
  const until = new Date(now.getTime() + REMIND_WITHIN_HOURS * 3600000).toISOString();
  const upcoming = await service.searchResources('Appointment', new URLSearchParams([
    ['status', 'booked'], ['date', `ge${now.toISOString()}`], ['date', `lt${until}`], ['_count', '200'],
  ]), { cache: 'no-cache' });
  let sent = 0;
  for (const appt of upcoming) {
    if (appt.extension?.some((e) => e.url === EXT.intakeReminderSent)) continue;
    const patientRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    if (!patientRef) continue;
    const history = await patientHistory(service, patientRef);
    if (history.some((a) => a.status === 'fulfilled')) continue;
    if (await intakeSubmitted(service, patientRef)) continue;
    const patient = await service.readResource('Patient', patientRef.split('/')[1]).catch(() => undefined);
    const email = patient && emailOf(patient);
    if (!email) continue;
    // Mark first (version-checked) so two passes never send twice.
    try {
      await service.updateResource<Appointment>({ ...appt, extension: [...(appt.extension ?? []), { url: EXT.intakeReminderSent, valueDateTime: now.toISOString() }] }, { headers: { 'If-Match': `W/"${appt.meta?.versionId}"` } });
    } catch {
      continue;
    }
    await sendEmail(email, 'Please finish your forms before your Teleemon visit', `Your visit is ${formatVisitTime(appt.start as string)}. Please finish your new-patient forms before then, so your provider has what they need: ${portalBaseUrl()}intake\n\nIt takes about 15 minutes, and your answers are saved as you go.`);
    sent++;
  }
  return sent;
}

const isSelfPay = (s: PortalSession): boolean => !!s.patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true);

/** The next visit a self-pay patient needs an estimate for, or undefined. */
async function estimateFor(service: MedplumClient, s: PortalSession, now: Date): Promise<{ appt: Appointment; estimate: GoodFaithEstimate } | undefined> {
  const next = (await patientHistory(service, s.patientRef))
    .filter((a) => ['booked', 'pending'].includes(a.status) && Date.parse(a.start ?? '') > now.getTime())
    .sort((a, b) => (a.start as string).localeCompare(b.start as string))[0];
  const type = next ? findVisitType(next.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code) : undefined;
  if (!next || !type) return undefined;
  return { appt: next, estimate: goodFaithEstimate(next, type, formatVisitTime(next.start as string)) };
}

export async function currentEstimate(service: MedplumClient, s: PortalSession, now = new Date()): Promise<unknown> {
  if (!isSelfPay(s)) return { needed: false };
  const found = await estimateFor(service, s, now);
  if (!found) return { needed: false };
  const consents = await service.searchResources('Consent', { patient: s.patientRef, _count: '200' }, { cache: 'no-cache' });
  return { needed: !estimateAcknowledged(consents, found.appt.id as string), estimate: found.estimate };
}

export async function acknowledgeEstimate(service: MedplumClient, s: PortalSession, body: { appointmentId?: string; signature?: string; agree?: boolean }, now = new Date()): Promise<Consent> {
  if (!isSelfPay(s)) throw badRequest('Good-faith estimates are for self-pay visits.');
  const appt = await ownAppointment(service, s, body.appointmentId ?? '');
  const found = await estimateFor(service, s, now);
  if (!found || found.appt.id !== appt.id) throw new HttpError(409, 'This estimate is out of date. Reload the page to see the current one.', 'estimate-changed');
  const typed = body.signature?.trim().replace(/\s+/g, ' ') ?? '';
  if (body.agree !== true || typed.length < 2 || typed.length > 120) throw badRequest('Tick the box and type your full name to acknowledge the estimate.');
  const consents = await service.searchResources('Consent', { patient: s.patientRef, _count: '200' }, { cache: 'no-cache' });
  const existing = consents.find((c) => estimateAcknowledged([c], appt.id as string));
  if (existing) return existing;
  const { estimate } = found;
  return service.createResource<Consent>({
    resourceType: 'Consent',
    status: 'active',
    scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }] },
    category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: 'good-faith-estimate', display: CONSENT_TYPES.find((t) => t.code === 'good-faith-estimate')?.display }] }],
    patient: { reference: s.patientRef },
    dateTime: now.toISOString(),
    performer: [{ reference: s.actor, display: `${typed} (typed acknowledgment${s.access === 'self' ? '' : ', parent or guardian'})` }],
    policyRule: { text: `${estimate.title}: $${estimate.amount.toFixed(2)} (${estimate.version})` },
    sourceAttachment: { contentType: 'text/plain', title: estimate.title, data: Buffer.from(estimate.body, 'utf8').toString('base64'), creation: now.toISOString() },
    provision: { type: 'permit', period: { start: now.toISOString(), end: appt.end }, data: [{ meaning: 'related', reference: { reference: `Appointment/${appt.id}` } }] },
    extension: [
      { url: EXT.consentMethod, valueCode: 'portal-esignature' },
      { url: EXT.consentDocument, valueString: estimate.version },
      { url: EXT.consentTextHash, valueString: createHash('sha256').update(estimate.body, 'utf8').digest('hex') },
    ],
  });
}

