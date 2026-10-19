// Telehealth meeting provisioning (Google Meet). Vendor-neutral like the other worker adapters:
//   - "sandbox" (default): mints a deterministic meet.google.com link and calls nothing, so the whole
//     scheduling → check-in → join flow works locally on synthetic data;
//   - "google": creates a real Google Meet link through a Workspace service account (Calendar API
//     with conferenceData), impersonating the calendar owner via domain-wide delegation.
//
// The scheduling integration must never create two meetings for the same visit, even across retries:
//   - the appointment id is the idempotency key;
//   - the calendar event id is derived from it, so a retried insert returns 409 and the adapter reads
//     the existing event back instead of making a second meeting;
//   - provisioning only writes when the appointment has no valid link yet.
// See TELEHEALTH-SCRIBE-PLAN.md §P22 ("scheduling integration must not create repeated meetings on
// retry").

import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { createHash, createSign } from 'node:crypto';
import { EXT, PRACTICE_TIME_ZONE, appointmentMeetUrl, meetProvisionPlan, searchAll } from '@teleemon/core';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export interface MeetDetails {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

export interface MeetAdapter {
  readonly mode: string;
  /** Returns a meeting link for `key`, creating it if needed. Idempotent: the same key never yields two meetings. */
  ensureMeeting(key: string, details: MeetDetails): Promise<{ url: string; ref?: string }>;
}

/** Deterministic, valid-shaped Meet code (`abc-defg-hij`) from a stable seed. */
export function meetCode(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const pick = (i: number): string => 'abcdefghijklmnopqrstuvwxyz'[digest[i] % 26] as string;
  return `${pick(0)}${pick(1)}${pick(2)}-${pick(3)}${pick(4)}${pick(5)}${pick(6)}-${pick(7)}${pick(8)}${pick(9)}`;
}

/** The synthetic link shape used until Google credentials are configured. */
export const sandboxMeetUrl = (seed: string): string => `https://meet.google.com/${meetCode(seed)}`;

/** Local stand-in for the scheduling integration: a stable link derived from the appointment id. */
export class SandboxMeetAdapter implements MeetAdapter {
  readonly mode = 'sandbox';
  async ensureMeeting(key: string, _details: MeetDetails): Promise<{ url: string; ref?: string }> {
    return { url: sandboxMeetUrl(key) };
  }
}

export interface GoogleMeetConfig {
  readonly clientEmail: string;
  readonly privateKey: string;
  /** Calendar that owns the meeting; the service account needs writer access (or domain-wide delegation). */
  readonly calendarId: string;
  /** Workspace user to impersonate (required for a service account without shared-calendar access). */
  readonly subject?: string;
}

interface GoogleEvent {
  readonly conferenceData?: { readonly entryPoints?: readonly { readonly entryPointType?: string; readonly uri?: string }[] };
  readonly hangoutLink?: string;
  readonly error?: { readonly message?: string };
}

function meetUri(event: GoogleEvent): string | undefined {
  return event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? event.hangoutLink;
}

/** A deterministic, Google-legal (base32hex) event id derived from the appointment id. */
export function googleEventId(appointmentId: string): string {
  return `teleemon${createHash('sha256').update(appointmentId).digest('hex').slice(0, 32)}`;
}

/** Signs an RS256 service-account assertion for the OAuth 2.0 JWT bearer flow. Pure; no network. */
export function signServiceAccountJwt(opts: {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly scope: string;
  readonly subject?: string;
  readonly now?: Date;
  readonly lifetimeSeconds?: number;
}): string {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: opts.clientEmail,
    scope: opts.scope,
    aud: OAUTH_TOKEN_URL,
    iat: now,
    exp: now + (opts.lifetimeSeconds ?? 3600),
    ...(opts.subject ? { sub: opts.subject } : {}),
  };
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${b64(header)}.${b64(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(opts.privateKey).toString('base64url')}`;
}

/** Google Meet via the Calendar API: one event per appointment, with a Meet conference attached. */
export class GoogleMeetAdapter implements MeetAdapter {
  readonly mode = 'google';
  constructor(private readonly config: GoogleMeetConfig) {}

  async ensureMeeting(key: string, details: MeetDetails): Promise<{ url: string; ref?: string }> {
    const eventId = googleEventId(key);
    const token = await this.accessToken();
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}/events`;
    const res = await fetch(`${base}?conferenceDataVersion=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: eventId,
        summary: details.summary,
        start: { dateTime: details.start, timeZone: details.timeZone },
        end: { dateTime: details.end, timeZone: details.timeZone },
        conferenceData: { createRequest: { requestId: eventId } },
      }),
    });
    if (res.status === 409) {
      // A previous attempt already created this meeting: read it back rather than make a second one.
      const existing = await fetch(`${base}/${eventId}?conferenceDataVersion=1`, { headers: { Authorization: `Bearer ${token}` } });
      const json = (await existing.json()) as GoogleEvent;
      const url = meetUri(json);
      if (!existing.ok || !url) throw new Error(`The existing Google Meet event could not be read: ${json.error?.message ?? existing.status}`);
      return { url, ref: eventId };
    }
    const json = (await res.json()) as GoogleEvent;
    const url = meetUri(json);
    if (!res.ok || !url) throw new Error(`Google Meet refused the meeting: ${json.error?.message ?? res.status}`);
    return { url, ref: eventId };
  }

  private async accessToken(): Promise<string> {
    const assertion = signServiceAccountJwt({ clientEmail: this.config.clientEmail, privateKey: this.config.privateKey, scope: CALENDAR_SCOPE, subject: this.config.subject });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
    return json.access_token;
  }
}

function serviceAccount(): { clientEmail: string; privateKey: string } | undefined {
  const json = process.env.GOOGLE_MEET_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
      if (parsed.client_email && parsed.private_key) return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
    } catch {
      throw new Error('GOOGLE_MEET_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }
  const clientEmail = process.env.GOOGLE_MEET_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_MEET_PRIVATE_KEY?.replace(/\\n/g, '\n');
  return clientEmail && privateKey ? { clientEmail, privateKey } : undefined;
}

export function meetAdapterFromEnv(): MeetAdapter {
  const vendor = process.env.MEET_VENDOR ?? 'sandbox';
  if (vendor === 'sandbox') return new SandboxMeetAdapter();
  if (vendor === 'google') {
    const account = serviceAccount();
    if (!account) throw new Error('MEET_VENDOR=google needs GOOGLE_MEET_SERVICE_ACCOUNT_JSON, or GOOGLE_MEET_CLIENT_EMAIL and GOOGLE_MEET_PRIVATE_KEY.');
    return new GoogleMeetAdapter({
      ...account,
      calendarId: process.env.GOOGLE_MEET_CALENDAR_ID ?? 'primary',
      subject: process.env.GOOGLE_MEET_IMPERSONATE,
    });
  }
  throw new Error(`Meeting vendor "${vendor}" has no adapter yet. Use MEET_VENDOR=sandbox until the Google integration is configured.`);
}

/** The adapter mode for the startup line; a misconfiguration is reported, not fatal. */
export function meetLabel(): string {
  try {
    return meetAdapterFromEnv().mode;
  } catch (err) {
    return `unavailable (${normalizeErrorString(err)})`;
  }
}

function meetDetails(appt: Appointment): MeetDetails {
  return {
    summary: `Teleemon · ${appt.appointmentType?.text ?? 'Video visit'}`,
    start: appt.start as string,
    end: appt.end as string,
    timeZone: PRACTICE_TIME_ZONE,
  };
}

export interface MeetProvisionResult {
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * One pass: give every confirmed video appointment inside the horizon a meeting link, unless it
 * already has one. A failure is logged and never thrown, so one bad appointment cannot stop the tick.
 */
export async function provisionMeetLinks(medplum: MedplumClient, adapter: MeetAdapter, now = new Date(), horizonDays = 60): Promise<MeetProvisionResult> {
  const result = { created: 0, skipped: 0, failed: 0 };
  const candidates = await searchAll(medplum, 'Appointment', { date: `ge${now.toISOString()}`, status: 'booked,arrived,checked-in', _count: '200' });
  for (const listed of meetProvisionPlan(candidates, now, horizonDays)) {
    try {
      // Re-read so two passes cannot both mint a meeting: the stored link is the marker.
      const appt = await medplum.readResource('Appointment', listed.id as string, { cache: 'no-cache' });
      if (appointmentMeetUrl(appt)) {
        result.skipped++;
        continue;
      }
      const meeting = await adapter.ensureMeeting(appt.id as string, meetDetails(appt));
      const extension = [
        ...(appt.extension ?? []).filter((e) => e.url !== EXT.telehealthUrl && e.url !== EXT.meetSpace && e.url !== EXT.meetProvisionedAt),
        { url: EXT.telehealthUrl, valueUrl: meeting.url },
        ...(meeting.ref ? [{ url: EXT.meetSpace, valueString: meeting.ref }] : []),
        { url: EXT.meetProvisionedAt, valueDateTime: now.toISOString() },
      ];
      await medplum.updateResource({ ...appt, extension }, { headers: { 'If-Match': `W/"${appt.meta?.versionId}"` } });
      result.created++;
    } catch (err) {
      result.failed++;
      console.error(`[worker] meet link for ${listed.id} failed: ${normalizeErrorString(err)}`);
    }
  }
  return result;
}
