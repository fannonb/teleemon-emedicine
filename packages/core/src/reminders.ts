// Appointment reminders (P42): when to send, quiet hours, message text, and inbound replies.
// Shared by the reminder-scheduler Bot, the delivery worker and the settings page.

import { PRACTICE_TIME_ZONE, US_STATE_TIME_ZONES } from './fhir';

export type Channel = 'sms' | 'email';

export interface MessagingSettings {
  /** Hours before the visit; each can be switched off. */
  readonly offsets: { hours: number; sms: boolean; email: boolean }[];
  /** Patient-local quiet hours, "HH:MM". Nothing is sent from quietStart until quietEnd. */
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly practicePhone: string;
  readonly smsTemplate: string;
  readonly emailSubject: string;
  readonly emailTemplate: string;
}

/** No clinical details in SMS or email: no visit type, provider specialty or diagnosis. */
export const DEFAULT_MESSAGING: MessagingSettings = {
  offsets: [
    { hours: 72, sms: false, email: true },
    { hours: 24, sms: true, email: true },
    { hours: 2, sms: true, email: false },
  ],
  quietStart: '21:00',
  quietEnd: '08:00',
  practicePhone: '(425) 555-0100',
  smsTemplate: 'Teleemon: Hi {firstName}, reminder of your appointment {when} ({timezone}). Reply C to confirm, STOP to opt out. Questions: {practicePhone}',
  emailSubject: 'Your upcoming appointment',
  emailTemplate:
    'Hi {firstName},\n\nThis is a reminder of your appointment {when} ({timezone}).\n\nWhen you are ready for your visit, check in from the patient portal and confirm the state you are physically in. Your provider must be licensed there. The provider will start the visit when ready.\n\nTo reschedule, call {practicePhone}.\n\nTeleemon Behavioral Health & Wellness',
};

export const MERGE_FIELDS = ['{firstName}', '{when}', '{timezone}', '{practicePhone}'] as const;

/** Words that must never appear in a reminder (guards against clinical detail in templates). */
const CLINICAL_WORDS = /(psychiatr|diagnos|medicat|therap|depress|anxiety|adhd|bipolar|prescri|controlled|substance)/i;

export function templateProblems(text: string): string[] {
  const problems: string[] = [];
  const unknown = (text.match(/\{[^}]+\}/g) ?? []).filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f));
  if (unknown.length) problems.push(`Unknown merge field ${unknown.join(', ')}`);
  if (CLINICAL_WORDS.test(text)) problems.push('Remove clinical wording: reminders must not reveal the reason for care');
  return problems;
}

export function patientTimeZone(state: string | undefined): string {
  return (state && US_STATE_TIME_ZONES[state]) || PRACTICE_TIME_ZONE;
}

export function renderReminder(template: string, values: { firstName: string; start: string; timeZone: string; practicePhone: string }): string {
  const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: values.timeZone }).format(new Date(values.start));
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: values.timeZone, timeZoneName: 'short' }).formatToParts(new Date(values.start)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return template
    .replaceAll('{firstName}', values.firstName || 'there')
    .replaceAll('{when}', when)
    .replaceAll('{timezone}', tz)
    .replaceAll('{practicePhone}', values.practicePhone);
}

function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  return Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
}

/** True when `instant` falls inside the patient's quiet hours (which may wrap past midnight). */
export function inQuietHours(instant: Date, timeZone: string, settings: Pick<MessagingSettings, 'quietStart' | 'quietEnd'> = DEFAULT_MESSAGING): boolean {
  const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const m = localMinutes(instant, timeZone);
  const s = toMin(settings.quietStart);
  const e = toMin(settings.quietEnd);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Which reminder offsets are due now for an appointment. A reminder is due once the time to the
 * visit is at most its offset, and only while at least half the offset remains (so a late booking
 * gets the nearer reminder, not a stale "72 hours" one).
 */
export function dueOffsets(start: string, now: Date, settings: MessagingSettings = DEFAULT_MESSAGING): number[] {
  const hoursLeft = (Date.parse(start) - now.getTime()) / 3600000;
  if (hoursLeft <= 0) return [];
  const due = settings.offsets.filter((o) => (o.sms || o.email) && hoursLeft <= o.hours && hoursLeft > o.hours / 2).map((o) => o.hours);
  // Only the nearest applicable reminder: never send 72h and 24h together.
  return due.length ? [Math.min(...due)] : [];
}

export function reminderKey(appointmentId: string, offsetHours: number, channel: Channel): string {
  return `reminder-${appointmentId}-${offsetHours}h-${channel}`;
}

export type InboundIntent = 'stop' | 'start' | 'help' | 'confirm' | 'other';

/** Carrier-standard keywords (TCPA/CTIA) plus "C"/"Y" to confirm a visit. */
export function classifyReply(body: string): InboundIntent {
  const word = body.trim().toUpperCase().replace(/[^A-Z]/g, ' ').trim().split(/\s+/)[0] ?? '';
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'].includes(word)) return 'stop';
  if (['START', 'UNSTOP'].includes(word)) return 'start';
  if (['HELP', 'INFO'].includes(word)) return 'help';
  if (['C', 'Y', 'CONFIRM', 'YES'].includes(word)) return 'confirm';
  return 'other';
}
