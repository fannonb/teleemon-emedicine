import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODESPACE = 'teleemon-synthetic-client-demo-5vxj76x9pjrhvp6v';
const ENDPOINT = `/user/codespaces/${CODESPACE}`;

export function recoveryEnabled(env, now = Date.now()) {
  const expiry = Date.parse(env.DEMO_UPTIME_UNTIL ?? '');
  return env.DEMO_CODESPACE_RECOVERY_ENABLED === 'true' &&
    env.DEMO_CODESPACES_QUOTA_CONFIRMED === 'true' &&
    Number.isFinite(expiry) && expiry > now;
}

export async function recoverDemo({
  run = (args, options = {}) => execFileSync('gh', args, {
    encoding: 'utf8', timeout: 360000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], ...options,
  }),
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
  until = process.env.DEMO_UPTIME_UNTIL,
} = {}) {
  let state = JSON.parse(run(['api', ENDPOINT])).state;
  let startRequested = false;
  for (let attempt = 0; state !== 'Available' && attempt < 60; attempt++) {
    if (state === 'Shutdown' && !startRequested) {
      run(['api', '--method', 'POST', `${ENDPOINT}/start`]);
      startRequested = true;
      console.log('Requested resume of the existing demo Codespace.');
    } else if (!['Shutdown', 'ShuttingDown', 'Starting', 'Rebuilding', 'Provisioning', 'Awaiting'].includes(state)) {
      throw new Error(`Codespace state ${state} requires operator attention; no replacement will be created.`);
    }
    await pause(5000);
    state = JSON.parse(run(['api', ENDPOINT])).state;
  }
  if (state !== 'Available') throw new Error('Existing Codespace did not become available.');
  // gh creates an ephemeral runner SSH key. No private key, Render token, database password,
  // or HYBRID_DEMO_TOKEN is copied into GitHub Actions.
  run(['codespace', 'ssh', '-c', CODESPACE, '--', '-o', 'BatchMode=yes', 'bash -s'], {
    input: (until ? `export DEMO_UPTIME_UNTIL='${new Date(until).toISOString()}'\n` : '') +
      readFileSync(new URL('./codespaces/ensure-running.sh', import.meta.url), 'utf8'),
  });
  // Restore only the port that the user explicitly approved. Never forward database/API ports.
  run(['codespace', 'ports', 'visibility', '3400:public', '-c', CODESPACE]);
  console.log('Existing backend checked; approved public port 3400 restored.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!recoveryEnabled(process.env)) {
    console.error('Recovery is disabled, expired, or its quota confirmation is missing.');
    process.exitCode = 1;
  } else if (!process.env.GH_TOKEN) {
    console.error('The encrypted DEMO_CODESPACES_TOKEN Actions secret is required.');
    process.exitCode = 1;
  } else {
    try { await recoverDemo(); }
    catch { console.error('Demo recovery failed. Inspect Codespaces status and private logs; no secrets are logged here.'); process.exitCode = 1; }
  }
}
