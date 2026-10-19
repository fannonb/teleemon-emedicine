// Teleemon frontend gateway for Render.
//
// Serves a built Vite app (apps/staff/dist or apps/portal/dist) and proxies the browser-facing
// API prefixes to the Teleemon services over Render's private network. Doing the proxy here keeps
// every browser call same-origin, so the apps keep using /api/... exactly as they do with Vite's
// development proxy.
//
//   SERVE_DIR=apps/staff/dist PORTAL_API_HOST=... PORTAL_API_PORT=10000 node render/gateway.mjs
//
// Only GET/HEAD are served from disk; unknown HTML routes fall back to index.html for the SPA
// router. Everything under a configured upstream prefix is streamed through unchanged.

import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';

const PORT = Number(process.env.PORT ?? 10000);
const ROOT = resolve(process.env.SERVE_DIR ?? 'apps/staff/dist');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * The API prefixes this gateway forwards.
 *
 * Browser traffic is same-origin through this process. The ledger and scribe services check the
 * Origin header against an allow-list intended for direct calls, so the proxy removes it: the
 * gateway, not the browser, is their trusted caller. Portal has no Origin check and keeps the
 * header untouched.
 */
const upstreams = [
  { prefix: '/api/portal', host: process.env.PORTAL_API_HOST, port: process.env.PORTAL_API_PORT, stripOrigin: false },
  { prefix: '/api/ledger', host: process.env.LEDGER_API_HOST, port: process.env.LEDGER_API_PORT, stripOrigin: true },
  { prefix: '/api/scribe', host: process.env.SCRIBE_API_HOST, port: process.env.SCRIBE_API_PORT, stripOrigin: true },
]
  .filter((u) => u.host)
  .map((u) => ({ ...u, port: Number(u.port ?? 10000) }));

function upstreamFor(pathname) {
  return upstreams.find((u) => pathname === u.prefix || pathname.startsWith(`${u.prefix}/`));
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function proxy(req, res, upstream) {
  const headers = { ...req.headers };
  // Hop-by-hop headers are per-connection and must not be forwarded.
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete headers[name];
  }
  if (upstream.stripOrigin) {
    delete headers.origin;
    delete headers.referer;
  }
  const forwardedFor = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const remote = req.socket.remoteAddress;
  headers['x-forwarded-for'] = [...forwardedFor, remote].filter(Boolean).join(', ');
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'https';
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] ?? req.headers.host ?? '';
  headers.host = `${upstream.host}:${upstream.port}`;

  const client = upstream.host.endsWith('.onrender.com') ? https : http;
  const request = client.request(
    {
      hostname: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers,
      // Scribe uploads and audio downloads can run for the life of a visit.
      timeout: 20 * 60 * 1000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      pipeline(upstreamRes, res, (err) => {
        if (err) res.destroy();
      });
    }
  );
  request.on('timeout', () => request.destroy(new Error('upstream timeout')));
  request.on('error', (err) => {
    console.error(`[gateway] ${req.method} ${upstream.prefix} proxy failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { message: 'The service is not available right now.' });
    else res.destroy();
  });
  pipeline(req, request, (err) => {
    if (err) request.destroy(err);
  });
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const normalized = resolve(ROOT, `.${decoded}`);
  if (normalized !== ROOT && !normalized.startsWith(ROOT + sep)) return undefined;
  return normalized;
}

async function serveFile(req, res, file, { index = false } = {}) {
  const body = createReadStream(file);
  const ext = extname(file).toLowerCase();
  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': index || ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }
  pipeline(body, res, (err) => {
    if (err && !res.headersSent) res.destroy();
  });
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://gateway.local');

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, serveDir: ROOT, upstreams: upstreams.map((u) => u.prefix) });
    return;
  }

  const upstream = upstreamFor(url.pathname);
  if (upstream) {
    proxy(req, res, upstream);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { message: 'Method not allowed.' });
    return;
  }

  const target = safePath(url.pathname);
  if (!target) {
    sendJson(res, 400, { message: 'Bad path.' });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    stat = undefined;
  }
  if (stat?.isFile()) {
    await serveFile(req, res, target);
    return;
  }
  if (stat?.isDirectory()) {
    const index = resolve(target, 'index.html');
    try {
      if ((await fs.stat(index)).isFile()) {
        await serveFile(req, res, index, { index: true });
        return;
      }
    } catch {
      // fall through to the SPA fallback
    }
  }

  // Client-side routes: only HTML navigations get index.html, so missing assets still 404.
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html') || !extname(url.pathname)) {
    const index = resolve(ROOT, 'index.html');
    try {
      if ((await fs.stat(index)).isFile()) {
        await serveFile(req, res, index, { index: true });
        return;
      }
    } catch {
      // fall through
    }
  }
  sendJson(res, 404, { message: 'Not found.' });
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error(`[gateway] request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    if (!res.headersSent) sendJson(res, 500, { message: 'Something went wrong.' });
    else res.destroy();
  });
});
server.requestTimeout = 20 * 60 * 1000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] ${ROOT} on :${PORT}; proxying ${upstreams.map((u) => u.prefix).join(', ') || 'nothing'}`);
});
