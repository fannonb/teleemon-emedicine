// Teleemon frontend gateway for Render.
//
// Serves a built Vite app (apps/staff/dist or apps/portal/dist) and proxies the browser-facing
// API prefixes to configured Teleemon services over Render's private network or an HTTPS tunnel.
// Doing the proxy here keeps browser calls same-origin, so the apps keep using /api/... exactly as
// they do with Vite's development proxy. In hybrid mode the browser also uses /medplum/ through
// this gateway, while the local tunnel itself requires a server-only shared token.
//
//   SERVE_DIR=apps/staff/dist PORTAL_API_HOST=... PORTAL_API_PORT=10000 node render/gateway.mjs
// Hybrid demo mode: MEDPLUM_API_URL=https://<tunnel-host> HYBRID_DEMO_TOKEN=<server-secret> node render/gateway.mjs
//
// Only GET/HEAD are served from disk; unknown HTML routes fall back to index.html for the SPA
// router. Everything under a configured upstream prefix is streamed through unchanged.

import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

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
const UPSTREAMS = [
  { prefix: '/medplum', name: 'MEDPLUM_API', stripOrigin: false },
  { prefix: '/api/portal', name: 'PORTAL_API', stripOrigin: false },
  { prefix: '/api/ledger', name: 'LEDGER_API', stripOrigin: true },
  { prefix: '/api/scribe', name: 'SCRIBE_API', stripOrigin: true },
];

/**
 * Build a fixed allow-list of service routes from the deployment environment. URL mode is for
 * HTTPS tunnels (for example the temporary Cloudflare tunnel used by the hybrid demo). It is
 * intentionally origin-only: callers cannot configure arbitrary path/query fragments that might
 * change which backend path receives a request. URL mode requires a shared secret because a
 * public tunnel must not become an unauthenticated proxy to the local services.
 */
export function buildUpstreams(env = process.env) {
  const result = [];
  for (const definition of UPSTREAMS) {
    const urlValue = env[`${definition.name}_URL`]?.trim();
    const host = env[`${definition.name}_HOST`]?.trim();
    const portValue = env[`${definition.name}_PORT`];
    if (urlValue && host) throw new Error(`${definition.name}_URL and ${definition.name}_HOST cannot both be set`);
    if (urlValue) {
      let baseUrl;
      try {
        baseUrl = new URL(urlValue);
      } catch {
        throw new Error(`${definition.name}_URL must be a valid HTTPS origin`);
      }
      if (baseUrl.protocol !== 'https:' || !baseUrl.hostname || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
        throw new Error(`${definition.name}_URL must be an HTTPS origin without credentials, path, query, or fragment`);
      }
      result.push({ ...definition, mode: 'url', baseUrl });
      continue;
    }
    if (host) {
      const port = Number(portValue ?? 10000);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${definition.name}_PORT must be a valid TCP port`);
      result.push({ ...definition, mode: 'host', host, port });
    }
  }

  const usesHttpsUrls = result.some((upstream) => upstream.mode === 'url');
  const proxyToken = env.HYBRID_DEMO_TOKEN ?? '';
  if (usesHttpsUrls && proxyToken.length < 32) throw new Error('HYBRID_DEMO_TOKEN must contain at least 32 characters when *_API_URL is configured');
  return { upstreams: result, proxyToken };
}

/** Preserve the incoming path and query while changing only the configured upstream origin. */
export function upstreamTarget(upstream, requestUrl) {
  if (upstream.mode === 'url') return new URL(requestUrl, upstream.baseUrl);
  const protocol = upstream.host.endsWith('.onrender.com') ? 'https' : 'http';
  return new URL(requestUrl, `${protocol}://${upstream.host}:${upstream.port}`);
}

export function buildProxyHeaders(requestHeaders, upstream, target, proxyToken, remoteAddress) {
  const headers = { ...requestHeaders };
  // Hop-by-hop headers are per-connection and must not be forwarded.
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete headers[name];
  }
  if (upstream.stripOrigin) {
    delete headers.origin;
    delete headers.referer;
  }
  const forwardedFor = String(requestHeaders['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  headers['x-forwarded-for'] = [...forwardedFor, remoteAddress].filter(Boolean).join(', ');
  headers['x-forwarded-proto'] = requestHeaders['x-forwarded-proto'] ?? 'https';
  headers['x-forwarded-host'] = requestHeaders['x-forwarded-host'] ?? requestHeaders.host ?? '';
  headers.host = target.host;
  if (upstream.mode === 'url') headers['x-teleemon-demo-token'] = proxyToken;
  return headers;
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

function proxy(req, res, upstream, proxyToken) {
  const target = upstreamTarget(upstream, req.url ?? '/');
  const headers = buildProxyHeaders(req.headers, upstream, target, proxyToken, req.socket.remoteAddress);

  const client = target.protocol === 'https:' ? https : http;
  const request = client.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
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

function safePath(pathname, root) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const normalized = resolve(root, `.${decoded}`);
  if (normalized !== root && !normalized.startsWith(root + sep)) return undefined;
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

async function handle(req, res, { root, upstreams, proxyToken }) {
  const url = new URL(req.url ?? '/', 'http://gateway.local');

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, serveDir: root, upstreams: upstreams.map((u) => u.prefix) });
    return;
  }

  const upstream = upstreams.find((u) => url.pathname === u.prefix || url.pathname.startsWith(`${u.prefix}/`));
  if (upstream) {
    proxy(req, res, upstream, proxyToken);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { message: 'Method not allowed.' });
    return;
  }

  const target = safePath(url.pathname, root);
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
    const index = resolve(root, 'index.html');
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

export function createGatewayServer({ env = process.env, logger = console } = {}) {
  const root = resolve(env.SERVE_DIR ?? 'apps/staff/dist');
  const { upstreams, proxyToken } = buildUpstreams(env);
  const server = http.createServer((req, res) => {
    void handle(req, res, { root, upstreams, proxyToken }).catch((err) => {
      logger.error(`[gateway] request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Something went wrong.' });
      else res.destroy();
    });
  });
  server.requestTimeout = 20 * 60 * 1000;
  return { server, root, upstreams };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 10000);
  const { server, root, upstreams } = createGatewayServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[gateway] ${root} on :${port}; proxying ${upstreams.map((u) => u.prefix).join(', ') || 'nothing'}`);
  });
}
