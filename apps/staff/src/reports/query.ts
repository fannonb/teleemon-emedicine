import type { MedplumClient } from '@medplum/core';
import type { Bundle, Resource, ResourceType } from '@medplum/fhirtypes';
import { getReportDefinition } from './catalog';
import type { ReportId, ReportRole } from './catalog';

export interface ReportDateFilters {
  /** Inclusive YYYY-MM-DD date. */
  readonly from?: string;
  /** Inclusive YYYY-MM-DD date. */
  readonly to?: string;
  /** Opaque cursor returned by the previous bounded page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface OperationalReportRow {
  readonly id: string;
  readonly resourceType: string;
  readonly status?: string;
  readonly date?: string;
  readonly lastUpdated?: string;
  readonly subjectRef?: string;
  readonly subjectDisplay?: string;
  readonly providerRef?: string;
  readonly providerDisplay?: string;
  readonly title?: string;
  readonly code?: string;
  readonly value?: string | number | boolean;
  readonly unit?: string;
  readonly interpretation?: string;
}

export interface OperationalReportResult {
  readonly reportId: ReportId;
  readonly asOf: string;
  readonly filters: { readonly from?: string; readonly to?: string };
  readonly rows: OperationalReportRow[];
  /** True only when this response contains the last page of actual FHIR records. */
  readonly complete: boolean;
  readonly nextCursor?: string;
  readonly total?: number;
  readonly source: 'fhir';
}

export interface FinancialReportResult {
  readonly reportId: ReportId;
  readonly asOf: string;
  readonly filters: { readonly from?: string; readonly to?: string; readonly asOf?: string };
  readonly rows: Record<string, string | number | boolean | null>[];
  readonly totals: Record<string, number>;
  readonly complete: boolean;
  readonly source: 'ledger';
  readonly reconciliation?: { readonly ok: boolean; readonly checks: { readonly label: string; readonly ok: boolean; readonly expectedCents?: number; readonly actualCents?: number; readonly unit?: 'cents' | 'count' }[] };
}

export class ReportQueryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ReportQueryError';
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validDateOnly(value: string, field: string): void {
  if (!DATE_ONLY.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new ReportQueryError(`${field} must be a valid date in YYYY-MM-DD format.`);
  }
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function reference(value: unknown): { ref?: string; display?: string } {
  const ref = record(value);
  return {
    ref: typeof ref.reference === 'string' ? ref.reference : undefined,
    display: typeof ref.display === 'string' ? ref.display : undefined,
  };
}

function firstCoding(value: unknown): string | undefined {
  const codable = record(value);
  const coding = Array.isArray(codable.coding) ? record(codable.coding[0]) : {};
  if (typeof coding.display === 'string') return coding.display;
  if (typeof coding.code === 'string') return coding.code;
  return typeof codable.text === 'string' ? codable.text : undefined;
}

function resourceDate(resource: Record<string, unknown>): string | undefined {
  const period = record(resource.period);
  const actualPeriod = record(resource.actualPeriod);
  const effective = record(resource.effective);
  const date = resource.start ?? period.start ?? actualPeriod.start ?? resource.date ?? resource.authoredOn ?? resource.authored ?? resource.authoredon ?? resource.sent ?? resource.created ?? resource.dateTime ?? effective.dateTime;
  return typeof date === 'string' ? date : undefined;
}

function subject(resourceType: string, resource: Record<string, unknown>): { ref?: string; display?: string } {
  if (resourceType === 'Patient' && typeof resource.id === 'string') {
    const names = Array.isArray(resource.name) ? resource.name.map(record) : [];
    const name = names.find((item) => item.use !== 'old') ?? names[0];
    const given = Array.isArray(name?.given) ? name.given.filter((x): x is string => typeof x === 'string').join(' ') : '';
    const family = typeof name?.family === 'string' ? name.family : '';
    const display = [given, family].filter(Boolean).join(' ') || (typeof name?.text === 'string' ? name.text : undefined);
    return { ref: `Patient/${resource.id}`, display };
  }
  const direct = resource.subject ?? resource.patient ?? resource.beneficiary ?? resource.recipient ?? resource.for;
  if (direct) return reference(direct);
  if (resourceType === 'Appointment' && Array.isArray(resource.participant)) {
    const participants = resource.participant.map((entry) => record(record(entry).actor));
    const patient = participants.find((actor) => typeof actor.reference === 'string' && actor.reference.startsWith('Patient/'));
    if (patient) return reference(patient);
  }
  return {};
}

function provider(resourceType: string, resource: Record<string, unknown>): { ref?: string; display?: string } {
  if (resourceType === 'Appointment' && Array.isArray(resource.participant)) {
    const participants = resource.participant.map((entry) => record(record(entry).actor));
    const practitioner = participants.find((actor) => typeof actor.reference === 'string' && /^(Practitioner|PractitionerRole)\//.test(actor.reference));
    if (practitioner) return reference(practitioner);
  }
  if (resourceType === 'Encounter' && Array.isArray(resource.participant)) {
    const participants = resource.participant.map((entry) => record(record(entry).individual));
    const practitioner = participants.find((actor) => typeof actor.reference === 'string' && /^(Practitioner|PractitionerRole)\//.test(actor.reference));
    if (practitioner) return reference(practitioner);
  }
  return reference(resource.requester ?? resource.author ?? resource.performer);
}

export function mapOperationalReportRow(resource: Resource): OperationalReportRow {
  const value = record(resource);
  const resourceType = typeof value.resourceType === 'string' ? value.resourceType : 'Resource';
  const patient = subject(resourceType, value);
  const clinician = provider(resourceType, value);
  const type = Array.isArray(value.type) ? firstCoding(value.type[0]) : firstCoding(value.type);
  const code = firstCoding(value.code) ?? type;
  const title = typeof value.title === 'string' ? value.title : typeof value.description === 'string' ? value.description : code;
  const quantity = record(value.valueQuantity);
  const interpretation = Array.isArray(value.interpretation) ? value.interpretation.map(firstCoding).filter((x): x is string => Boolean(x)).join(', ') : undefined;
  const score = typeof value.valueInteger === 'number' ? value.valueInteger
    : typeof quantity.value === 'number' ? quantity.value
      : typeof value.valueString === 'string' ? value.valueString
        : typeof value.valueBoolean === 'boolean' ? value.valueBoolean
          : undefined;
  return {
    id: typeof value.id === 'string' ? value.id : '',
    resourceType,
    status: typeof value.status === 'string' ? value.status : undefined,
    date: resourceDate(value),
    lastUpdated: typeof record(value.meta).lastUpdated === 'string' ? record(value.meta).lastUpdated as string : undefined,
    subjectRef: patient.ref,
    subjectDisplay: patient.display,
    providerRef: clinician.ref,
    providerDisplay: clinician.display,
    title,
    code,
    value: score,
    unit: typeof quantity.unit === 'string' ? quantity.unit : undefined,
    interpretation,
  };
}

interface ReportCursorPayload {
  readonly version: 1;
  readonly url: string;
  readonly reportId: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
}

function encodeCursor(payload: ReportCursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(
  cursor: string,
  medplum: MedplumClient,
  expected: Omit<ReportCursorPayload, 'version' | 'url'> & { readonly resourceType: string },
): string {
  let url: URL;
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    const binary = atob(base64);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Partial<ReportCursorPayload>;
    if (payload.version !== 1 || payload.reportId !== expected.reportId || payload.from !== expected.from || payload.to !== expected.to || payload.limit !== expected.limit || typeof payload.url !== 'string') {
      throw new Error('Cursor does not match this report.');
    }
    url = new URL(payload.url);
  } catch {
    throw new ReportQueryError('That report page link is invalid or belongs to different report filters. Reload the report.');
  }
  const fhir = new URL(medplum.fhirUrl('Patient'));
  const rootPath = fhir.pathname.slice(0, fhir.pathname.lastIndexOf('/Patient'));
  if (url.origin !== fhir.origin || url.pathname !== `${rootPath}/${expected.resourceType}` || url.username || url.password || url.hash) {
    throw new ReportQueryError('That report page link is not from this clinical server. Reload the report.');
  }
  return url.toString();
}

export function canViewReport(reportId: string, role: ReportRole): boolean {
  return getReportDefinition(reportId)?.roles.includes(role) ?? false;
}

/** Query one bounded FHIR page for an operational report; callers may follow nextCursor until complete. */
export async function queryOperationalReport(
  medplum: MedplumClient,
  reportId: string,
  filters: ReportDateFilters = {},
  role?: ReportRole,
): Promise<OperationalReportResult> {
  const definition = getReportDefinition(reportId);
  if (!definition || definition.source !== 'fhir' || !definition.fhir) throw new ReportQueryError('That operational report is not available.');
  if (role && !definition.roles.includes(role)) throw new ReportQueryError('Your role cannot view this report.', 403);
  if (filters.from) validDateOnly(filters.from, 'Start date');
  if (filters.to) validDateOnly(filters.to, 'End date');
  if (filters.from && filters.to && filters.from > filters.to) throw new ReportQueryError('The start date must be on or before the end date.');
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 200));
  let bundle: Bundle;
  if (filters.cursor) {
    bundle = await medplum.get<Bundle>(decodeCursor(filters.cursor, medplum, {
      reportId, resourceType: definition.fhir.resourceType, from: filters.from, to: filters.to, limit,
    }), { cache: 'no-cache' });
  } else {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(definition.fhir.searchParams ?? {})) params.set(name, value);
    if (definition.fhir.status) params.set('status', definition.fhir.status);
    if (filters.from) params.append(definition.fhir.dateParam, `ge${filters.from}`);
    if (filters.to) params.append(definition.fhir.dateParam, `lt${nextDate(filters.to)}`);
    params.set('_sort', '-_lastUpdated');
    params.set('_count', String(limit));
    bundle = await medplum.search(definition.fhir.resourceType as ResourceType, params, { cache: 'no-cache' });
  }
  const next = bundle.link?.find((link) => link.relation === 'next')?.url;
  const resources = (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
  return {
    reportId: definition.id as ReportId,
    asOf: new Date().toISOString(),
    filters: { from: filters.from, to: filters.to },
    rows: resources.map(mapOperationalReportRow),
    complete: !next,
    nextCursor: next ? encodeCursor({
      version: 1,
      url: new URL(next, medplum.fhirUrl('Patient')).toString(),
      reportId,
      from: filters.from,
      to: filters.to,
      limit,
    }) : undefined,
    total: typeof bundle.total === 'number' ? bundle.total : undefined,
    source: 'fhir',
  };
}

/** Query a role-protected financial report. The ledger service independently enforces biller/admin. */
export async function queryFinancialReport(
  medplum: MedplumClient,
  reportId: string,
  filters: { readonly from?: string; readonly to?: string; readonly asOf?: string } = {},
  role?: ReportRole,
): Promise<FinancialReportResult> {
  const definition = getReportDefinition(reportId);
  if (!definition || definition.source !== 'ledger') throw new ReportQueryError('That financial report is not available.');
  if (role && !definition.roles.includes(role)) throw new ReportQueryError('Your role cannot view this report.', 403);
  if (filters.from) validDateOnly(filters.from, 'Start date');
  if (filters.to) validDateOnly(filters.to, 'End date');
  if (filters.asOf) validDateOnly(filters.asOf, 'As-of date');
  if (filters.from && filters.to && filters.from > filters.to) throw new ReportQueryError('The start date must be on or before the end date.');
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.asOf) params.set('asOf', filters.asOf);
  const suffix = params.size ? `?${params.toString()}` : '';
  let response: Response;
  try {
    response = await fetch(`/api/ledger/reports/${encodeURIComponent(reportId)}${suffix}`, {
      headers: { Authorization: `Bearer ${medplum.getAccessToken()}` },
      cache: 'no-store',
    });
  } catch {
    throw new ReportQueryError('The financial reporting service is not reachable.', 0);
  }
  const bodyText = await response.text();
  let body: FinancialReportResult & { message?: unknown };
  try {
    body = bodyText ? JSON.parse(bodyText) as FinancialReportResult & { message?: unknown } : {} as FinancialReportResult & { message?: unknown };
  } catch {
    body = {} as FinancialReportResult & { message?: unknown };
  }
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `The report could not be loaded (HTTP ${response.status}).`;
    throw new ReportQueryError(message, response.status);
  }
  return body;
}
