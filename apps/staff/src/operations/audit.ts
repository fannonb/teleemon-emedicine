import type { MedplumClient } from '@medplum/core';
import type { AuditEvent, Bundle } from '@medplum/fhirtypes';
import { deriveAuditAlerts } from '@teleemon/core';
import type { AuditAlert } from '@teleemon/core';

export interface AuditFilters {
  readonly since?: string;
  readonly until?: string;
  readonly outcome?: string;
  readonly action?: string;
  readonly agent?: string;
  readonly entity?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AuditSearchResult {
  readonly events: readonly AuditEvent[];
  readonly alerts: readonly AuditAlert[];
  readonly complete: boolean;
  readonly nextCursor?: string;
  readonly total?: number;
}

interface AuditCursor {
  readonly version: 1;
  readonly url: string;
  readonly filters: Omit<AuditFilters, 'cursor'>;
}

function encodeCursor(cursor: AuditCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string, medplum: MedplumClient, expected: Omit<AuditFilters, 'cursor'>): string {
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    const payload = JSON.parse(atob(base64)) as AuditCursor;
    const url = new URL(payload.url);
    const base = new URL(medplum.fhirUrl('AuditEvent'));
    if (payload.version !== 1 || JSON.stringify(payload.filters) !== JSON.stringify(expected) || url.origin !== base.origin || url.pathname !== base.pathname) throw new Error();
    return url.toString();
  } catch {
    throw new Error('This audit page cursor is invalid or expired. Refresh the search.');
  }
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Audit dates must use YYYY-MM-DD format.');
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/** Returns one bounded server page, newest first; a cursor continues older matching events. */
export async function loadAuditEvents(medplum: MedplumClient, filters: AuditFilters = {}): Promise<AuditSearchResult> {
  const limit = Math.max(1, Math.min(filters.limit ?? 200, 500));
  const stableFilters = { since: filters.since, until: filters.until, outcome: filters.outcome, action: filters.action, agent: filters.agent, entity: filters.entity, limit };
  let bundle: Bundle;
  if (filters.cursor) {
    bundle = await medplum.get<Bundle>(decodeCursor(filters.cursor, medplum, stableFilters), { cache: 'no-cache' });
  } else {
    const params = new URLSearchParams([['_sort', '-date'], ['_count', String(limit)]]);
    if (filters.since) params.append('date', `ge${filters.since}`);
    if (filters.until) params.append('date', /^\d{4}-\d{2}-\d{2}$/.test(filters.until) ? `lt${nextDate(filters.until)}` : `le${filters.until}`);
    if (filters.outcome) params.set('outcome', filters.outcome);
    if (filters.action) params.set('action', filters.action);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.entity) params.set('entity', filters.entity);
    bundle = await medplum.search('AuditEvent', params, { cache: 'no-cache' });
  }
  const next = bundle.link?.find((link) => link.relation === 'next')?.url;
  const events = (bundle.entry ?? []).flatMap((entry) => entry.resource?.resourceType === 'AuditEvent' ? [entry.resource] : []);
  return {
    events,
    alerts: deriveAuditAlerts(events),
    complete: !next,
    nextCursor: next ? encodeCursor({ version: 1, url: new URL(next, medplum.fhirUrl('AuditEvent')).toString(), filters: stableFilters }) : undefined,
    total: typeof bundle.total === 'number' ? bundle.total : undefined,
  };
}

export { deriveAuditAlerts };
