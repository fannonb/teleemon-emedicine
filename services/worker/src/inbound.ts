// Inbound SMS replies (P42): STOP/START/HELP keywords and "C" to confirm the next visit.
// Opt-outs take effect immediately: the worker re-checks them before every send.

import type { MedplumClient } from '@medplum/core';
import { createReference, getExtensionValue } from '@medplum/core';
import type { Appointment, Communication, Patient } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT, classifyReply, phoneSearchValues, readSettings } from '@teleemon/core';

export interface InboundResult {
  readonly patient?: Patient;
  readonly intent: ReturnType<typeof classifyReply>;
  /** Text to send back to the sender (carrier-required for STOP/HELP). */
  readonly reply?: string;
}

export async function handleInbound(medplum: MedplumClient, from: string, body: string): Promise<InboundResult> {
  const digits = from.replace(/\D/g, '').slice(-10);
  const intent = classifyReply(body);
  const settings = await readSettings(medplum, 'messaging');
  const candidates = digits.length === 10 ? await medplum.searchResources('Patient', { phone: phoneSearchValues(digits).join(','), _count: '5' }, { cache: 'no-cache' }) : [];
  // A number shared by several patients (e.g. a parent) changes all of them for STOP/START.
  const patient = candidates[0];

  if (intent === 'stop') {
    for (const p of candidates) await setOptOut(medplum, p, true);
    return { patient, intent, reply: 'Teleemon: You are unsubscribed and will receive no more texts. Reply START to resubscribe.' };
  }
  if (intent === 'start') {
    for (const p of candidates) await setOptOut(medplum, p, false);
    return { patient, intent, reply: 'Teleemon: You are subscribed to appointment texts again. Reply STOP to opt out.' };
  }
  if (intent === 'help') {
    return { patient, intent, reply: `Teleemon appointment reminders. Call ${settings.practicePhone}. Reply STOP to opt out. In a crisis call or text 988.` };
  }
  if (!patient) {
    // Unknown number (P03): keep the message for a person to match; never drop it.
    if (intent === 'other' && body.trim()) {
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'sms-reply', display: 'SMS reply' }] }],
        medium: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: 'SMSWRIT' }] }],
        sent: new Date().toISOString(),
        payload: [{ contentString: body.slice(0, 1600) }],
        extension: [{ url: EXT.inboundFrom, valueString: from }],
      });
      return { intent, reply: 'Teleemon: Thanks, the care team will follow up. In a crisis call or text 988.' };
    }
    return { intent, reply: undefined };
  }
  if (intent === 'confirm') {
    const next = await medplum.searchOne(
      'Appointment',
      new URLSearchParams([['patient', `Patient/${patient.id}`], ['date', `ge${new Date().toISOString()}`], ['status', 'booked'], ['_sort', 'date']]),
      { cache: 'no-cache' }
    );
    if (next && !getExtensionValue(next, EXT.confirmedAt)) {
      await medplum.updateResource<Appointment>({ ...next, extension: [...(next.extension ?? []), { url: EXT.confirmedAt, valueDateTime: new Date().toISOString() }] });
    }
    return { patient, intent, reply: next ? 'Teleemon: Thank you, your appointment is confirmed.' : undefined };
  }
  // Anything else is a message for staff: it lands in the patient-messages queue.
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'in-progress',
    category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'sms-reply', display: 'SMS reply' }] }],
    medium: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: 'SMSWRIT' }] }],
    subject: createReference(patient),
    sender: createReference(patient),
    sent: new Date().toISOString(),
    payload: [{ contentString: body.slice(0, 1600) }],
  });
  return { patient, intent, reply: 'Teleemon: Thanks, the care team will reply in the patient portal or by phone. In a crisis call or text 988.' };
}

async function setOptOut(medplum: MedplumClient, patient: Patient, optOut: boolean): Promise<void> {
  const has = (patient.extension ?? []).some((e) => e.url === EXT.contactOptOut && e.valueCode === 'sms');
  if (has === optOut) return;
  const extension = (patient.extension ?? []).filter((e) => !(e.url === EXT.contactOptOut && e.valueCode === 'sms'));
  if (optOut) extension.push({ url: EXT.contactOptOut, valueCode: 'sms' });
  await medplum.updateResource<Patient>({ ...patient, extension });
}
