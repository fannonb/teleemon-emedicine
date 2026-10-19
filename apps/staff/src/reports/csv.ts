import type { MedplumClient } from '@medplum/core';
import type { AuditEvent } from '@medplum/fhirtypes';
import { createReference } from '@medplum/core';
import { getReportDefinition } from './catalog';

export type CsvValue = string | number | boolean | null | undefined;

/** Escape CSV syntax and neutralize spreadsheet formula cells while preserving numeric values. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value !== 'number') {
    const trimmed = text.replace(/^[\s\u0000-\u001f]+/, '');
    const formulaLead = /^[=+\-@]/.test(trimmed);
    const negativeNumber = /^-\d+(?:\.\d+)?$/.test(trimmed);
    if (formulaLead && !negativeNumber) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function reportRowsToCsv(rows: readonly Record<string, CsvValue>[], columns?: readonly string[]): string {
  const keys = columns ? [...columns] : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (keys.length === 0) return '';
  return [keys.map(csvCell).join(','), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(','))].join('\r\n');
}

/** Audit an export using metadata only; patient names, identifiers and report rows are excluded. */
export async function recordReportExport(
  medplum: MedplumClient,
  reportId: string,
  input: { format: 'csv'; rowCount: number; from?: string; to?: string; asOf?: string },
): Promise<void> {
  const definition = getReportDefinition(reportId);
  if (!definition) throw new Error('Cannot log an export for an unknown report.');
  const profile = await medplum.getProfileAsync();
  const who = profile ? createReference(profile) : undefined;
  const range = [input.from && `from=${input.from}`, input.to && `to=${input.to}`, input.asOf && `asOf=${input.asOf}`].filter(Boolean).join('&');
  const event: AuditEvent = {
    resourceType: 'AuditEvent',
    type: { system: 'https://teleemon.com/codes/audit-event', code: 'report-export', display: 'Report export' },
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: `${definition.id}; format=${input.format}; rows=${Math.max(0, Math.floor(input.rowCount))}${range ? `; ${range}` : ''}`,
    agent: [{ requestor: true, who }],
    source: { observer: who ?? { display: 'Teleemon staff app' } },
  };
  await medplum.createResource<AuditEvent>(event);
}

export async function createAuditedCsvExport(
  medplum: MedplumClient,
  reportId: string,
  rows: readonly Record<string, CsvValue>[],
  input: { readonly columns?: readonly string[]; readonly from?: string; readonly to?: string; readonly asOf?: string },
): Promise<string> {
  const csv = reportRowsToCsv(rows, input.columns);
  await recordReportExport(medplum, reportId, { format: 'csv', rowCount: rows.length, from: input.from, to: input.to, asOf: input.asOf });
  return csv;
}
