// Reminder scheduler (P42). Run every few minutes by the worker (`$execute`). Finds booked visits
// in the next 72 hours and queues the reminders that are due as Communications in "preparation".
// Delivery, opt-out re-checks and quiet hours happen in the worker at send time (§6), because
// that is the last moment before a message leaves the system.
// Idempotent: each reminder has a key (appointment + offset + channel) used for a conditional create.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference, getExtensionValue } from '@medplum/core';
import type { Appointment, BundleEntry, Communication, Patient, Resource } from '@medplum/fhirtypes';
import type { Channel } from '@teleemon/core';
import {
  CODE_SYSTEMS,
  EXT,
  GENERATED_IDENTIFIER_SYSTEM,
  dueOffsets,
  patientTimeZone,
  readSettings,
  reminderKey,
  renderReminder,
} from '@teleemon/core';

interface Input {
  /** Optional clock override (ISO instant), used by verification scripts. */
  readonly now?: string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<{ queued: number; skipped: string[] }> {
  const now = event.input?.now ? new Date(event.input.now) : new Date();
  const settings = await readSettings(medplum, 'messaging');
  const horizon = new Date(now.getTime() + (Math.max(...settings.offsets.map((o) => o.hours)) + 1) * 3600000).toISOString();

  const bundle = await medplum.search(
    'Appointment',
    new URLSearchParams([
      ['date', `ge${now.toISOString()}`],
      ['date', `lt${horizon}`],
      ['status', 'booked,pending'],
      ['_include', 'Appointment:patient'],
      ['_count', '500'],
    ]),
    { cache: 'no-cache' }
  );
  const patients = new Map<string, Patient>();
  const appointments: Appointment[] = [];
  for (const e of bundle.entry ?? []) {
    const r = e.resource as Resource | undefined;
    if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
    if (r?.resourceType === 'Appointment') appointments.push(r);
  }

  const entries: BundleEntry[] = [];
  const skipped: string[] = [];
  for (const appt of appointments) {
    const patientRef = appt.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const patient = patientRef ? patients.get(patientRef) : undefined;
    if (!patient || !appt.start) continue;
    const optOut = (patient.extension ?? []).filter((e) => e.url === EXT.contactOptOut).map((e) => e.valueCode);
    const timeZone = patientTimeZone(getExtensionValue(appt, EXT.patientLocationState) as string | undefined);

    for (const hours of dueOffsets(appt.start, now, settings)) {
      const offset = settings.offsets.find((o) => o.hours === hours);
      for (const channel of ['sms', 'email'] as Channel[]) {
        if (!offset?.[channel]) continue;
        if (optOut.includes(channel)) {
          skipped.push(`${appt.id}:${channel}:opted-out`);
          continue;
        }
        const destination = patient.telecom?.find((t) => t.system === (channel === 'sms' ? 'phone' : 'email'))?.value;
        if (!destination) {
          skipped.push(`${appt.id}:${channel}:no-destination`);
          continue;
        }
        const key = reminderKey(appt.id as string, hours, channel);
        const text = renderReminder(channel === 'sms' ? settings.smsTemplate : settings.emailTemplate, {
          firstName: patient.name?.find((n) => n.use === 'nickname')?.given?.[0] ?? patient.name?.[0]?.given?.[0] ?? '',
          start: appt.start,
          timeZone,
          practicePhone: settings.practicePhone,
        });
        const communication: Communication = {
          resourceType: 'Communication',
          identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: key }],
          status: 'preparation',
          category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'reminder', display: 'Appointment reminder' }] }],
          medium: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: channel === 'sms' ? 'SMSWRIT' : 'EMAILWRIT' }] }],
          subject: createReference(patient),
          recipient: [createReference(patient)],
          about: [createReference(appt)],
          topic: channel === 'email' ? { text: settings.emailSubject } : undefined,
          payload: [{ contentString: text }],
          extension: [{ url: EXT.channel, valueCode: channel }],
        };
        entries.push({
          resource: communication,
          request: { method: 'POST', url: 'Communication', ifNoneExist: `identifier=${encodeURIComponent(`${GENERATED_IDENTIFIER_SYSTEM}|${key}`)}` },
        });
      }
    }
  }

  let queued = 0;
  if (entries.length) {
    const result = await medplum.executeBatch({ resourceType: 'Bundle', type: 'batch', entry: entries });
    queued = (result.entry ?? []).filter((e) => e.response?.status?.startsWith('201')).length;
  }
  return { queued, skipped };
}
