// Scheduling rules (P04, P05): visit types, practice hours, slot generation, conflicts, repeats.
// Times are UTC instants; wall-clock calculations use the practice time zone.

import type { Appointment, Slot } from '@medplum/fhirtypes';
import type { Modality } from './fhir';
import { PRACTICE_TIME_ZONE } from './fhir';
import { zonedDate, zonedTime } from './time';

export interface VisitType {
  readonly code: string;
  readonly label: string;
  readonly minutes: number;
  readonly modality: Modality;
  /** Self-pay price in USD (good-faith estimate basis). Confirmed by the practice in P40. */
  readonly selfPay: number;
  /** Measures sent before the visit (Phase 7 portal). */
  readonly measures: string[];
  /** Default codes for the billing panel (Phase 3). */
  readonly codes: string[];
  readonly newPatient?: boolean;
}

export const VISIT_TYPES: readonly VisitType[] = [
  { code: 'new-eval', label: 'New patient evaluation', minutes: 60, modality: 'video', selfPay: 350, measures: ['phq9', 'gad7', 'asrs-a', 'audit-c'], codes: ['90792'], newPatient: true },
  { code: 'med-mgmt', label: 'Medication management', minutes: 30, modality: 'video', selfPay: 175, measures: ['phq9', 'gad7'], codes: ['99214'] },
  { code: 'med-mgmt-therapy', label: 'Med management + psychotherapy', minutes: 45, modality: 'video', selfPay: 250, measures: ['phq9', 'gad7'], codes: ['99214', '90836'] },
  { code: 'brief', label: 'Brief check-in', minutes: 15, modality: 'video', selfPay: 95, measures: [], codes: ['99212'] },
  { code: 'office-med-mgmt', label: 'Medication management (office)', minutes: 30, modality: 'office', selfPay: 175, measures: ['phq9', 'gad7'], codes: ['99214'] },
];

export function findVisitType(code: string | undefined): VisitType | undefined {
  return VISIT_TYPES.find((v) => v.code === code);
}

/** Opening hours per weekday (0 = Sunday), wall clock in the practice zone. Scope: Mon–Sat 9 AM – 9 PM. */
export interface Hours {
  readonly [weekday: number]: { open: string; close: string } | undefined;
}

export const DEFAULT_HOURS: Hours = {
  1: { open: '09:00', close: '21:00' },
  2: { open: '09:00', close: '21:00' },
  3: { open: '09:00', close: '21:00' },
  4: { open: '09:00', close: '21:00' },
  5: { open: '09:00', close: '21:00' },
  6: { open: '09:00', close: '21:00' },
};

export const SLOT_MINUTES = 15;
export const ACTIVE_STATUSES: Appointment['status'][] = ['proposed', 'pending', 'booked', 'arrived', 'checked-in', 'waitlist'];

export interface Interval {
  readonly start: string;
  readonly end: string;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function weekday(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

export function hoursFor(ymd: string, hours: Hours = DEFAULT_HOURS, closures: string[] = []): Interval | undefined {
  if (closures.includes(ymd)) return undefined;
  const h = hours[weekday(ymd)];
  if (!h) return undefined;
  const [oh, om] = h.open.split(':').map(Number);
  const [ch, cm] = h.close.split(':').map(Number);
  return { start: zonedTime(ymd, oh, om, PRACTICE_TIME_ZONE).toISOString(), end: zonedTime(ymd, ch, cm, PRACTICE_TIME_ZONE).toISOString() };
}

export function isWithinHours(interval: Interval, hours: Hours = DEFAULT_HOURS, closures: string[] = []): boolean {
  const open = hoursFor(zonedDate(new Date(interval.start)), hours, closures);
  return !!open && interval.start >= open.start && interval.end <= open.end;
}

/** Appointments and blocked time that occupy the provider. */
export function busyIntervals(appointments: Appointment[], blocked: Slot[], excludeId?: string): (Interval & { kind: 'appointment' | 'blocked'; id?: string })[] {
  return [
    ...appointments
      .filter((a) => a.id !== excludeId && ACTIVE_STATUSES.includes(a.status) && a.start && a.end)
      .map((a) => ({ start: a.start as string, end: a.end as string, kind: 'appointment' as const, id: a.id })),
    ...blocked.filter((s) => s.status === 'busy-unavailable').map((s) => ({ start: s.start, end: s.end, kind: 'blocked' as const, id: s.id })),
  ];
}

/** Free start times on a day for a visit of `minutes`, on the 15-minute grid, excluding the past. */
export function availableStarts(ymd: string, minutes: number, busy: Interval[], opts: { hours?: Hours; closures?: string[]; now?: Date } = {}): string[] {
  const open = hoursFor(ymd, opts.hours, opts.closures);
  if (!open) return [];
  const now = (opts.now ?? new Date()).toISOString();
  const result: string[] = [];
  for (let t = Date.parse(open.start); t + minutes * 60000 <= Date.parse(open.end); t += SLOT_MINUTES * 60000) {
    const candidate = { start: new Date(t).toISOString(), end: new Date(t + minutes * 60000).toISOString() };
    if (candidate.start < now) continue;
    if (!busy.some((b) => overlaps(candidate, b))) result.push(candidate.start);
  }
  return result;
}

export type Repeat = 'none' | 'weekly' | 'every-2-weeks' | 'every-4-weeks';
export const REPEAT_DAYS: Record<Repeat, number> = { none: 0, weekly: 7, 'every-2-weeks': 14, 'every-4-weeks': 28 };

/** Start instants for a repeating booking, keeping the same wall-clock time across DST changes. */
export function repeatStarts(firstStart: string, repeat: Repeat, count: number): string[] {
  if (repeat === 'none' || count <= 1) return [firstStart];
  const first = new Date(firstStart);
  const ymd = zonedDate(first);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PRACTICE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(first);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(Date.parse(`${ymd}T12:00:00Z`) + i * REPEAT_DAYS[repeat] * 86400000).toISOString().slice(0, 10);
    out.push(zonedTime(day, hour, minute, PRACTICE_TIME_ZONE).toISOString());
  }
  return out;
}

export const CANCELLATION_REASONS = [
  { code: 'patient-request', label: 'Patient request' },
  { code: 'late-cancel', label: 'Late cancellation (under 24 hours)' },
  { code: 'provider-unavailable', label: 'Provider unavailable' },
  { code: 'unlicensed-location', label: 'Patient not in a licensed state' },
  { code: 'insurance', label: 'Insurance or payment issue' },
  { code: 'other', label: 'Other' },
] as const;
