// Calls to the portal service (services/portal), same-origin at /api/portal. Signed-in calls carry
// the patient's own Medplum access token; the service checks it with Medplum on every request.

import type { MedplumClient } from '@medplum/core';

export class PortalError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`/api/portal/${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'omit',
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  if (!res.ok) throw new PortalError(res.status, json.message ?? 'The portal is not reachable. Check your connection and try again.', json.code);
  return json as T;
}

export const publicApi = {
  get: <T>(path: string): Promise<T> => call<T>('GET', `public/${path}`),
  post: <T>(path: string, body: unknown): Promise<T> => call<T>('POST', `public/${path}`, { body }),
};

export function portalApi(medplum: MedplumClient) {
  const token = (): string => {
    const t = medplum.getAccessToken();
    if (!t) throw new PortalError(401, 'Please sign in again.');
    return t;
  };
  return {
    get: <T>(path: string): Promise<T> => call<T>('GET', path, { token: token() }),
    post: <T>(path: string, body: unknown = {}): Promise<T> => call<T>('POST', path, { body, token: token() }),
  };
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong. Please try again.');
