import type { MedplumClient } from '@medplum/core';
import { getExtensionValue } from '@medplum/core';
import type { Appointment, Bundle, Patient, Practitioner, Resource, Schedule, Slot } from '@medplum/fhirtypes';
import type { Modality } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, PRACTICE_TIME_ZONE, findVisitType } from '@teleemon/core';

export interface CalendarItem {
  readonly appointment: Appointment;
  readonly patient?: Patient;
  readonly practitionerRef?: string;
  readonly modality?: Modality;
  readonly locationState?: string;
  readonly visitLabel: string;
}

export interface Provider {
  readonly practitioner: Practitioner;
  readonly schedule: Schedule;
}

/** Providers are practitioners with a Schedule (the calendar's columns and filter). */
export async function loadProviders(medplum: MedplumClient): Promise<Provider[]> {
  const bundle = await medplum.search('Schedule', { active: 'true', _include: 'Schedule:actor', _count: '50' }, { cache: 'no-cache' });
  const practitioners = new Map<string, Practitioner>();
  const schedules: Schedule[] = [];
  for (const e of bundle.entry ?? []) {
    const r = e.resource as Resource | undefined;
    if (r?.resourceType === 'Practitioner') practitioners.set(`Practitioner/${r.id}`, r);
    if (r?.resourceType === 'Schedule') schedules.push(r);
  }
  return schedules.flatMap((schedule) => {
    const ref = schedule.actor.find((a) => a.reference?.startsWith('Practitioner/'))?.reference;
    const practitioner = ref ? practitioners.get(ref) : undefined;
    return practitioner ? [{ practitioner, schedule }] : [];
  });
}

export function toItem(appointment: Appointment, patients: Map<string, Patient>): CalendarItem {
  const patientRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  const code = appointment.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code;
  return {
    appointment,
    patient: patientRef ? patients.get(patientRef) : undefined,
    practitionerRef: appointment.participant.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference,
    modality: getExtensionValue(appointment, EXT.modality) as Modality | undefined,
    locationState: getExtensionValue(appointment, EXT.patientLocationState) as string | undefined,
    visitLabel: findVisitType(code)?.label ?? appointment.appointmentType?.text ?? 'Visit',
  };
}

/** Appointments (with patients) and blocked time in [start, end). */
export async function loadRange(medplum: MedplumClient, start: string, end: string): Promise<{ items: CalendarItem[]; blocked: Slot[] }> {
  const [bundle, blocked] = await Promise.all([
    medplum.search(
      'Appointment',
      new URLSearchParams([
        ['date', `ge${start}`],
        ['date', `lt${end}`],
        ['_include', 'Appointment:patient'],
        ['_sort', 'date'],
        ['_count', '1000'],
      ]),
      { cache: 'no-cache' }
    ),
    medplum
      .searchResources(
        'Slot',
        new URLSearchParams([
          ['status', 'busy-unavailable'],
          ['start', `ge${new Date(Date.parse(start) - 86400000).toISOString()}`],
          ['start', `lt${end}`],
          ['_count', '500'],
        ]),
        { cache: 'no-cache' }
      )
      .catch(() => [] as Slot[]),
  ]);
  const patients = new Map<string, Patient>();
  const appointments: Appointment[] = [];
  for (const e of (bundle as Bundle).entry ?? []) {
    const r = e.resource as Resource | undefined;
    if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
    if (r?.resourceType === 'Appointment') appointments.push(r);
  }
  return { items: appointments.map((a) => toItem(a, patients)), blocked };
}

/** A calendar invite with no clinical detail (P05: "Sends confirmation and calendar invite"). */
export function buildIcs(appointment: Appointment, opts: { location?: string; organizer?: string } = {}): string {
  const fmt = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string): string => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Teleemon//Care Platform//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@teleemon`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(appointment.start as string)}`,
    `DTEND:${fmt(appointment.end as string)}`,
    'SUMMARY:Appointment with Teleemon',
    `DESCRIPTION:${esc('Check in from the patient portal whenever you are ready. Your provider will start the visit when ready. Confirm the state you are physically in; your provider must be licensed there. In a crisis call or text 988.')}`,
    ...(opts.location ? [`LOCATION:${esc(opts.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

export function downloadIcs(appointment: Appointment, location?: string): void {
  const blob = new Blob([buildIcs(appointment, { location })], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'teleemon-appointment.ics';
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Wall-clock HH:MM and YYYY-MM-DD in the practice zone. */
export function practiceParts(iso: string): { ymd: string; hhmm: string } {
  const d = new Date(iso);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: PRACTICE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: PRACTICE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { ymd, hhmm };
}

export function minutesOfDay(iso: string): number {
  const [h, m] = practiceParts(iso).hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Monday of the week containing `ymd`. */
export function weekStart(ymd: string): string {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return addDays(ymd, day === 0 ? -6 : 1 - day);
}

export function dayLabel(ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(`${ymd}T12:00:00Z`));
}
