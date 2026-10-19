// Portal email. Until an email vendor with a BAA is chosen, messages go to the worker's log
// transport (services/worker/outbox.log), exactly as reminders do. Emails carry links and times
// only: never diagnoses, medications or message content.

import { LogTransport } from '../../worker/src/transport';

const transport = new LogTransport('email');

export const portalBaseUrl = (): string => (process.env.TELEEMON_PORTAL_URL ?? 'http://localhost:3200/').replace(/\/?$/, '/');

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  await transport.send(to, `${text}\n\nIn a crisis, call or text 988. In an emergency, call 911.`, subject);
}

export function emailOf(r: { telecom?: { system?: string; value?: string }[] }): string | undefined {
  const value = r.telecom?.find((t) => t.system === 'email' && t.value)?.value?.trim().toLowerCase();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : undefined;
}

export const mailMode = (): string => transport.mode;
