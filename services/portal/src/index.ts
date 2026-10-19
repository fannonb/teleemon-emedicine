// Teleemon portal service (SYSTEM-DESIGN.md §3, ADR-012). The only service with public routes:
// the booking page (X01) and invitation links. Signed-in routes serve the portal writes that carry
// rules (booking, cancelling, check-in, the join link, e-signatures and card on file); patients read
// their own records from Medplum directly, under their compartment policy.
//
// Two Medplum clients with separate credentials (scripts/config/portal.ts):
//   - service: least privilege, used by every request;
//   - accounts: project administrator, used only to create sign-ins from invitations and to keep
//     proxies on the right policy. In production it runs as a separate internal workload.
// A 20-second clock sends staff-requested invitations, releases expired holds, emails "you have a
// reply" notices and reminds new patients to finish their forms a day before the visit; proxy
// policies are reviewed hourly.
//
//   npm run portal            run continuously (http://127.0.0.1:3120, proxied by the portal app at /api/portal)
//   npm run portal -- --once  one background pass, then exit

import { MedplumClient, normalizeErrorString } from '@medplum/core';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { CRISIS_LINES, EXT, PORTAL_RULES, onlineVisitTypes, portalVisitTypes, readSettings } from '@teleemon/core';
import { bookableStates, freeTimes } from './availability';
import { billingView, payBalance, paymentLimiter } from './billing';
import { cancel, patientHistory, portalBook, publicBook, releaseHolds } from './booking';
import { publicRegister } from './registration';
import { ProofOfWork } from './captcha';
import { checkIn, joinLink, visitStatus } from './checkin';
import { signConsent } from './consents';
import { RateLimiter, Router, badRequest, clientAddress, readJson } from './http';
import { LedgerHttpClient } from './ledgerClient';
import { activate, describeInvitation, processInviteTasks, reviewProxies } from './invitations';
import { mailMode } from './mail';
import { notifyReplies } from './notify';
import { acknowledgeEstimate, currentEstimate, remindIncompleteIntake } from './onboarding';
import { currentCard, paymentsFromEnv, removeCard, saveCard } from './payments';
import { requireClinicalAccess, sessionFor } from './session';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadEnv(): void {
  const file = join(ROOT, '.env.local');
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
}

async function login(idVar: string, secretVar: string): Promise<MedplumClient> {
  const id = process.env[idVar];
  const secret = process.env[secretVar];
  if (!id || !secret) throw new Error(`${idVar} is not configured. Run \`npm run setup -- --portal-only\`.`);
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/' });
  await medplum.startClientLogin(id, secret);
  return medplum;
}

export async function connectPortalService(): Promise<{ service: MedplumClient; accounts: MedplumClient; projectId: string }> {
  loadEnv();
  const projectId = process.env.TELEEMON_PROJECT_ID;
  if (!projectId) throw new Error('TELEEMON_PROJECT_ID is not configured. Run `npm run setup`.');
  const [service, accounts] = await Promise.all([
    login('TELEEMON_PORTAL_CLIENT_ID', 'TELEEMON_PORTAL_CLIENT_SECRET'),
    login('TELEEMON_PORTAL_ACCOUNTS_CLIENT_ID', 'TELEEMON_PORTAL_ACCOUNTS_CLIENT_SECRET'),
  ]);
  return { service, accounts, projectId };
}

export interface PortalContext {
  service: MedplumClient;
  accounts: MedplumClient;
  readonly projectId: string;
}

/** Per-address limits on the public routes: browsing, booking requests (per hour) and invitation links (per hour). */
export interface RouteLimits {
  readonly browsePerMinute: number;
  readonly bookPerHour: number;
  readonly linksPerHour: number;
}
export const DEFAULT_LIMITS: RouteLimits = { browsePerMinute: 120, bookPerHour: 5, linksPerHour: 20 };

export function buildRouter(ctx: PortalContext, pow: ProofOfWork, now: () => Date = () => new Date(), limits: RouteLimits = DEFAULT_LIMITS): Router {
  const payments = paymentsFromEnv();
  const ledger = new LedgerHttpClient();
  const payLimiter = paymentLimiter();
  const browse = new RateLimiter(limits.browsePerMinute, 60000);
  const book = new RateLimiter(limits.bookPerHour, 3600000);
  const links = new RateLimiter(limits.linksPerHour, 3600000);
  const session = (req: IncomingMessage) => sessionFor(req, ctx.service, ctx.projectId);
  const r = new Router();

  // ---- Public (X01, invitation links) ----
  r.add('GET', '/api/portal/public/options', async (req) => {
    browse.take(clientAddress(req));
    const messaging = await readSettings(ctx.service, 'messaging');
    return { states: await bookableStates(ctx.service), visitTypes: onlineVisitTypes(true).map((v) => ({ code: v.code, label: v.label, minutes: v.minutes })), phone: messaging.practicePhone, crisis: CRISIS_LINES, holdMinutes: PORTAL_RULES.holdMinutes };
  });
  r.add('GET', '/api/portal/public/slots', async (req, _p, q) => {
    browse.take(clientAddress(req));
    return { days: await freeTimes(ctx.service, { channel: 'online', state: (q.get('state') ?? '').toUpperCase(), visitType: q.get('visitType') ?? '', from: q.get('from') ?? undefined, days: 7, now: now() }) };
  });
  r.add('GET', '/api/portal/public/challenge', async (req) => {
    browse.take(clientAddress(req));
    return pow.issue();
  });
  r.add('POST', '/api/portal/public/book', async (req) => {
    book.take(clientAddress(req));
    const body = await readJson<Record<string, unknown>>(req);
    const problem = pow.verify(body.proof as never);
    if (problem) throw badRequest(problem, 'captcha');
    return publicBook(ctx.service, body, now());
  });
  r.add('GET', '/api/portal/public/invitation', async (req, _p, q) => {
    links.take(clientAddress(req));
    return describeInvitation(ctx.service, q.get('token') ?? '');
  });
  r.add('POST', '/api/portal/public/register', async (req) => {
    book.take(clientAddress(req));
    const body = await readJson<Record<string, unknown>>(req);
    const problem = pow.verify(body.proof as never);
    if (problem) throw badRequest(problem, 'captcha');
    return publicRegister(ctx.service, body, now());
  });
  r.add('POST', '/api/portal/public/activate', async (req) => {
    links.take(clientAddress(req));
    const body = await readJson<{ token?: string; password?: string }>(req);
    return activate(ctx.service, ctx.accounts, ctx.projectId, body.token ?? '', body.password ?? '', now());
  });

  // ---- Signed in (X02–X09) ----
  r.add('GET', '/api/portal/me', async (req) => {
    const s = await session(req);
    const history = await patientHistory(ctx.service, s.patientRef);
    return {
      actor: s.actor, actorName: s.actorName, patientRef: s.patientRef, access: s.access,
      patientName: s.patient.name?.[0]?.given?.[0] ?? '',
      visitTypes: portalVisitTypes(history, now()).map((v) => ({ code: v.code, label: v.label, minutes: v.minutes })),
      states: await bookableStates(ctx.service),
      // Hidden from the patient's own reads, so the service supplies it for the booking form.
      lastState: history.map((a) => a.extension?.find((e) => e.url === EXT.patientLocationState)?.valueCode).find(Boolean),
    };
  });
  r.add('GET', '/api/portal/slots', async (req, _p, q) => {
    const s = await session(req);
    browse.take(s.actor);
    return { days: await freeTimes(ctx.service, { channel: 'portal', state: (q.get('state') ?? '').toUpperCase(), visitType: q.get('visitType') ?? '', from: q.get('from') ?? undefined, days: 7, now: now() }) };
  });
  r.add('POST', '/api/portal/appointments', async (req) => portalBook(ctx.service, await session(req), await readJson(req), now()));
  r.add('POST', '/api/portal/appointments/:id/cancel', async (req, p) => cancel(ctx.service, await session(req), p.id, now()));
  r.add('GET', '/api/portal/appointments/:id/status', async (req, p) => visitStatus(ctx.service, await session(req), p.id));
  r.add('POST', '/api/portal/appointments/:id/check-in', async (req, p) => checkIn(ctx.service, await session(req), p.id, await readJson(req), now()));
  r.add('GET', '/api/portal/appointments/:id/join', async (req, p) => joinLink(ctx.service, await session(req), p.id));
  r.add('POST', '/api/portal/consents', async (req) => signConsent(ctx.service, await session(req), await readJson(req), now()));
  r.add('GET', '/api/portal/estimate', async (req) => currentEstimate(ctx.service, await session(req), now()));
  r.add('POST', '/api/portal/estimate/acknowledge', async (req) => acknowledgeEstimate(ctx.service, await session(req), await readJson(req), now()));
  r.add('GET', '/api/portal/payment', async (req) => ({ ...(await currentCard(ctx.service, await session(req)) as object), mode: payments.mode }));
  r.add('POST', '/api/portal/payment/setup', async (req) => {
    const s = await session(req);
    requireClinicalAccess(s);
    return payments.setup(s.patient);
  });
  r.add('POST', '/api/portal/payment/confirm', async (req) => {
    const s = await session(req);
    requireClinicalAccess(s);
    return saveCard(ctx.service, payments, s, await readJson(req));
  });
  r.add('POST', '/api/portal/payment/remove', async (req) => {
    const s = await session(req);
    requireClinicalAccess(s);
    return removeCard(ctx.service, payments, s);
  });

  // ---- Bill pay (X08): full access only; the ledger holds the balance ----
  r.add('GET', '/api/portal/billing', async (req) => billingView({ service: ctx.service, payments, ledger, payLimiter }, await session(req)));
  r.add('POST', '/api/portal/billing/pay', async (req) => {
    const s = await session(req);
    return payBalance({ service: ctx.service, payments, ledger, payLimiter }, s, await readJson<{ cents?: unknown; key?: unknown }>(req), now());
  });
  return r;
}

export async function backgroundPass(ctx: PortalContext, opts: { proxies?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const invites = await processInviteTasks(ctx.service, ctx.accounts, now);
  const released = await releaseHolds(ctx.service, now);
  const notices = await notifyReplies(ctx.service, now);
  const reminders = await remindIncompleteIntake(ctx.service, now);
  const proxies = opts.proxies ? await reviewProxies(ctx.accounts, ctx.projectId, now) : undefined;
  return `invitations ${invites} · holds released ${released} · reply notices ${notices} · intake reminders ${reminders}${proxies ? ` · proxy policies changed ${proxies.changed}, ended ${proxies.ended}` : ''}`;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const ctx: PortalContext = await connectPortalService();
  const pow = new ProofOfWork(process.env.TELEEMON_PORTAL_SECRET ?? '');
  console.log(`[portal] connected · email: ${mailMode()} · payments: ${paymentsFromEnv().mode} (synthetic only)`);

  let running = false;
  let lastProxyReview = 0;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const proxies = Date.now() - lastProxyReview > 3600000;
      console.log(`[portal] ${new Date().toISOString()} ${await backgroundPass(ctx, { proxies })}`);
      if (proxies) lastProxyReview = Date.now();
    } catch (err) {
      console.error(`[portal] pass failed: ${normalizeErrorString(err)}`);
      Object.assign(ctx, await connectPortalService().catch(() => ctx)); // Token expiry: reconnect.
    } finally {
      running = false;
    }
  };
  await tick();
  if (once) return;
  setInterval(tick, 20000);

  const router = buildRouter(ctx, pow);
  // Render supplies PORT; the TELEEMON_PORTAL_PORT default stays for local development.
  const port = Number(process.env.PORT ?? process.env.TELEEMON_PORTAL_PORT ?? 3120);
  createServer((req, res) => void router.handle(req, res)).listen(port, process.env.TELEEMON_PORTAL_HOST ?? '127.0.0.1', () => console.log(`[portal] API on http://127.0.0.1:${port}/api/portal`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(`[portal] ${normalizeErrorString(err)}`);
    process.exit(1);
  });
}
