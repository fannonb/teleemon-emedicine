// Message transports. "log" is the default until a vendor is chosen (decision D7): it records
// exactly what would have been sent, so reminder rules can be verified without sending anything.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SendResult {
  readonly id: string;
  readonly detail: string;
}

export interface Transport {
  readonly channel: 'sms' | 'email';
  readonly mode: string;
  send(to: string, text: string, subject?: string): Promise<SendResult>;
}

const OUTBOX = join(dirname(fileURLToPath(import.meta.url)), '..', 'outbox.log');

/** Writes the message to services/worker/outbox.log (synthetic data only) instead of sending it. */
export class LogTransport implements Transport {
  readonly mode = 'log';
  constructor(readonly channel: 'sms' | 'email') {}
  async send(to: string, text: string, subject?: string): Promise<SendResult> {
    mkdirSync(dirname(OUTBOX), { recursive: true });
    const id = `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    appendFileSync(OUTBOX, `${JSON.stringify({ at: new Date().toISOString(), id, channel: this.channel, to, subject, text })}\n`);
    return { id, detail: `Recorded by the log transport (no ${this.channel === 'sms' ? 'SMS' : 'email'} vendor configured)` };
  }
}

/** Twilio Programmable Messaging. Requires a BAA-covered (HIPAA-eligible) Twilio account. */
export class TwilioTransport implements Transport {
  readonly channel = 'sms' as const;
  readonly mode = 'twilio';
  constructor(
    private readonly sid: string,
    private readonly token: string,
    private readonly from: string
  ) {}
  async send(to: string, text: string): Promise<SendResult> {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: toE164(to), From: this.from, Body: text }),
    });
    const json = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new Error(`Twilio rejected the message: ${json.message ?? res.status}`);
    return { id: json.sid, detail: 'Sent via Twilio' };
  }
}

export function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export function transportsFromEnv(): { sms: Transport; email: Transport } {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  const sms = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM ? new TwilioTransport(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM) : new LogTransport('sms');
  // Email uses the log transport until an email vendor with a BAA is chosen for the GCP deployment.
  return { sms, email: new LogTransport('email') };
}
