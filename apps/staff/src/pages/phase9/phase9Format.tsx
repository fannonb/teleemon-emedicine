import type { JSX } from 'react';
import { Badge } from '@mantine/core';
import type { MantineColor } from '@mantine/core';
import { formatDate, formatTime } from '../../utils/format';

const STATUS_COLORS: Record<string, MantineColor> = {
  accepted: 'green',
  active: 'blue',
  available: 'green',
  abnormal: 'red',
  attested: 'orange',
  booked: 'blue',
  complete: 'green',
  completed: 'green',
  failed: 'red',
  'not-recorded': 'orange',
  overdue: 'red',
  'not-configured': 'gray',
  'not recorded': 'orange',
  'in-progress': 'blue',
  pending: 'orange',
  requested: 'blue',
  observed: 'green',
  unavailable: 'red',
  unknown: 'gray',
  waitlist: 'gray',
};

export function statusColor(status: string | undefined): MantineColor {
  return STATUS_COLORS[(status ?? '').toLowerCase()] ?? 'gray';
}

export function StatusBadge({ status, label }: { readonly status?: string; readonly label?: string }): JSX.Element {
  const text = label ?? (status ? status.replaceAll('-', ' ') : 'Unknown');
  return <Badge color={statusColor(status)} variant="light">{text}</Badge>;
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return `${formatDate(value.slice(0, 10))} · ${formatTime(value)}`;
}

export function dateInputDaysAgo(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}
