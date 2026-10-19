import { MedplumClient } from '@medplum/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_LOCAL = join(ROOT, '.env.local');

/** `TELEEMON_ENV_FILE` lets setup run against a deployed server without touching local values. */
function envFile(): string {
  const override = process.env.TELEEMON_ENV_FILE;
  return override ? join(ROOT, override) : ENV_LOCAL;
}

export function loadEnv(): void {
  // Re-read on every call and overwrite: bootstrap rewrites the env file mid-run.
  const file = envFile();
  if (existsSync(file)) {
    Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
  }
}

export function baseUrl(): string {
  return process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/';
}

/**
 * Connects with the Teleemon service client created by `npm run setup`. The service client keeps
 * scripts working once MFA is enforced, and acts inside the Teleemon project only.
 */
export async function connect(): Promise<MedplumClient> {
  loadEnv();
  const clientId = process.env.TELEEMON_CLIENT_ID;
  const clientSecret = process.env.TELEEMON_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('No service client configured. Run `npm run setup` first.');
  }
  const medplum = new MedplumClient({ baseUrl: baseUrl() });
  await medplum.startClientLogin(clientId, clientSecret);
  return medplum;
}

/** Password sign-in, used for the one-time bootstrap and by verification scripts acting as a role. */
export async function connectAsPassword(email: string, password: string): Promise<MedplumClient> {
  const medplum = new MedplumClient({ baseUrl: baseUrl() });
  const login = await withQuietPkceWarning(() => medplum.startLogin({ email, password }));
  if (login.mfaRequired || login.mfaEnrollRequired) {
    throw new Error(`${email} requires MFA, so it cannot sign in from a script.`);
  }
  if (!login.code) {
    throw new Error(`Sign-in for ${email} did not return an authorization code.`);
  }
  await medplum.processCode(login.code);
  return medplum;
}

/** The Medplum SDK logs a harmless PKCE fallback warning outside the browser; keep script output clean. */
async function withQuietPkceWarning<T>(fn: () => Promise<T>): Promise<T> {
  const { warn, error } = console;
  const filter =
    (original: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && args[0].startsWith('Failed to hash code verifier')) return;
      original(...args);
    };
  console.warn = filter(warn);
  console.error = filter(error);
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

export function writeEnvValues(values: Record<string, string>): void {
  const file = envFile();
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const kept = existing.filter((line) => line.trim() && !Object.keys(values).some((k) => line.startsWith(`${k}=`)));
  const lines = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}
