// Boots the upstream Medplum server image on Render.
//
// The official image reads configuration from its own JSON file unless it is started with `env`.
// Render supplies database and Redis URLs (not the split host/port fields Medplum expects), so this
// wrapper translates those URLs to MEDPLUM_* variables and then execs the stock entrypoint with the
// `env` config source.
//
// It also maps Render's PORT to MEDPLUM_PORT, derives the public base/storage URLs, and keeps
// binary storage on the attached persistent disk.

import { spawn } from 'node:child_process';

const env = { ...process.env };

function setIfMissing(key, value) {
  if (value === undefined || value === null || value === '') return;
  if (env[key] === undefined || env[key] === '') env[key] = String(value);
}

function applyUrl(variable, prefix) {
  const raw = env[variable];
  if (!raw) return;
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[medplum] ignoring ${variable}: not a valid URL`);
    return;
  }
  const secure = url.protocol === 'rediss:';
  const defaultPort = url.protocol.startsWith('postgres') ? '5432' : '6379';
  setIfMissing(`${prefix}_HOST`, url.hostname);
  setIfMissing(`${prefix}_PORT`, url.port || defaultPort);
  if (url.username) setIfMissing(`${prefix}_USERNAME`, decodeURIComponent(url.username));
  if (url.password) setIfMissing(`${prefix}_PASSWORD`, decodeURIComponent(url.password));
  if (url.pathname && url.pathname !== '/') setIfMissing(`${prefix}_DBNAME`, decodeURIComponent(url.pathname.replace(/^\//, '')));
  if (secure) setIfMissing(`${prefix}_TLS`, '{}');
}

setIfMissing('MEDPLUM_PORT', env.PORT);
applyUrl('DATABASE_URL', 'MEDPLUM_DATABASE');
applyUrl('REDIS_URL', 'MEDPLUM_REDIS');

// Medplum needs a URL that browsers and services can reach.
const external = env.RENDER_EXTERNAL_URL?.replace(/\/+$/, '');
if (external) {
  setIfMissing('MEDPLUM_BASE_URL', `${external}/`);
  setIfMissing('MEDPLUM_STORAGE_BASE_URL', `${external}/storage/`);
  setIfMissing('MEDPLUM_APP_BASE_URL', env.STAFF_URL ? `${env.STAFF_URL.replace(/\/+$/, '')}/` : `${external}/`);
}

// The disk is mounted at /data (see render.yaml). Keep all patient binaries there.
setIfMissing('MEDPLUM_BINARY_STORAGE', 'file:/data/binary/');
setIfMissing('MEDPLUM_EMAIL_PROVIDER', 'none');
setIfMissing('MEDPLUM_SUPPORT_EMAIL', env.MEDPLUM_SUPPORT_EMAIL ?? 'support@example.com');
setIfMissing('MEDPLUM_VM_CONTEXT_BOTS_ENABLED', 'true');
setIfMissing('MEDPLUM_DEFAULT_BOT_RUNTIME_VERSION', 'vmcontext');
setIfMissing('MEDPLUM_SAVE_AUDIT_EVENTS', 'true');
setIfMissing('MEDPLUM_PRE_COMMIT_SUBSCRIPTIONS_ENABLED', 'true');
setIfMissing('MEDPLUM_SHUTDOWN_TIMEOUT_MILLISECONDS', '30000');
setIfMissing('MEDPLUM_LOG_LEVEL', 'info');

// Staging convenience: tighten to the staff and portal origins before handling real data.
setIfMissing('MEDPLUM_ALLOWED_ORIGINS', '*');

const args = [
  '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
  '--import',
  './packages/server/dist/otel/instrumentation.js',
  'packages/server/dist/index.js',
  'env',
];

console.log(`[medplum] starting with base ${env.MEDPLUM_BASE_URL ?? '(unset)'}, port ${env.MEDPLUM_PORT ?? '(unset)'}`);
const child = spawn(process.execPath, args, { cwd: '/usr/src/medplum', env, stdio: 'inherit' });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
