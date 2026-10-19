// Public Codespaces listener for the existing, token-protected loopback Render demo gateway.
// This bridge does not route to Medplum or the app services directly. It forwards only to
// 127.0.0.1:3401, where render/hybrid-backend.mjs enforces HYBRID_DEMO_TOKEN and the API allowlist.

import http from 'node:http';
import { pipeline } from 'node:stream';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const backendPort = Number(process.env.HYBRID_BACKEND_PORT ?? 3401);
const publicPort = Number(process.env.CODESPACES_PUBLIC_PORT ?? 3400);

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method ?? '')) {
    send(res, 200, { ok: true });
    return;
  }
  if (!methods.has(req.method ?? '')) {
    send(res, 405, { message: 'Method not allowed.' });
    return;
  }

  const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
  for (const name of HOP_BY_HOP) delete headers[name];
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: backendPort,
    method: req.method,
    path: req.url ?? '/',
    headers,
    timeout: 20 * 60 * 1000,
  }, (response) => {
    const responseHeaders = { ...response.headers };
    for (const name of HOP_BY_HOP) delete responseHeaders[name];
    res.writeHead(response.statusCode ?? 502, responseHeaders);
    pipeline(response, res, (error) => { if (error) res.destroy(); });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('backend timeout')));
  upstream.on('error', (error) => {
    console.error(`[codespaces-bridge] backend unavailable: ${error.name}`);
    if (!res.headersSent) send(res, 502, { message: 'The demo backend is not available right now.' });
    else res.destroy();
  });
  pipeline(req, upstream, (error) => { if (error) upstream.destroy(error); });
});

server.requestTimeout = 20 * 60 * 1000;
server.listen(publicPort, '0.0.0.0', () => {
  console.log(`[codespaces-bridge] listening on 0.0.0.0:${publicPort}; APIs remain behind the protected loopback gateway`);
});
