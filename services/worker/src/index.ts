// Teleemon worker (SYSTEM-DESIGN.md §3, ADR-007). Locally it is a single process:
//   - every TELEEMON_WORKER_INTERVAL seconds (default 60): run the reminder-scheduler Bot, then
//     deliver queued messages;
//   - an HTTP endpoint for inbound SMS replies: POST /webhooks/sms (Twilio form fields From, Body).
// When deployed (GCP, ADR-009) the same code runs on GKE, with Pub/Sub replacing the poll loop (ADR-007).
//
//   npm run worker            run continuously
//   npm run worker -- --once  one scheduling + delivery pass, then exit

import { MedplumClient, normalizeErrorString } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { processBilling } from './billing';
import type { BillingCounts } from './billing';
import { clearinghouseFromEnv } from './clearinghouse';
import { deliverQueued } from './deliver';
import { erxAdapterFromEnv, processPrescriptions } from './erx';
import { faxAdapterFromEnv, receiveFax, sendQueuedFaxes } from './fax';
import { ledgerFromEnv } from './ledgerClient';
import { meetAdapterFromEnv, meetLabel, provisionMeetLinks } from './meet';
import { sendDailySummaries } from './summary';
import { handleInbound } from './inbound';
import { transportsFromEnv } from './transport';
import { recordWorkerConfiguration, recordWorkerHeartbeat, recordWorkerSignal } from './operations';
import type { WorkerOperationalSignal } from '@teleemon/core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCHEDULER_BOT = 'Teleemon: reminder scheduler';

function loadEnv(): void {
  const file = join(ROOT, '.env.local');
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
}

export async function connectWorker(): Promise<MedplumClient> {
  loadEnv();
  const id = process.env.TELEEMON_WORKER_CLIENT_ID;
  const secret = process.env.TELEEMON_WORKER_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Worker client not configured. Run `npm run setup`.');
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/' });
  await medplum.startClientLogin(id, secret);
  return medplum;
}

/** One pass: queue due reminders, then deliver. */
export async function runOnce(medplum: MedplumClient, now?: Date, only?: (c: Communication) => boolean, onSignal?: (signal: WorkerOperationalSignal) => Promise<void>): Promise<string> {
  const bot = await medplum.searchOne('Bot', { 'name:exact': SCHEDULER_BOT });
  if (!bot) throw new Error(`Bot "${SCHEDULER_BOT}" not found. Run \`npm run setup\`.`);
  const scheduled = (await medplum.executeBot(bot.id as string, now ? { now: now.toISOString() } : {}, 'application/json')) as { queued: number; skipped: string[] };
  const transports = transportsFromEnv();
  const messageOutcomes: Record<'sms' | 'email', { attempts: number; failures: number; failureClass?: string }> = { sms: { attempts: 0, failures: 0 }, email: { attempts: 0, failures: 0 } };
  const delivered = await deliverQueued(medplum, transports, now, only, (channel, outcome, error) => {
    const component = messageOutcomes[channel];
    component.attempts++;
    if (outcome === 'failure') {
      component.failures++;
      component.failureClass = safeMode(error instanceof Error ? error.name : 'Error');
    }
  });
  // A filtered (verification) pass only touches the messages it names.
  const rxAdapter = only ? undefined : erxAdapterFromEnv();
  const rx = only || !rxAdapter ? undefined : await processPrescriptions(medplum, rxAdapter);
  if (rx && rx.sent + rx.failed + rx.cancelled > 0) await emitSignal(onSignal, {
    key: 'erx', label: 'E-prescribing', configured: rxAdapter!.mode !== 'mock', mode: rxAdapter!.mode,
    outcome: rx.failed ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
  });
  const faxAdapter = only ? undefined : faxAdapterFromEnv();
  const fax = only || !faxAdapter ? undefined : await sendQueuedFaxes(medplum, faxAdapter);
  if (fax && fax.sent + fax.failed > 0) await emitSignal(onSignal, {
    key: 'fax', label: 'Fax delivery', configured: faxAdapter!.mode !== 'log', mode: faxAdapter!.mode,
    outcome: fax.failed ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
  });
  const summaries = only ? 0 : await sendDailySummaries(medplum, transports.email, now, false, undefined, (outcome, error) => {
    const component = messageOutcomes.email;
    component.attempts++;
    if (outcome === 'failure') {
      component.failures++;
      component.failureClass = safeMode(error instanceof Error ? error.name : 'Error');
    }
  });
  for (const channel of ['sms', 'email'] as const) {
    const component = messageOutcomes[channel];
    if (component.attempts) await emitSignal(onSignal, {
      key: channel, label: channel === 'sms' ? 'SMS delivery' : 'Email delivery',
      configured: transports[channel].mode !== 'log', mode: transports[channel].mode,
      outcome: component.failures ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
      failureClass: component.failureClass,
    });
  }
  const billing = only ? undefined : await billingPass(medplum, now);
  if (billing?.failed || billing?.didWork) await emitSignal(onSignal, {
    key: 'billing', label: 'Billing workflow', configured: true, mode: billing.mode ?? clearinghouseMode(),
    outcome: billing.failed ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
    failureClass: billing.failed ? 'BillingPassFailure' : undefined,
  });
  if (billing?.counts && billing.mode === 'stedi' && billing.counts.submitted + billing.counts.acknowledged + billing.counts.rejected + billing.counts.remittances > 0) {
    await emitSignal(onSignal, {
      key: 'clearinghouse', label: 'Claims clearinghouse', configured: true, mode: 'stedi',
      outcome: billing.counts.failures ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
    });
  }
  const meet = only ? undefined : await meetPass(medplum, now);
  if (meet && meet.mode === 'google' && (meet.counts.created + meet.counts.failed > 0)) await emitSignal(onSignal, {
    key: 'google-meet', label: 'Google Meet', configured: true, mode: 'google',
    outcome: meet.counts.failed ? 'failure' : 'success', observedAt: (now ?? new Date()).toISOString(),
    failureClass: meet.counts.failed ? 'MeetProvisionFailure' : undefined,
  });
  return (
    `queued ${scheduled.queued} · sent ${delivered.sent} · deferred (quiet hours) ${delivered.deferred} · stopped ${delivered.stopped} · failed ${delivered.failed}` +
    (rx ? ` · eRx sent ${rx.sent} · eRx failed ${rx.failed} · eRx cancelled ${rx.cancelled}` : '') +
    (fax ? ` · fax sent ${fax.sent} · fax failed ${fax.failed}` : '') +
    (summaries ? ` · daily summaries ${summaries}` : '') +
    (billing ? ` · ${billing.summary}` : '') +
    (meet ? ` · meet: links ${meet.counts.created} · skipped ${meet.counts.skipped} · failed ${meet.counts.failed}` : '')
  );
}

/** Revenue cycle (Phase 8). A failure is reported on this pass and never stops the tick. */
interface BillingPassResult { summary: string; failed: boolean; counts?: BillingCounts; mode?: string; didWork: boolean }
async function billingPass(medplum: MedplumClient, now?: Date): Promise<BillingPassResult> {
  try {
    const clearinghouse = clearinghouseFromEnv();
    const counts = await processBilling(medplum, clearinghouse, ledgerFromEnv(), now ?? new Date());
    const didWork = counts.charges + counts.submitted + counts.submissionsRefused + counts.acknowledged + counts.rejected + counts.remittances + counts.denials + counts.exceptions + counts.eligibilityChecks + counts.statements + counts.statementNotices + counts.refundReviews + counts.smallBalances > 0;
    return { counts, mode: clearinghouse.mode, didWork, failed: counts.failures > 0, summary: `billing: charges ${counts.charges} · submitted ${counts.submitted} · refused ${counts.submissionsRefused} · acks ${counts.acknowledged} · rejected ${counts.rejected} · 835s ${counts.remittances} · denials ${counts.denials} · exceptions ${counts.exceptions} · eligibility ${counts.eligibilityChecks} · statements ${counts.statements} · failures ${counts.failures}` };
  } catch (err) {
    return { didWork: false, failed: true, summary: `billing failed: ${normalizeErrorString(err)}`, mode: clearinghouseMode() };
  }
}

/** Telehealth meetings (Phase 7): give confirmed video visits a Google Meet link. Never stops the tick. */
interface MeetPassResult { counts: { created: number; skipped: number; failed: number }; mode: string }
async function meetPass(medplum: MedplumClient, now?: Date): Promise<MeetPassResult> {
  try {
    const adapter = meetAdapterFromEnv();
    const counts = await provisionMeetLinks(medplum, adapter, now ?? new Date());
    return { counts, mode: adapter.mode };
  } catch (err) {
    const vendor = process.env.MEET_VENDOR ?? 'sandbox';
    return { counts: { created: 0, skipped: 0, failed: 1 }, mode: vendor === 'google' ? 'google' : vendor === 'sandbox' ? 'sandbox' : 'unavailable' };
  }
}

async function emitSignal(onSignal: ((signal: WorkerOperationalSignal) => Promise<void>) | undefined, signal: WorkerOperationalSignal): Promise<void> {
  try { await onSignal?.(signal); }
  catch (err) { console.error(`[worker] integration signal write failed (${err instanceof Error ? err.name : 'Error'})`); }
}

function hasGoogleMeetCredentials(): boolean {
  const json = process.env.GOOGLE_MEET_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
      return !!(parsed.client_email && parsed.private_key);
    } catch { return false; }
  }
  return !!(process.env.GOOGLE_MEET_CLIENT_EMAIL && process.env.GOOGLE_MEET_PRIVATE_KEY);
}

async function syncIntegrationConfiguration(medplum: MedplumClient): Promise<void> {
  const smsConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  const meetVendor = process.env.MEET_VENDOR ?? 'sandbox';
  const clearinghouseVendor = process.env.CLEARINGHOUSE_VENDOR ?? 'mock';
  const configurations = [
    { key: 'worker', label: 'Background worker', configured: true, mode: 'local' },
    { key: 'sms', label: 'SMS delivery', configured: smsConfigured, mode: smsConfigured ? 'twilio' : 'log' },
    { key: 'email', label: 'Email delivery', configured: false, mode: 'log' },
    { key: 'erx', label: 'E-prescribing', configured: false, mode: safeMode(process.env.ERX_VENDOR ?? 'mock') },
    { key: 'fax', label: 'Fax delivery', configured: false, mode: safeMode(process.env.FAX_VENDOR ?? 'log') },
    { key: 'billing', label: 'Billing workflow', configured: true, mode: safeMode(clearinghouseVendor) },
    { key: 'clearinghouse', label: 'Claims clearinghouse', configured: clearinghouseVendor === 'stedi', mode: safeMode(clearinghouseVendor) },
    { key: 'google-meet', label: 'Google Meet', configured: meetVendor === 'google' && hasGoogleMeetCredentials(), mode: safeMode(meetVendor) },
  ] as const;
  for (const configuration of configurations) await recordWorkerConfiguration(medplum, configuration);
}

/** The clearinghouse mode for the startup line; a bad mock state file is reported, not fatal. */
function clearinghouseLabel(): string {
  try {
    return clearinghouseFromEnv().mode;
  } catch (err) {
    return `unavailable (${normalizeErrorString(err)})`;
  }
}

function clearinghouseMode(): string {
  try { return clearinghouseFromEnv().mode; }
  catch { return 'unavailable'; }
}

function safeMode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'unknown';
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  let medplum = await connectWorker();
  await syncIntegrationConfiguration(medplum).catch((err) => console.error(`[worker] integration configuration sync failed (${err instanceof Error ? err.name : 'Error'})`));
  const t = transportsFromEnv();
  console.log(`[worker] connected · SMS: ${t.sms.mode} · email: ${t.email.mode} · e-prescribing: ${erxAdapterFromEnv().mode} · fax: ${faxAdapterFromEnv().mode} · meetings: ${meetLabel()} · clearinghouse: ${clearinghouseLabel()} (synthetic only)`);

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const observedAt = new Date();
      const result = await runOnce(medplum, undefined, undefined, (signal) => recordWorkerSignal(medplum, signal));
      await syncIntegrationConfiguration(medplum).catch((err) => console.error(`[worker] integration configuration sync failed (${err instanceof Error ? err.name : 'Error'})`));
      await recordWorkerHeartbeat(medplum, 'success', undefined, observedAt).catch((err) => {
        console.error(`[worker] health signal write failed (${err instanceof Error ? err.name : 'Error'})`);
      });
      console.log(`[worker] ${observedAt.toISOString()} ${result}`);
    } catch (err) {
      console.error(`[worker] pass failed: ${normalizeErrorString(err)}`);
      await recordWorkerHeartbeat(medplum, 'failure', err).catch((signalError) => {
        console.error(`[worker] failure signal write failed (${signalError instanceof Error ? signalError.name : 'Error'})`);
      });
      medplum = await connectWorker().catch(() => medplum); // Token expiry: reconnect next time.
    } finally {
      running = false;
    }
  };
  await tick();
  if (once) return;

  const seconds = Number(process.env.TELEEMON_WORKER_INTERVAL ?? 60);
  setInterval(tick, Math.max(15, seconds) * 1000);

  // Render supplies PORT; TELEEMON_WORKER_PORT stays for local development.
  const port = Number(process.env.PORT ?? process.env.TELEEMON_WORKER_PORT ?? 3110);
  createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/webhooks/sms' && req.url !== '/webhooks/fax')) {
      res.writeHead(404).end();
      return;
    }
    // Locally only loopback may call the webhook; Twilio signature checks come with the vendor (D7).
    const remote = req.socket.remoteAddress ?? '';
    if (!process.env.TWILIO_AUTH_TOKEN && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.writeHead(403).end();
      return;
    }
    const maxBytes = req.url === '/webhooks/fax' ? 29 * 1024 * 1024 : 64 * 1024;
    let raw = '';
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes) { res.writeHead(413).end(); req.destroy(); return; }
      raw += c;
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      if (req.url === '/webhooks/fax') {
        // Vendor-neutral JSON: { id, from, to, pages, pdfBase64, text }. Vendor signature checks
        // replace the loopback restriction when the fax vendor is connected.
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          res.writeHead(403).end();
          return;
        }
        try {
          const body = JSON.parse(raw) as { id?: string; from?: string; to?: string; pages?: number; pdfBase64?: string; text?: string };
          if (!body.id || !body.from || !body.pdfBase64) throw new Error('id, from and pdfBase64 are required');
          const doc = await receiveFax(medplum, { id: body.id, from: body.from, to: body.to, pages: body.pages ?? 1, pdf: Buffer.from(body.pdfBase64, 'base64'), text: body.text });
          console.log(`[worker] inbound fax stored for review (${doc.id})`);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: doc.id }));
        } catch (err) {
          console.error(`[worker] inbound fax failed: ${normalizeErrorString(err)}`);
          res.writeHead(400).end();
        }
        return;
      }
      try {
        const form = req.headers['content-type']?.includes('json') ? (JSON.parse(raw) as Record<string, string>) : Object.fromEntries(new URLSearchParams(raw));
        const result = await handleInbound(medplum, form.From ?? '', form.Body ?? '');
        console.log(`[worker] inbound ${result.intent} from …${(form.From ?? '').slice(-4)}`);
        const reply = result.reply ? `<Message>${result.reply.replace(/[<&>]/g, '')}</Message>` : '';
        res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><Response>${reply}</Response>`);
      } catch (err) {
        console.error(`[worker] inbound failed: ${normalizeErrorString(err)}`);
        res.writeHead(500).end();
      }
    });
  }).listen(port, '127.0.0.1', () => console.log(`[worker] inbound SMS webhook on http://127.0.0.1:${port}/webhooks/sms`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(`[worker] ${normalizeErrorString(err)}`);
    process.exit(1);
  });
}
