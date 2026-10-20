import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEndpoint } from './monitor-demo.mjs';
import { CODESPACE, recoverDemo, recoveryEnabled } from './recover-demo.mjs';

const endpoint = { name: 'Test', url: 'https://example.test/healthcheck' };
test('monitor retries cold starts and requires API and database health', async () => {
  let calls = 0;
  const result = await checkEndpoint(endpoint, { pause: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ ok: true, postgres: true, redis: true }) };
  } });
  assert.equal(result.healthy, true);
  assert.equal(result.attempt, 2);
});
test('monitor rejects sign-in HTML, redirects and partial health', async () => {
  for (const fetchImpl of [
    async () => ({ ok: true, json: async () => { throw new Error('HTML'); } }),
    async () => { throw new Error('redirect'); },
    async () => ({ ok: true, json: async () => ({ ok: true, postgres: false, redis: true }) }),
  ]) assert.equal((await checkEndpoint(endpoint, { fetchImpl, attempts: 1 })).healthy, false);
});
test('recovery requires explicit enablement, quota confirmation and an unexpired window', () => {
  const env = { DEMO_CODESPACE_RECOVERY_ENABLED: 'true', DEMO_CODESPACES_QUOTA_CONFIRMED: 'true', DEMO_UPTIME_UNTIL: '2026-10-27T00:00:00Z' };
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(recoveryEnabled(env, now), true);
  assert.equal(recoveryEnabled({ ...env, DEMO_CODESPACES_QUOTA_CONFIRMED: 'false' }, now), false);
  assert.equal(recoveryEnabled({ ...env, DEMO_UPTIME_UNTIL: 'invalid' }, now), false);
  assert.equal(recoveryEnabled(env, Date.parse('2026-10-28T00:00:00Z')), false);
});
test('recovery resumes only the existing Codespace and restores only port 3400', async () => {
  const calls = [];
  let reads = 0;
  await recoverDemo({ pause: async () => {}, run: (args) => {
    calls.push(args);
    if (args[0] === 'api' && args.length === 2) return JSON.stringify({ state: reads++ === 0 ? 'Shutdown' : 'Available' });
    return '';
  } });
  assert.ok(calls.some((args) => args.includes(`/user/codespaces/${CODESPACE}/start`)));
  assert.ok(calls.some((args) => args.includes('3400:public')));
  assert.ok(!calls.some((args) => args.includes('create') || args.includes('stop') || args.includes('delete')));
});
test('deleted or unavailable Codespaces require an operator instead of provisioning replacements', async () => {
  let count = 0;
  await assert.rejects(recoverDemo({ run: () => { count++; return '{"state":"Deleted"}'; } }), /operator attention/);
  assert.equal(count, 1);
});
