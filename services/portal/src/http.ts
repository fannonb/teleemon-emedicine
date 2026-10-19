// Minimal HTTP plumbing for the portal service: JSON bodies with a size limit, a fixed-window rate
// limiter per client address, and errors that carry a plain-English message for the patient.

import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export const badRequest = (message: string, code?: string): HttpError => new HttpError(400, message, code);

export async function readJson<T>(req: IncomingMessage, maxBytes = 32 * 1024): Promise<T> {
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > maxBytes) throw new HttpError(413, 'That request is too large.');
    raw += chunk;
  }
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest('The request could not be read.');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

/** The client address. Behind the load balancer the first X-Forwarded-For hop is used (TRUST_PROXY=1). */
export function clientAddress(req: IncomingMessage): string {
  const forwarded = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}

/** Fixed-window rate limiting per key. Cloud Armor adds edge limits when deployed. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  take(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10000) this.prune(now);
      return;
    }
    entry.count++;
    if (entry.count > this.limit) throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.');
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

export type Handler = (req: IncomingMessage, params: Record<string, string>, query: URLSearchParams) => Promise<unknown>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([A-Za-z0-9-]{1,64})'; })}$`);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://portal.local');
    const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { message: 'Not found' });
      return;
    }
    const match = route.pattern.exec(url.pathname) as RegExpExecArray;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, match[i + 1]]));
    try {
      const body = await route.handler(req, params, url.searchParams);
      sendJson(res, 200, body ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message, code: err.code });
        return;
      }
      // Never echo internal errors (they can contain identifiers); log the type and route only.
      console.error(`[portal] ${req.method} ${url.pathname} failed: ${err instanceof Error ? err.message.slice(0, 300) : 'unknown error'}`);
      sendJson(res, 500, { message: 'Something went wrong on our side. Please try again, or call us.' });
    }
  }
}
