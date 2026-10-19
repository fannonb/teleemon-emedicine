// Telehealth meeting links (TELEHEALTH-SCRIBE-PLAN.md, SYSTEM-DESIGN.md §7.2). The video platform is
// Google Meet. A provider may paste a link by hand, but normally the scheduling integration creates
// one meeting per video appointment and stores it as EXT.telehealthUrl; the worker is the only writer.
//
// The link is hidden from the patient's own reads (portal policy hiddenFields) and released by the
// portal service only after check-in, so the provider and the patient reach the same meeting through
// the same stored link. An existing link is never replaced, which makes provisioning idempotent.

import type { Appointment } from '@medplum/fhirtypes';
import { EXT } from './fhir';
import { validMeetUrl } from './scribe';

/** Appointment statuses that should already hold a meeting link (a confirmed video visit). */
export const MEET_PROVISION_STATUSES: Appointment['status'][] = ['booked', 'arrived', 'checked-in'];

export function appointmentModality(appt: Appointment): string | undefined {
  return appt.extension?.find((e) => e.url === EXT.modality)?.valueCode;
}

/** The stored join link, when it is a well-formed Google Meet URL; otherwise undefined. */
export function appointmentMeetUrl(appt: Appointment): string | undefined {
  const url = appt.extension?.find((e) => e.url === EXT.telehealthUrl)?.valueUrl;
  return url && validMeetUrl(url) ? url : undefined;
}

/**
 * Appointments the worker should mint a meeting link for: a confirmed video visit that starts inside
 * the horizon and has no valid link yet. An existing link is left untouched — that is what makes the
 * provisioning pass safe to retry, alongside the adapter's own idempotency.
 */
export function meetProvisionPlan(appts: readonly Appointment[], now = new Date(), horizonDays = 60): Appointment[] {
  const from = now.getTime();
  const to = from + horizonDays * 86400000;
  return appts.filter((a) => {
    const start = a.start ? Date.parse(a.start) : Number.NaN;
    return (
      !!a.id &&
      Number.isFinite(start) &&
      start > from &&
      start <= to &&
      MEET_PROVISION_STATUSES.includes(a.status) &&
      appointmentModality(a) === 'video' &&
      !appointmentMeetUrl(a)
    );
  });
}
