import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHybridBackendServer, buildHybridRoutes, isAllowedMedplumPath } from './hybrid-backend.mjs';

const token = 'test-only-shared-token-with-at-least-32-characters';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('local backend gateway protects the fixed service routes and streams authenticated requests', async (t) => {
  let received = [];
  let hits = 0;
  const localService = http.createServer(async (req, res) => {
    hits++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
      token: req.headers['x-teleemon-demo-token'],
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  const port = await listen(localService);
  const gateway = createHybridBackendServer({
    token,
    env: {},
    routes: buildHybridRoutes({ MEDPLUM_API_PORT: port, PORTAL_API_PORT: port, LEDGER_API_PORT: port, SCRIBE_API_PORT: port }),
    logger: { error() {} },
  });
  const gatewayPort = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(localService);
  });

  const base = `http://127.0.0.1:${gatewayPort}`;
  const unauthorized = await fetch(`${base}/api/portal/book`);
  assert.equal(unauthorized.status, 401);
  assert.equal(hits, 0);

  const response = await fetch(`${base}/api/portal/book?slot=abc`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer patient-session-token',
      origin: 'https://patient-demo.onrender.com',
      'x-teleemon-demo-token': token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reason: 'demo' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(received[0], {
    method: 'POST',
    url: '/api/portal/book?slot=abc',
    authorization: 'Bearer patient-session-token',
    origin: 'https://patient-demo.onrender.com',
    token: undefined,
    body: '{"reason":"demo"}',
  });

  const notAllowed = await fetch(`${base}/api/portal-not-a-route/anything`, { headers: { 'x-teleemon-demo-token': token } });
  assert.equal(notAllowed.status, 404);

  const medplumUnauthorized = await fetch(`${base}/medplum/fhir/R4/Patient`);
  assert.equal(medplumUnauthorized.status, 401);
  assert.equal(hits, 1);

  const adminPath = await fetch(`${base}/medplum/admin`, { headers: { 'x-teleemon-demo-token': token } });
  assert.equal(adminPath.status, 404);
  assert.equal(hits, 1);

  const fhir = await fetch(`${base}/medplum/fhir/R4/Patient?name=demo`, {
    headers: {
      authorization: 'Bearer medplum-session-token',
      origin: 'https://staff-demo.onrender.com',
      'x-teleemon-demo-token': token,
    },
  });
  assert.equal(fhir.status, 201);
  assert.deepEqual(received[1], {
    method: 'GET',
    url: '/fhir/R4/Patient?name=demo',
    authorization: 'Bearer medplum-session-token',
    origin: 'https://staff-demo.onrender.com',
    token: undefined,
    body: '',
  });
});

test('local backend gateway requires a long token and valid fixed service ports', () => {
  assert.throws(() => createHybridBackendServer({ token: 'short' }), /at least 32 characters/);
  assert.throws(() => buildHybridRoutes({ PORTAL_API_PORT: '70000' }), /valid TCP port/);
  assert.deepEqual(buildHybridRoutes({}).map(({ prefix, port }) => [prefix, port]), [
    ['/medplum', 8103],
    ['/api/portal', 3120],
    ['/api/ledger', 3130],
    ['/api/scribe', 3111],
  ]);
});

test('Medplum route allowlist includes browser API routes and excludes admin or path traversal', () => {
  for (const path of [
    '/medplum/auth/me',
    '/medplum/oauth2/authorize',
    '/medplum/fhir/R4/metadata',
    '/medplum/storage/abc',
    '/medplum/.well-known/smart-configuration',
    '/medplum/healthcheck',
  ]) assert.equal(isAllowedMedplumPath(path), true, path);
  for (const path of [
    '/medplum/admin',
    '/medplum/superadmin',
    '/medplum/fhir%2fR4/Patient',
    '/medplum/fhir/R4/../../admin',
    '/medplum/.env',
  ]) assert.equal(isAllowedMedplumPath(path), false, path);
});
