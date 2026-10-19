import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyHeaders, buildUpstreams, upstreamTarget } from './gateway.mjs';

const token = 'test-only-shared-token-with-at-least-32-characters';

test('hybrid API URL is HTTPS-only, origin-only, and requires a shared secret', () => {
  const { upstreams, proxyToken } = buildUpstreams({
    PORTAL_API_URL: 'https://demo.trycloudflare.com',
    HYBRID_DEMO_TOKEN: token,
  });
  assert.equal(upstreams.length, 1);
  assert.equal(upstreams[0].mode, 'url');
  assert.equal(upstreams[0].prefix, '/api/portal');
  assert.equal(proxyToken, token);
  assert.throws(() => buildUpstreams({ PORTAL_API_URL: 'http://demo.trycloudflare.com', HYBRID_DEMO_TOKEN: token }), /HTTPS origin/);
  assert.throws(() => buildUpstreams({ PORTAL_API_URL: 'https://demo.trycloudflare.com/private-prefix', HYBRID_DEMO_TOKEN: token }), /without credentials, path/);
  assert.throws(() => buildUpstreams({ PORTAL_API_URL: 'https://demo.trycloudflare.com' }), /HYBRID_DEMO_TOKEN/);
  assert.throws(() => buildUpstreams({ PORTAL_API_URL: 'https://demo.trycloudflare.com', PORTAL_API_HOST: '127.0.0.1', HYBRID_DEMO_TOKEN: token }), /cannot both be set/);
});

test('HTTPS upstream target preserves the fixed API path and query', () => {
  const { upstreams } = buildUpstreams({ PORTAL_API_URL: 'https://demo.trycloudflare.com', HYBRID_DEMO_TOKEN: token });
  const target = upstreamTarget(upstreams[0], '/api/portal/appointments?date=2026-10-19');
  assert.equal(target.href, 'https://demo.trycloudflare.com/api/portal/appointments?date=2026-10-19');
});

test('remote gateway headers retain bearer auth, add tunnel auth, and preserve the service-specific Origin rule', () => {
  const { upstreams } = buildUpstreams({
    LEDGER_API_URL: 'https://demo.trycloudflare.com',
    PORTAL_API_URL: 'https://demo.trycloudflare.com',
    MEDPLUM_API_URL: 'https://demo.trycloudflare.com',
    HYBRID_DEMO_TOKEN: token,
  });
  const target = upstreamTarget(upstreams[0], '/api/portal/book');
  const portalHeaders = buildProxyHeaders({ authorization: 'Bearer patient-token', origin: 'https://patient-demo.onrender.com', host: 'patient-demo.onrender.com' }, upstreams[0], target, token, '127.0.0.1');
  assert.equal(portalHeaders.authorization, 'Bearer patient-token');
  assert.equal(portalHeaders.origin, 'https://patient-demo.onrender.com');
  assert.equal(portalHeaders['x-teleemon-demo-token'], token);

  const ledger = upstreams.find((upstream) => upstream.prefix === '/api/ledger');
  const ledgerHeaders = buildProxyHeaders({ authorization: 'Bearer staff-token', origin: 'https://staff-demo.onrender.com', referer: 'https://staff-demo.onrender.com/calendar', host: 'staff-demo.onrender.com' }, ledger, upstreamTarget(ledger, '/api/ledger/reports'), token, '127.0.0.1');
  assert.equal(ledgerHeaders.authorization, 'Bearer staff-token');
  assert.equal(ledgerHeaders.origin, undefined);
  assert.equal(ledgerHeaders.referer, undefined);
  assert.equal(ledgerHeaders['x-teleemon-demo-token'], token);

  const medplum = upstreams.find((upstream) => upstream.prefix === '/medplum');
  assert.ok(medplum);
  assert.equal(upstreamTarget(medplum, '/medplum/fhir/R4/Patient').pathname, '/medplum/fhir/R4/Patient');
});
