// Local API gateway for the temporary Render + local-backend demo.
//
// Cloudflare Tunnel should point to this single port. The process binds only to 127.0.0.1 and
// forwards a fixed set of API prefixes to the existing local services. The shared token is checked
// before any service is reached; Render's server-side gateway adds it to HTTPS tunnel requests.
// The Medplum route is deliberately limited to the browser API paths Teleemon needs; it never
// exposes the local server's administrative endpoints.
//
//   HYBRID_DEMO_TOKEN=<random 32+ character secret> node render/hybrid-backend.mjs
//
// Optional local ports: PORTAL_API_PORT (3120), LEDGER_API_PORT (3130), SCRIBE_API_PORT (3111),
// HYBRID_BACKEND_PORT (3400). The upstream host is deliberately fixed to loopback.

import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROUTES = [
  { prefix: '/medplum', portKey: 'MEDPLUM_API_PORT', port: 8103, stripPrefix: true, medplum: true },
  { prefix: '/api/portal', portKey: 'PORTAL_API_PORT', port: 3120, stripPrefix: false },
  { prefix: '/api/ledger', portKey: 'LEDGER_API_PORT', port: 3130, stripPrefix: false },
  { prefix: '/api/scribe', portKey: 'SCRIBE_API_PORT', port: 3111, stripPrefix: false },
];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Public Medplum API surface used by the browser SDK. Administrative and unknown routes are denied. */
export function isAllowedMedplumPath(pathname) {
  if (/%2f|%5c/i.test(pathname)) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\\') || decoded.includes('//')) return false;
  const segments = decoded.split('/');
  if (segments.includes('.') || segments.includes('..')) return false;
  if (!decoded.startsWith('/medplum/')) return false;
  const localPath = decoded.slice('/medplum'.length);
  return localPath === '/auth' || localPath.startsWith('/auth/')
    || localPath === '/oauth2' || localPath.startsWith('/oauth2/')
    || localPath === '/fhir/R4' || localPath.startsWith('/fhir/R4/')
    || localPath === '/storage' || localPath.startsWith('/storage/')
    || localPath === '/healthcheck' || localPath === '/health'
    || ['/.well-known/smart-configuration', '/.well-known/openid-configuration', '/.well-known/fhir-configuration'].includes(localPath);
}

function validPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

export function buildHybridRoutes(env = process.env) {
  return ROUTES.map((route) => ({ ...route, port: validPort(env[route.portKey] ?? route.port, route.portKey) }));
}

function matchesToken(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const provided = Buffer.from(candidate);
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

function routeFor(pathname, routes) {
  return routes.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function createHandler({ token, routes, logger = console }) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hybrid-backend.local');
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { ok: true });
      return;
    }

    const route = routeFor(url.pathname, routes);
    if (!route) {
      sendJson(res, 404, { message: 'Not found.' });
      return;
    }

    if (route.medplum && !isAllowedMedplumPath(url.pathname)) {
      sendJson(res, 404, { message: 'Not found.' });
      return;
    }

    if (!ALLOWED_METHODS.has(req.method ?? '')) {
      sendJson(res, 405, { message: 'Method not allowed.' });
      return;
    }

    if (!matchesToken(req.headers['x-teleemon-demo-token'], token)) {
      sendJson(res, 401, { message: 'Gateway authorization required.' });
      return;
    }

    const headers = { ...req.headers, host: `127.0.0.1:${route.port}` };
    delete headers['x-teleemon-demo-token'];
    for (const name of HOP_BY_HOP) delete headers[name];
    const forwardedFor = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (req.socket.remoteAddress) forwardedFor.push(req.socket.remoteAddress);
    if (forwardedFor.length) headers['x-forwarded-for'] = forwardedFor.join(', ');
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'https';

    const localPath = route.stripPrefix ? `${url.pathname.slice(route.prefix.length) || '/'}${url.search}` : req.url;
    const request = http.request({
      hostname: '127.0.0.1',
      port: route.port,
      method: req.method,
      path: localPath,
      headers,
      timeout: 20 * 60 * 1000,
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      pipeline(upstreamRes, res, (err) => {
        if (err) res.destroy();
      });
    });
    request.on('timeout', () => request.destroy(new Error('local service timeout')));
    request.on('error', (err) => {
      logger.error(`[hybrid-backend] ${req.method} ${route.prefix} proxy failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, 502, { message: 'The local service is not available right now.' });
      else res.destroy();
    });
    pipeline(req, request, (err) => {
      if (err) request.destroy(err);
    });
  };
}

export function createHybridBackendServer({ env = process.env, token = env.HYBRID_DEMO_TOKEN, routes = buildHybridRoutes(env), logger = console } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('HYBRID_DEMO_TOKEN must contain at least 32 characters');
  return http.createServer(createHandler({ token, routes, logger }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = validPort(process.env.HYBRID_BACKEND_PORT ?? 3400, 'HYBRID_BACKEND_PORT');
  const server = createHybridBackendServer();
  server.requestTimeout = 20 * 60 * 1000;
  server.listen(port, '127.0.0.1', () => {
    console.log(`[hybrid-backend] listening on 127.0.0.1:${port}; routes are token-protected`);
  });
}
