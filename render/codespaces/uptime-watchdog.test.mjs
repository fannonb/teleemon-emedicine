import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERVAL_MS, runWatchdog, watchdogTick } from './uptime-watchdog.mjs';

test('expired watchdog never sends requests', async () => {
  const state = await watchdogTick({ config: { until: '2026-10-20T00:00:00Z' }, now: () => Date.parse('2026-10-21T00:00:00Z'), probe: () => { throw new Error('Must not probe'); } });
  assert.equal(state.active, false);
});
test('disabled watchdog exits without sending requests despite an unexpired window', async () => {
  const state = await watchdogTick({ config: { enabled: false, until: '2026-10-27T00:00:00Z' }, now: () => Date.parse('2026-10-20T00:00:00Z'), probe: () => { throw new Error('Must not probe'); } });
  assert.equal(state.active, false);
});
test('watchdog timer independently produces multiple observations at the configured cadence', async () => {
  let clock = Date.parse('2026-10-20T00:00:00Z');
  const expiry = clock + INTERVAL_MS * 3;
  const saved = [];
  let calls = 0;
  await runWatchdog({
    now: () => clock,
    readConfig: () => ({ until: new Date(expiry).toISOString() }),
    probe: async () => { calls++; return [{ healthy: true, name: 'Staff' }, { healthy: true, name: 'Patient' }]; },
    save: (state) => saved.push(state),
    pause: async (ms) => { assert.equal(ms, INTERVAL_MS); clock += ms; },
  });
  assert.equal(calls, 3);
  assert.equal(saved[2].ticks, 3);
  assert.equal(saved[2].observations.length, 3);
  assert.equal(saved[3].active, false);
});
test('a failed probe is recorded and does not stop subsequent timer ticks', async () => {
  const config = { until: '2026-10-27T00:00:00Z' };
  const now = () => Date.parse('2026-10-20T00:00:00Z');
  const failed = await watchdogTick({ config, now, probe: async () => [{ healthy: false }] });
  const recovered = await watchdogTick({ config, now, previous: failed, probe: async () => [{ healthy: true }] });
  assert.equal(recovered.ticks, 2);
  assert.equal(recovered.observations[0].healthy, false);
  assert.equal(recovered.observations[1].healthy, true);
});
