// Patient portal and public booking rules (X01–X09; SYSTEM-DESIGN.md §5.2, §6, ADR-012). Shared by
// the portal app (immediate feedback), the portal service (authoritative for portal writes) and the
// appointment, patient, message and task Bots, so every surface gives the same answer.

import type { Appointment, Communication, Encounter, Patient } from '@medplum/fhirtypes';
import type { Hours, VisitType } from './scheduling';
import { SLOT_MINUTES, VISIT_TYPES, isWithinHours } from './scheduling';
import { CODE_SYSTEMS, EXT, PRACTICE_TIME_ZONE, US_CORE_ETHNICITY, US_CORE_RACE } from './fhir';
import { ageInYears } from './time';

export const PORTAL_RULES = {
  /** An unconfirmed public booking holds its time this long, then is released. */
  holdMinutes: 60,
  /** Earliest online booking: returning patients 2 hours ahead, new patients the next day. */
  minLeadHours: 2,
  newPatientLeadHours: 24,
  maxDaysAhead: 60,
  /** Cancelling within 24 hours is recorded as a late cancellation. */
  lateCancelHours: 24,
  inviteHours: 72,
  minPasswordLength: 12,
  maxMessageLength: 4000,
  /**
   * How long a location confirmation stays usable. A patient may check in early, but if they confirm
   * long before the visit they must confirm again when they return to join, because they may have
   * moved to a state the provider is not licensed in.
   */
  locationFreshHours: 6,
} as const;

export type BookingChannel = 'online' | 'portal';

/** Shown on every portal page, signed in or not. */
export const CRISIS_LINES = {
  lifeline: 'Call or text 988 (Suicide & Crisis Lifeline), 24 hours a day.',
  emergency: 'In an emergency, call 911 or go to the nearest emergency department.',
  notMonitored: 'Portal messages are not monitored around the clock. Do not use them for emergencies.',
} as const;

/** Visit types offered online: new patients book an evaluation; returning patients book follow-ups. Office visits are booked by staff. */
export const ONLINE_VISIT_CODES = { new: ['new-eval'], returning: ['med-mgmt', 'med-mgmt-therapy', 'brief'] } as const;

export function onlineVisitTypes(newPatient: boolean): VisitType[] {
  const codes: readonly string[] = newPatient ? ONLINE_VISIT_CODES.new : ONLINE_VISIT_CODES.returning;
  return VISIT_TYPES.filter((v) => codes.includes(v.code));
}

/**
 * Visit types a signed-in patient may book: a new patient evaluation until they have had a visit
 * (and only if none is already booked), then follow-ups.
 */
export function portalVisitTypes(history: readonly Appointment[], now = new Date()): VisitType[] {
  const code = (a: Appointment): string | undefined => a.appointmentType?.coding?.find((c) => c.system === CODE_SYSTEMS.visitType)?.code;
  const seen = history.some((a) => a.status === 'fulfilled' || a.status === 'checked-in' || a.status === 'arrived');
  if (seen) return onlineVisitTypes(false);
  const evalBooked = history.some((a) => code(a) === 'new-eval' && ['booked', 'pending'].includes(a.status) && Date.parse(a.start ?? '') > now.getTime());
  return evalBooked ? [] : onlineVisitTypes(true);
}

export function bookingChannel(appt: Appointment): BookingChannel | undefined {
  const value = appt.extension?.find((e) => e.url === EXT.bookingChannel)?.valueCode;
  return value === 'online' || value === 'portal' ? value : undefined;
}

export interface OnlineBookingInput {
  readonly channel: BookingChannel;
  readonly visitType: string | undefined;
  readonly start: string | undefined;
  readonly end?: string;
  readonly state: string | undefined;
  readonly now?: Date;
  readonly hours?: Hours;
  readonly closures?: string[];
}

/**
 * Why an online booking is refused, or undefined. Licensure and conflicts are checked separately
 * (checkLicensure and the appointment Bot); this covers what only online bookings must respect.
 */
export function onlineBookingProblem(input: OnlineBookingInput): string | undefined {
  const now = input.now ?? new Date();
  // Signed-in patients may book an evaluation (no visit yet) or a follow-up; the portal service
  // chooses between them from the patient's own visit history (portalVisitTypes).
  const allowed: readonly string[] = input.channel === 'online' ? ONLINE_VISIT_CODES.new : [...ONLINE_VISIT_CODES.new, ...ONLINE_VISIT_CODES.returning];
  const type = VISIT_TYPES.find((v) => v.code === input.visitType);
  if (!type || !allowed.includes(type.code)) {
    return input.channel === 'online' ? 'Online booking for new patients is for a new patient evaluation.' : 'Choose a visit type offered online. Other visits are booked by the care team.';
  }
  if (!input.state || !/^[A-Z]{2}$/.test(input.state)) return 'Choose the state you will be in during the visit.';
  const start = Date.parse(input.start ?? '');
  if (!Number.isFinite(start)) return 'Choose an available time.';
  const date = new Date(start);
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0 || date.getUTCMinutes() % SLOT_MINUTES !== 0) return 'Choose one of the available times.';
  const end = start + type.minutes * 60000;
  if (input.end !== undefined && Date.parse(input.end) !== end) return `A ${type.label.toLowerCase()} lasts ${type.minutes} minutes.`;
  const newPatient = type.newPatient === true;
  const lead = (newPatient ? PORTAL_RULES.newPatientLeadHours : PORTAL_RULES.minLeadHours) * 3600000;
  if (start < now.getTime() + lead) {
    return newPatient ? 'New patient visits can be booked online from 24 hours ahead.' : `Online bookings need at least ${PORTAL_RULES.minLeadHours} hours' notice. Call us for something sooner.`;
  }
  if (start > now.getTime() + PORTAL_RULES.maxDaysAhead * 86400000) return `Online booking is open up to ${PORTAL_RULES.maxDaysAhead} days ahead.`;
  if (!isWithinHours({ start: date.toISOString(), end: new Date(end).toISOString() }, input.hours, input.closures)) return 'That time is outside practice hours.';
  return undefined;
}

export function bookingEnd(start: string, visitType: string): string | undefined {
  const type = VISIT_TYPES.find((v) => v.code === visitType);
  const t = Date.parse(start);
  return type && Number.isFinite(t) ? new Date(t + type.minutes * 60000).toISOString() : undefined;
}

export interface CancelCheck {
  readonly problem?: string;
  /** Within 24 hours of the visit: recorded as a late cancellation. */
  readonly late: boolean;
}

export function cancelCheck(appt: Appointment, now = new Date()): CancelCheck {
  const start = Date.parse(appt.start ?? '');
  const late = Number.isFinite(start) && start - now.getTime() < PORTAL_RULES.lateCancelHours * 3600000;
  if (!['booked', 'pending', 'proposed'].includes(appt.status)) return { late, problem: 'This visit can no longer be cancelled online.' };
  if (!Number.isFinite(start) || start <= now.getTime()) return { late, problem: 'This visit has already started. Call us if you cannot attend.' };
  return { late };
}

function hasValidVisitTime(appt: Appointment): boolean {
  const start = Date.parse(appt.start ?? '');
  const end = Date.parse(appt.end ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Visit status, not scheduled clock time, determines whether a visit remains actionable. */
export function isActivePortalVisit(appt: Appointment): boolean {
  return ['booked', 'pending', 'arrived', 'checked-in'].includes(appt.status);
}

/** Choose a useful Home visit without hiding active visits from the Visits list. */
export function nextActivePortalVisit(appointments: readonly Appointment[], now = new Date()): Appointment | undefined {
  const active = appointments
    .filter(isActivePortalVisit)
    .map((appointment) => ({
      appointment,
      start: Date.parse(appointment.start ?? ''),
      end: Date.parse(appointment.end ?? ''),
    }))
    .filter((item) => Number.isFinite(item.start));
  const current = active
    .filter((item) => Number.isFinite(item.end) && item.start <= now.getTime() && now.getTime() < item.end)
    .sort((a, b) => a.end - b.end || b.start - a.start)[0];
  if (current) return current.appointment;

  const future = active
    .filter((item) => item.start > now.getTime())
    .sort((a, b) => a.start - b.start)[0];
  if (future) return future.appointment;

  return active.sort((a, b) => b.start - a.start)[0]?.appointment;
}

export interface LocationConfirmation {
  readonly by?: string;
  readonly at?: string;
  readonly state?: string;
}

/** The same by/at/state shape is used whenever a location is confirmed, by patient, staff or provider. */
function readConfirmation(extension: Appointment['extension'] | Encounter['extension'], url: string): LocationConfirmation | undefined {
  const e = extension?.find((x) => x.url === url);
  if (!e) return undefined;
  const sub = (name: string) => e.extension?.find((x) => x.url === name);
  return { by: sub('by')?.valueReference?.reference, at: sub('at')?.valueDateTime, state: sub('state')?.valueCode };
}

export function locationConfirmation(appt: Appointment): LocationConfirmation | undefined {
  return readConfirmation(appt.extension, EXT.locationConfirmed);
}

export function locationConfirmedExtension(by: string, state: string, at = new Date()): NonNullable<Appointment['extension']>[number] {
  return { url: EXT.locationConfirmed, extension: [{ url: 'by', valueReference: { reference: by } }, { url: 'at', valueDateTime: at.toISOString() }, { url: 'state', valueCode: state }] };
}

/** The provider's own on-camera confirmation at visit start, recorded on the Encounter. */
export function providerLocationConfirmation(encounter: Encounter): LocationConfirmation | undefined {
  return readConfirmation(encounter.extension, EXT.providerLocationConfirmed);
}

export function providerLocationConfirmedExtension(by: string, state: string, at = new Date()): NonNullable<Encounter['extension']>[number] {
  return { url: EXT.providerLocationConfirmed, extension: [{ url: 'by', valueReference: { reference: by } }, { url: 'at', valueDateTime: at.toISOString() }, { url: 'state', valueCode: state }] };
}

/** A confirmation is only usable for a while; a patient who checked in long before the visit confirms again. */
export function locationConfirmationFresh(appt: Appointment, now = new Date()): boolean {
  const at = Date.parse(locationConfirmation(appt)?.at ?? '');
  return Number.isFinite(at) && now.getTime() - at <= PORTAL_RULES.locationFreshHours * 3600000;
}

/** Check-in is available for any booked visit: early, and again if an earlier confirmation has gone stale. */
export function checkInProblem(appt: Appointment, now = new Date()): string | undefined {
  if (appt.status === 'arrived' || appt.status === 'checked-in') {
    return locationConfirmationFresh(appt, now) ? 'You are already checked in.' : undefined;
  }
  if (appt.status !== 'booked') return 'Only a booked visit can be checked in.';
  if (!hasValidVisitTime(appt)) return 'This visit has no valid time set. Call us.';
  return undefined;
}

/** The join link is released only after check-in with a confirmed, still-recent location. */
export function joinProblem(appt: Appointment, now = new Date()): string | undefined {
  if (appt.status !== 'arrived' && appt.status !== 'checked-in') return 'Check in and confirm your location first.';
  const confirmed = locationConfirmation(appt);
  if (!confirmed?.state || !confirmed.at) return 'Check in and confirm your location first.';
  if (!locationConfirmationFresh(appt, now)) return 'Confirm your location again before joining: it has been a while since you checked in.';
  return undefined;
}

// ---- Proxies (X09; SYSTEM-DESIGN.md §13 question 1) ----

/**
 * Age from which a minor controls access to their own outpatient mental-health records, by the
 * state the patient lives in. PLACEHOLDER VALUES PENDING COUNSEL (open question 1): they are
 * deliberately conservative, and an unknown state uses the lowest age, which restricts proxies most.
 */
export const MINOR_CONFIDENTIALITY_AGE: Record<string, number> = { WA: 13, CA: 12, CO: 12, RI: 14 };
export const DEFAULT_MINOR_CONFIDENTIALITY_AGE = 12;
export const MINOR_RULES_STATUS = 'Placeholder ages pending legal review (SYSTEM-DESIGN.md §13, question 1).';

/**
 * - full: the proxy sees what the patient sees (a parent of a young child);
 * - limited: scheduling, check-in, demographics and insurance only; no visit summaries, messages,
 *   intake answers, measures or medications (a minor old enough to control their records);
 * - none: adult patients; a proxy for an adult needs a signed authorization (not offered yet).
 */
export type ProxyLevel = 'full' | 'limited' | 'none';

export function patientHomeState(patient: Patient): string | undefined {
  const address = patient.address?.find((a) => a.use === 'home' && a.state) ?? patient.address?.find((a) => a.state);
  return address?.state?.toUpperCase();
}

export function proxyLevel(patient: Patient, now = new Date()): { level: ProxyLevel; reason: string } {
  if (!patient.birthDate) return { level: 'limited', reason: 'No date of birth on file, so proxy access is limited.' };
  const age = ageInYears(patient.birthDate, now);
  if (age >= 18) return { level: 'none', reason: 'Adult patients manage their own portal. A proxy for an adult needs a signed authorization.' };
  const state = patientHomeState(patient);
  const limit = (state && MINOR_CONFIDENTIALITY_AGE[state]) || DEFAULT_MINOR_CONFIDENTIALITY_AGE;
  return age >= limit
    ? { level: 'limited', reason: `In ${state ?? 'an unknown state'}, patients aged ${limit} and over control their mental-health records, so a parent or guardian sees scheduling and insurance only.` }
    : { level: 'full', reason: `Under ${limit} in ${state ?? 'an unknown state'}: a parent or guardian can see the portal on the patient's behalf.` };
}

// ---- Patient self-service edits (X09) ----

/**
 * Patient fields a patient (or full proxy) may change themselves; everything else is changed by
 * staff. `name` and `gender` are checked separately: only the preferred (nickname) name, and the
 * gender that matches a first-time sex at birth.
 */
const SELF_EDITABLE_FIELDS = ['telecom', 'address', 'communication', 'meta', 'text', 'contact', 'extension', 'maritalStatus', 'name', 'gender'] as const;
/** Self-pay is the patient's own declaration at intake; billing staff verify it with insurance (Phase 8). */
const SELF_EDITABLE_EXTENSIONS: string[] = [
  EXT.pronouns, EXT.contactOptOut, EXT.preferredPharmacy, EXT.selfPay,
  EXT.genderIdentity, EXT.sexualOrientation, EXT.employmentStatus, US_CORE_RACE, US_CORE_ETHNICITY,
];
export const SEX_AT_BIRTH_CODES = ['female', 'male', 'unknown'] as const;
/** Patient.gender kept in step with sex assigned at birth, as staff registration does. */
export const genderForSex = (sex: string | undefined): Patient['gender'] => (sex === 'female' ? 'female' : sex === 'male' ? 'male' : 'unknown');
export const sexAtBirth = (p: Patient | undefined): string | undefined => p?.extension?.find((e) => e.url === EXT.sexAssignedAtBirth)?.valueCode;

const isGuardian = (c: NonNullable<Patient['contact']>[number]): boolean => !!c.relationship?.some((r) => r.coding?.some((x) => x.code === 'GUARD'));

/** JSON with sorted keys, so equal content compares equal whatever the key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Why a patient's own edit of their record is refused, or undefined. Patients can change contact
 * details, address, pronouns, preferred pharmacy, text-message preference and emergency contacts;
 * never their name, date of birth, identifiers, guardian, chart flags or card on file.
 */
export function patientSelfEditProblem(before: Patient | undefined, after: Patient): string | undefined {
  if (!before) return 'Patients cannot create records from the portal.';
  const fixed = (p: Patient): Record<string, unknown> =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !(SELF_EDITABLE_FIELDS as readonly string[]).includes(k)));
  const legalNames = (p: Patient): string => stableJson((p.name ?? []).filter((n) => n.use !== 'nickname'));
  if (stableJson(fixed(before)) !== stableJson(fixed(after)) || legalNames(before) !== legalNames(after)) {
    return 'Your name, date of birth and other registration details can only be changed by the care team. Send us a message.';
  }
  // Sex assigned at birth: the patient records it once; corrections are made by the care team.
  const sexBefore = sexAtBirth(before);
  const sexAfter = sexAtBirth(after);
  if (sexBefore && sexAfter !== sexBefore) return 'Sex assigned at birth can only be corrected by the care team. Send us a message.';
  if (!sexBefore && sexAfter && !(SEX_AT_BIRTH_CODES as readonly string[]).includes(sexAfter)) return 'Choose a sex assigned at birth from the list.';
  const genderSetWithSex = !sexBefore && !!sexAfter && after.gender === genderForSex(sexAfter);
  if ((after.gender ?? null) !== (before.gender ?? null) && !genderSetWithSex) return 'That detail can only be changed by the care team.';
  const lockedExt = (p: Patient): string => stableJson((p.extension ?? []).filter((e) => !SELF_EDITABLE_EXTENSIONS.includes(e.url) && e.url !== EXT.sexAssignedAtBirth));
  if (lockedExt(before) !== lockedExt(after)) return 'That detail can only be changed by the care team.';
  const guardians = (p: Patient): string => stableJson((p.contact ?? []).filter(isGuardian));
  if (guardians(before) !== guardians(after)) return 'Guardian details can only be changed by the care team.';
  if (stableJson(before.meta?.security ?? []) !== stableJson(after.meta?.security ?? [])) return 'That detail can only be changed by the care team.';
  return undefined;
}

export const isPortalAuthor = (author: string | undefined): boolean => !!author && (author.startsWith('Patient/') || author.startsWith('RelatedPerson/'));

// ---- Messages (X05) ----

export const PORTAL_MESSAGE = 'portal-message';
export const PORTAL_REPLY = 'portal-reply';

export function communicationCategory(c: Communication): string | undefined {
  return c.category?.flatMap((x) => x.coding ?? []).find((x) => x.system === CODE_SYSTEMS.communicationCategory)?.code;
}

/** Inbound patient messages that staff must handle: texts and portal messages. */
export const PATIENT_MESSAGE_CATEGORIES = ['sms-reply', PORTAL_MESSAGE] as const;

export function isPatientMessage(c: Communication): boolean {
  return (PATIENT_MESSAGE_CATEGORIES as readonly string[]).includes(communicationCategory(c) ?? '');
}

const CRISIS = /\b(suicid\w*|kill(ing)? (my ?self|myself)|end(ing)? (my life|it all)|take my (own )?life|want to die|better off dead|overdos\w*|self[- ]?harm\w*|hurt(ing)? (my ?self|myself)|cutting myself|no reason to live)\b/i;

/** Messages that may describe a crisis are marked urgent for staff, and the portal shows 988 and 911 at once. */
export function crisisLanguage(text: string): boolean {
  return CRISIS.test(text);
}

/** Why a message from the portal is refused, or undefined. */
export function portalMessageProblem(msg: Communication, author: string | undefined, patientRef: string | undefined): string | undefined {
  if (communicationCategory(msg) !== PORTAL_MESSAGE) return 'Portal messages use the portal message category.';
  if (msg.status !== 'in-progress') return 'A new message is sent to the care team for review.';
  if (!author || msg.sender?.reference !== author) return 'Send messages under your own name.';
  if (!msg.subject?.reference?.startsWith('Patient/') || (patientRef && msg.subject.reference !== patientRef)) return 'A message must be about your own care.';
  const text = msg.payload?.map((p) => p.contentString ?? '').join('').trim() ?? '';
  if (!text) return 'Write a message.';
  if (text.length > PORTAL_RULES.maxMessageLength) return `Messages are limited to ${PORTAL_RULES.maxMessageLength} characters.`;
  if (msg.payload?.some((p) => p.contentAttachment || p.contentReference)) return 'Attachments are not accepted in portal messages yet.';
  return undefined;
}

// ---- Card on file (X02, Stripe test mode) ----

export interface CardOnFile {
  readonly provider: 'stripe' | 'sandbox';
  /** Payment processor IDs only (customer and payment method); never card numbers. */
  readonly customer: string;
  readonly paymentMethod: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly savedAt: string;
}

export function cardOnFile(patient: Patient | undefined): CardOnFile | undefined {
  const json = patient?.extension?.find((e) => e.url === EXT.cardOnFile)?.valueString;
  if (!json) return undefined;
  try {
    return JSON.parse(json) as CardOnFile;
  } catch {
    return undefined;
  }
}

export function formatVisitTime(iso: string, timeZone = PRACTICE_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(iso));
}
