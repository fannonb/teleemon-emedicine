import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activeWindow, CONFIG_FILE, PID_FILE, UPTIME_DIR } from './uptime-watchdog.mjs';

export function ensureMonitor(env = process.env) {
  if (env.CODESPACES !== 'true') throw new Error('Monitor launcher is Codespaces-only.');
  mkdirSync(UPTIME_DIR, { recursive: true, mode: 0o700 });
  if (env.DEMO_UPTIME_UNTIL) {
    const parsed = Date.parse(env.DEMO_UPTIME_UNTIL);
    if (!Number.isFinite(parsed)) throw new Error('Invalid temporary uptime expiry.');
    writeFileSync(CONFIG_FILE, JSON.stringify({ until: new Date(parsed).toISOString() }) + '\n', { mode: 0o600 });
  }
  let config;
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return undefined; }
  if (!activeWindow(config)) return undefined;
  const script = fileURLToPath(new URL('./uptime-watchdog.mjs', import.meta.url));
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (Number.isInteger(pid) && pid > 1) {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args[1] === script) return pid;
    }
  } catch { /* No live watchdog with the expected command. */ }
  const log = openSync(`${UPTIME_DIR}/monitor.log`, 'a', 0o600);
  const child = spawn(process.execPath, [script], { env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  if (!child.pid) throw new Error('Uptime watchdog did not start.');
  writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  return child.pid;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pid = ensureMonitor();
  console.log(pid ? 'Independent uptime watchdog is running.' : 'Independent uptime watchdog is disabled or expired.');
}
