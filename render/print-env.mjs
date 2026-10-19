// Prints the Render environment values produced by `npm run setup`.
//
//   node render/print-env.mjs --medplum https://teleemon-medplum.onrender.com \
//     --staff https://teleemon-staff.onrender.com --portal https://teleemon-portal.onrender.com
//
// Reads the same env file setup used (TELEEMON_ENV_FILE, default .env.local) plus the portal app's
// client id from apps/portal/.env.local. Secrets are printed to this terminal only; nothing is
// written and nothing should be committed.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const medplum = (arg('medplum', process.env.MEDPLUM_BASE_URL) ?? 'https://teleemon-medplum.onrender.com').replace(/\/+$/, '');
const staff = (arg('staff', process.env.STAFF_URL) ?? 'https://teleemon-staff.onrender.com').replace(/\/+$/, '');
const portal = (arg('portal', process.env.PORTAL_URL) ?? 'https://teleemon-portal.onrender.com').replace(/\/+$/, '');

function readEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

const envFile = join(ROOT, process.env.TELEEMON_ENV_FILE ?? '.env.local');
const setup = readEnv(envFile);
const portalApp = readEnv(join(ROOT, 'apps', 'portal', '.env.local'));

function block(service, values) {
  console.log(`\n# ${service}`);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') console.log(`${key}=            # missing`);
    else console.log(`${key}=${value}`);
  }
}

console.log(`Setup env file: ${envFile}`);
console.log('Copy these into the matching Render service, then redeploy that service.');
console.log('Do not paste this output into a repository, ticket, or chat.');

block('teleemon-staff (build + runtime)', {
  MEDPLUM_BASE_URL: `${medplum}/`,
  MEDPLUM_PROJECT_ID: setup.TELEEMON_PROJECT_ID,
  VITE_PORTAL_URL: portal,
});

block('teleemon-portal (build + runtime)', {
  MEDPLUM_BASE_URL: `${medplum}/`,
  MEDPLUM_PROJECT_ID: setup.TELEEMON_PROJECT_ID,
  MEDPLUM_CLIENT_ID: portalApp.MEDPLUM_CLIENT_ID,
});

block('teleemon-portal-api', {
  MEDPLUM_BASE_URL: `${medplum}/`,
  TELEEMON_PROJECT_ID: setup.TELEEMON_PROJECT_ID,
  TELEEMON_PORTAL_CLIENT_ID: setup.TELEEMON_PORTAL_CLIENT_ID,
  TELEEMON_PORTAL_CLIENT_SECRET: setup.TELEEMON_PORTAL_CLIENT_SECRET,
  TELEEMON_PORTAL_ACCOUNTS_CLIENT_ID: setup.TELEEMON_PORTAL_ACCOUNTS_CLIENT_ID,
  TELEEMON_PORTAL_ACCOUNTS_CLIENT_SECRET: setup.TELEEMON_PORTAL_ACCOUNTS_CLIENT_SECRET,
  TELEEMON_PORTAL_SECRET: setup.TELEEMON_PORTAL_SECRET,
  TELEEMON_PORTAL_URL: `${portal}/`,
  LEDGER_INTERNAL_TOKEN: setup.LEDGER_INTERNAL_TOKEN,
});

block('teleemon-ledger', {
  LEDGER_INTERNAL_TOKEN: setup.LEDGER_INTERNAL_TOKEN,
  LEDGER_ALLOWED_ORIGINS: staff,
});

block('teleemon-scribe', {
  MEDPLUM_BASE_URL: `${medplum}/`,
  SCRIBE_ALLOWED_ORIGINS: staff,
});

block('teleemon-worker', {
  MEDPLUM_BASE_URL: `${medplum}/`,
  TELEEMON_WORKER_CLIENT_ID: setup.TELEEMON_WORKER_CLIENT_ID,
  TELEEMON_WORKER_CLIENT_SECRET: setup.TELEEMON_WORKER_CLIENT_SECRET,
  LEDGER_INTERNAL_TOKEN: setup.LEDGER_INTERNAL_TOKEN,
});

block('teleemon-medplum', {
  MEDPLUM_ALLOWED_ORIGINS: `${staff},${portal}`,
  MEDPLUM_APP_BASE_URL: `${staff}/`,
});
