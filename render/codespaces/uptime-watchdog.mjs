// A second timer, independent of GitHub's best-effort schedule. It keeps both public Render
// gateways receiving requests while this Codespace is running. It cannot recover a stopped VM.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorDemo } from '../monitor-demo.mjs';

export const UPTIME_DIR = join(homedir(), '.teleemon-codespaces', 'uptime');
export const CONFIG_FILE = join(UPTIME_DIR, 'config.json');
export const STATE_FILE = join(UPTIME_DIR, 'state.json');
export const PID_FILE = join(UPTIME_DIR, 'pid');
export const INTERVAL_MS = 120000;

export function activeWindow(config, now = Date.now()) {
  const until = Date.parse(config?.until ?? '');
  return config?.enabled !== false && Number.isFinite(until) && until > now;
}

export function saveJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export async function watchdogTick({
  config, previous = {}, probe = () => monitorDemo({ attempts: 2 }), now = () => Date.now(),
} = {}) {
  const startedAt = now();
  if (!activeWindow(config, startedAt)) return { ...previous, active: false, until: config?.until ?? null };
  const results = await probe();
  const observation = {
    startedAt: new Date(startedAt).toISOString(), completedAt: new Date(now()).toISOString(),
    healthy: results.every((result) => result.healthy), results,
  };
  return {
    active: true, until: config.until, pid: process.pid, intervalMs: INTERVAL_MS,
    ticks: (previous.ticks ?? 0) + 1,
    observations: [...(previous.observations ?? []), observation].slice(-60),
  };
}

export async function runWatchdog({
  readConfig = () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')),
  save = (state) => saveJson(STATE_FILE, state),
  probe, now = () => Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let state = {};
  while (true) {
    const startedAt = now();
    state = await watchdogTick({ config: readConfig(), previous: state, probe, now });
    save(state);
    if (!state.active) return;
    console.log(`[uptime-watchdog] ${state.observations.at(-1).completedAt} tick=${state.ticks} healthy=${state.observations.at(-1).healthy}`);
    await pause(Math.max(1000, INTERVAL_MS - (now() - startedAt)));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.CODESPACES !== 'true') throw new Error('The uptime watchdog runs only in the demo Codespace.');
  mkdirSync(UPTIME_DIR, { recursive: true, mode: 0o700 });
  await runWatchdog();
}
