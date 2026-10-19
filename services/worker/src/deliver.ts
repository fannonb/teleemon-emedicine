// Sends queued reminder Communications. This is the authoritative place for the opt-out and
// quiet-hours rules (SYSTEM-DESIGN.md §6): they are re-checked immediately before sending.

import type { MedplumClient } from '@medplum/core';
import { getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Appointment, Communication, Patient, Reference } from '@medplum/fhirtypes';
import type { Channel } from '@teleemon/core';
import { ACTIVE_STATUSES, CODE_SYSTEMS, EXT, inQuietHours, patientTimeZone, readSettings } from '@teleemon/core';
import type { Transport } from './transport';

export interface DeliveryReport {
  sent: number;
  deferred: number;
  stopped: number;
  failed: number;
}

export type TransportOutcomeObserver = (channel: Channel, outcome: 'success' | 'failure', error?: unknown) => void;

/**
 * `only` limits delivery to some messages. Verification runs use it with a simulated clock so
 * they never touch real queued reminders.
 */
export async function deliverQueued(
  medplum: MedplumClient,
  transports: Record<Channel, Transport>,
  now = new Date(),
  only?: (c: Communication) => boolean,
  observeTransportOutcome?: TransportOutcomeObserver
): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, deferred: 0, stopped: 0, failed: 0 };
  const settings = await readSettings(medplum, 'messaging');
  const queued = await medplum.searchResources(
    'Communication',
    { status: 'preparation', category: `${CODE_SYSTEMS.communicationCategory}|reminder`, _count: '100', _sort: '_lastUpdated' },
    { cache: 'no-cache' }
  );

  for (const msg of only ? queued.filter(only) : queued) {
    const channel = getExtensionValue(msg, EXT.channel) as Channel | undefined;
    const stop = async (reason: string): Promise<void> => {
      await medplum.updateResource<Communication>({ ...msg, status: 'not-done', statusReason: { text: reason } });
      report.stopped++;
    };
    let transportAttempted = false;
    let transportObserved = false;
    const observe = (outcome: 'success' | 'failure', error?: unknown): void => {
      transportObserved = true;
      try { observeTransportOutcome?.(channel as Channel, outcome, error); }
      catch (observerError) { console.error(`[worker] transport telemetry failed (${observerError instanceof Error ? observerError.name : 'Error'})`); }
    };
    try {
      if (!channel) {
        await stop('Unknown channel');
        continue;
      }
      const appt = msg.about?.[0] ? await medplum.readReference(msg.about[0] as Reference<Appointment>) : undefined;
      if (!appt?.start || !ACTIVE_STATUSES.includes(appt.status) || Date.parse(appt.start) <= now.getTime()) {
        await stop('Appointment is no longer upcoming');
        continue;
      }
      const patient = await medplum.readReference(msg.subject as Reference<Patient>);
      const optedOut = (patient.extension ?? []).some((e) => e.url === EXT.contactOptOut && e.valueCode === channel);
      if (optedOut) {
        await stop(`Patient opted out of ${channel === 'sms' ? 'text messages' : 'email'}`);
        continue;
      }
      const timeZone = patientTimeZone(getExtensionValue(appt, EXT.patientLocationState) as string | undefined);
      if (inQuietHours(now, timeZone, settings)) {
        report.deferred++; // Stays queued; sent on the first run after quiet hours end.
        continue;
      }
      const to = patient.telecom?.find((t) => t.system === (channel === 'sms' ? 'phone' : 'email'))?.value;
      if (!to) {
        await stop(`No ${channel === 'sms' ? 'mobile number' : 'email address'} on file`);
        continue;
      }
      transportAttempted = true;
      const result = await transports[channel].send(to, msg.payload?.[0]?.contentString ?? '', msg.topic?.text);
      observe('success');
      await medplum.updateResource<Communication>({
        ...msg,
        status: 'completed',
        sent: now.toISOString(),
        note: [{ text: `${result.detail} · ${result.id}` }],
      });
      report.sent++;
    } catch (err) {
      if (transportAttempted && !transportObserved) observe('failure', err);
      report.failed++;
      console.error(`[worker] Communication/${msg.id}: ${normalizeErrorString(err)}`);
    }
  }
  return report;
}
