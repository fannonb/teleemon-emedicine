// Codespaces-only synthetic demo bootstrap. It creates secrets in ignored .env.local files, starts
// private database/Medplum containers, seeds synthetic fixtures once, then starts the API services.
// HYBRID_DEMO_TOKEN must be a Codespaces secret with the same value configured on both Render apps.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { ensureMonitor } from './ensure-monitor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV_PATH = join(ROOT, '.env.local');
const STATE_DIR = join(tmpdir(), 'teleemon-codespaces-demo');
const STATE_FILE = join(STATE_DIR, 'processes.json');
const LOG_DIR = join(homedir(), '.teleemon-codespaces', 'logs');
const BOOTSTRAP_STATE_FILE = join(homedir(), '.teleemon-codespaces', 'bootstrap-stages.json');
const COMPOSE_FILE = 'render/codespaces/docker-compose.yml';
const DEFAULTS = {
  MEDPLUM_BASE_URL: 'http://127.0.0.1:8103/',
  MEDPLUM_PUBLIC_BASE_URL: 'https://teleemon-staff-demo.onrender.com/medplum/',
  MEDPLUM_STAFF_URL: 'https://teleemon-staff-demo.onrender.com/',
  MEDPLUM_ADMIN_EMAIL: 'platform-admin@teleemon.test',
  TELEEMON_ADMIN_EMAIL: 'admin@teleemon.test',
  TELEEMON_PORTAL_URL: 'https://teleemon-patient-demo.onrender.com/',
  TELEEMON_PORTAL_HOST: '127.0.0.1',
  TELEEMON_PORTAL_PORT: '3120',
  LEDGER_HOST: '127.0.0.1',
  LEDGER_PORT: '3130',
  SCRIBE_HOST: '127.0.0.1',
  SCRIBE_PORT: '3111',
  TELEEMON_WORKER_PORT: '3110',
  HYBRID_BACKEND_PORT: '3401',
  MEDPLUM_API_PORT: '8103',
  PORTAL_API_PORT: '3120',
  LEDGER_API_PORT: '3130',
  SCRIBE_API_PORT: '3111',
  CLEARINGHOUSE_VENDOR: 'mock',
  ERX_VENDOR: 'mock',
  FAX_VENDOR: 'log',
  MEET_VENDOR: 'sandbox',
  SCRIBE_ALLOW_PHI: 'false',
  SCRIBE_CLINICAL_APPROVED: 'false',
};

function requireCodespaces() {
  if (process.env.CODESPACES !== 'true' || !process.env.CODESPACE_NAME) {
    throw new Error('This bootstrap only runs inside GitHub Codespaces.');
  }
}

function envValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function prepareEnv() {
  const values = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {};
  const setIfMissing = (key, value) => { if (!values[key]) values[key] = String(value); };
  for (const [key, value] of Object.entries(DEFAULTS)) setIfMissing(key, value);

  setIfMissing('MEDPLUM_ADMIN_PASSWORD', randomBytes(32).toString('base64url'));
  setIfMissing('MEDPLUM_DEFAULT_SUPER_ADMIN_EMAIL', values.MEDPLUM_ADMIN_EMAIL);
  setIfMissing('MEDPLUM_DEFAULT_SUPER_ADMIN_PASSWORD', values.MEDPLUM_ADMIN_PASSWORD);
  setIfMissing('TELEEMON_ADMIN_EMAIL', 'admin@teleemon.test');
  setIfMissing('TELEEMON_ADMIN_PASSWORD', 'Teleemon-Local-2026');
  setIfMissing('MEDPLUM_DB_PASSWORD', randomBytes(24).toString('hex'));
  setIfMissing('LEDGER_DB_PASSWORD', randomBytes(24).toString('hex'));
  setIfMissing('MEDPLUM_REDIS_PASSWORD', randomBytes(24).toString('hex'));
  setIfMissing('DATABASE_URL', `postgresql://medplum:${values.MEDPLUM_DB_PASSWORD}@medplum-db:5432/medplum`);
  setIfMissing('REDIS_URL', `redis://:${values.MEDPLUM_REDIS_PASSWORD}@redis:6379`);
  setIfMissing('LEDGER_DATABASE_URL', `postgresql://teleemon_ledger:${values.LEDGER_DB_PASSWORD}@127.0.0.1:5433/teleemon_ledger`);
  setIfMissing('MEDPLUM_BINARY_STORAGE', 'file:/data/binary/');
  setIfMissing('MEDPLUM_EMAIL_PROVIDER', 'none');
  setIfMissing('MEDPLUM_VM_CONTEXT_BOTS_ENABLED', 'true');
  setIfMissing('MEDPLUM_DEFAULT_BOT_RUNTIME_VERSION', 'vmcontext');
  setIfMissing('MEDPLUM_PRE_COMMIT_SUBSCRIPTIONS_ENABLED', 'true');
  setIfMissing('MEDPLUM_SAVE_AUDIT_EVENTS', 'true');
  setIfMissing('MEDPLUM_ALLOWED_ORIGINS', '*');
  setIfMissing('SCRIBE_ALLOWED_ORIGINS', '');
  setIfMissing('LEDGER_ALLOWED_ORIGINS', '');
  setIfMissing('TELEEMON_PORTAL_DEMO_PASSWORD', 'Synthetic-portal-2026!');

  const text = Object.entries(values).map(([key, value]) => `${key}=${envValue(value)}`).join('\n') + '\n';
  writeFileSync(ENV_PATH, text, { mode: 0o600 });
  Object.assign(process.env, values);
}

function run(command, args, { cwd = ROOT, label } = {}) {
  console.log(`[codespaces] ${label ?? `${command} ${args.join(' ')}`}`);
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split(/\r?\n/);
  let suppress = false;
  for (const line of lines) {
    if (/^Role logins \(password|^Sign in at .*password/i.test(line)) { suppress = true; continue; }
    if (suppress && (/^\s/.test(line) || !line.trim())) { if (!line.trim()) suppress = false; continue; }
    if (line.trim()) console.log(line);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label ?? command} exited with code ${result.status ?? 'unknown'}`);
}

async function waitForMedplum() {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8103/healthcheck', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* wait for the container to become ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  }
  throw new Error('Medplum did not become healthy within five minutes. Check `docker compose logs medplum`.');
}

async function waitForLedger() {
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: process.env.LEDGER_DATABASE_URL, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query('select 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  }
  throw new Error('Ledger database did not become ready within two minutes. Check `docker compose logs ledger-db`.');
}

function stopPrevious() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const records = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const { pid } of records) {
      if (!Number.isInteger(pid) || pid < 2) continue;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* old process group already exited */ }
    }
  } catch { /* stale state file */ }
}

function loadBootstrapStages() {
  try {
    const saved = JSON.parse(readFileSync(BOOTSTRAP_STATE_FILE, 'utf8'));
    const projectId = process.env.TELEEMON_PROJECT_ID ?? null;
    if (saved.medplumBaseUrl === process.env.MEDPLUM_BASE_URL && saved.projectId === projectId) return saved;
  } catch { /* first run or a stale marker */ }
  return {
    medplumBaseUrl: process.env.MEDPLUM_BASE_URL,
    projectId: process.env.TELEEMON_PROJECT_ID ?? null,
    setup: false,
    seed: false,
    portalDemo: false,
  };
}

function saveBootstrapStages(stages) {
  stages.medplumBaseUrl = process.env.MEDPLUM_BASE_URL;
  stages.projectId = process.env.TELEEMON_PROJECT_ID ?? null;
  writeFileSync(BOOTSTRAP_STATE_FILE, JSON.stringify(stages, null, 2) + '\n', { mode: 0o600 });
}

function launch(name, command, args, env) {
  const stdout = openSync(join(LOG_DIR, `${name}.log`), 'a');
  const stderr = openSync(join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(command, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', stdout, stderr] });
  child.unref();
  return { name, pid: child.pid };
}

async function main() {
  requireCodespaces();
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  prepareEnv();
  if ((process.env.HYBRID_DEMO_TOKEN ?? '').length < 32) {
    throw new Error('Set HYBRID_DEMO_TOKEN in the ignored Codespaces .env.local file or as a Codespaces secret. It must match the value on both Render demo services.');
  }
  stopPrevious();

  run('docker', ['compose', '--project-name', 'teleemon-codespaces', '--env-file', '.env.local', '-f', COMPOSE_FILE, 'up', '-d', '--build'], { label: 'start Medplum, Postgres and Redis' });
  await waitForMedplum();

  const stages = loadBootstrapStages();
  if (!stages.setup) {
    run('npm', ['run', 'setup'], { label: 'initialize synthetic Teleemon project' });
    Object.assign(process.env, parseEnv(readFileSync(ENV_PATH, 'utf8')));
    stages.setup = true;
    saveBootstrapStages(stages);
  }
  if (!stages.seed) {
    run('npm', ['run', 'seed'], { label: 'seed synthetic patients and appointments' });
    stages.seed = true;
    saveBootstrapStages(stages);
  }
  if (!stages.portalDemo) {
    run('npm', ['run', 'portal:demo'], { label: 'create synthetic patient portal sign-ins' });
    stages.portalDemo = true;
    saveBootstrapStages(stages);
  }

  Object.assign(process.env, parseEnv(readFileSync(ENV_PATH, 'utf8')));
  await waitForLedger();
  run(process.execPath, ['render/ledger-migrate.mjs'], { label: 'prepare synthetic ledger database' });

  const serviceEnv = { ...process.env };
  delete serviceEnv.PORT;
  const services = [
    ['ledger', 'npm', ['run', 'ledger']],
    ['scribe', 'npm', ['run', 'scribe']],
    ['portal', 'npm', ['run', 'portal']],
    ['worker', 'npm', ['run', 'worker']],
    ['protected-gateway', process.execPath, ['render/hybrid-backend.mjs']],
  ];
  const records = services.map(([name, command, args]) => launch(name, command, args, serviceEnv));
  records.push(launch('public-bridge', process.execPath, ['render/codespaces/public-bridge.mjs'], serviceEnv));
  writeFileSync(STATE_FILE, JSON.stringify(records), { mode: 0o600 });
  ensureMonitor(serviceEnv);

  console.log('[codespaces] backend started with synthetic-only fixtures and mock integrations.');
  console.log('[codespaces] only port 3400 is public; database and Medplum ports are not forwarded.');
  console.log(`[codespaces] service logs are under ${LOG_DIR}; use the existing Render demo URLs for the apps.`);
}

main().catch((error) => {
  console.error(`[codespaces] startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
