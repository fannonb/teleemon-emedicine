import { Text, Tooltip } from '@mantine/core';
import type { JSX } from 'react';
import { formatDate } from '../utils/format';

export interface Point {
  readonly date: string;
  readonly value: number;
}

/** Tiny trend line for tables and summaries. Last point is emphasized. */
export function Sparkline({ points, max, width = 96, height = 28 }: { readonly points: Point[]; readonly max: number; readonly width?: number; readonly height?: number }): JSX.Element | null {
  if (points.length === 0) return null;
  const pad = 3;
  const xs = (i: number): number => (points.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (points.length - 1));
  const ys = (v: number): number => height - pad - (v / max) * (height - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} role="img" aria-label={`Trend: ${points.map((p) => p.value).join(', ')}`}>
      <path d={d} fill="none" stroke="var(--mantine-color-navy-4)" strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={xs(points.length - 1)} cy={ys(last.value)} r={3} fill="var(--mantine-color-brand-6)" />
    </svg>
  );
}

export interface Band {
  readonly min: number;
  readonly max: number;
  readonly color: string;
}

/**
 * Score-over-time chart with severity bands behind the line and labelled points.
 * Plain SVG: no chart library, works in both colour schemes, readable by screen readers.
 */
export function TrendChart({ points, max, bands, height = 180, label }: { readonly points: Point[]; readonly max: number; readonly bands: Band[]; readonly height?: number; readonly label: string }): JSX.Element {
  const width = 560;
  const left = 28;
  const right = 12;
  const top = 10;
  const bottom = 24;
  const w = width - left - right;
  const h = height - top - bottom;
  const x = (i: number): number => left + (points.length <= 1 ? w / 2 : (i * w) / (points.length - 1));
  const y = (v: number): number => top + h - (v / max) * h;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  const ticks = [0, Math.round(max / 2), max];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`${label}: ${points.map((p) => `${formatDate(p.date)} ${p.value}`).join('; ')}`}>
      {bands.map((b) => (
        <rect key={b.min} x={left} width={w} y={y(Math.min(b.max + 1, max))} height={Math.max(0, y(b.min) - y(Math.min(b.max + 1, max)))} fill={`var(--mantine-color-${b.color}-light)`} opacity={0.55} />
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={left + w} y1={y(t)} y2={y(t)} stroke="var(--tm-border)" strokeDasharray="3 3" />
          <text x={left - 6} y={y(t) + 4} fontSize={10} textAnchor="end" fill="var(--tm-text-muted)">
            {t}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--mantine-color-navy-6)" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={`${p.date}-${i}`}>
          <circle cx={x(i)} cy={y(p.value)} r={4} fill="var(--tm-surface-raised)" stroke="var(--mantine-color-navy-6)" strokeWidth={2} />
          <text x={x(i)} y={y(p.value) - 8} fontSize={11} fontWeight={650} textAnchor="middle" fill="currentColor">
            {p.value}
          </text>
          <text x={x(i)} y={height - 6} fontSize={10} textAnchor="middle" fill="var(--tm-text-muted)">
            {formatDate(p.date.slice(0, 10)).slice(0, 5)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ScoreChange({ current, previous, higherIsWorse = true }: { readonly current: number; readonly previous?: number; readonly higherIsWorse?: boolean }): JSX.Element | null {
  if (previous === undefined) return null;
  const diff = current - previous;
  if (diff === 0) return <Text size="xs" c="dimmed">no change</Text>;
  const better = higherIsWorse ? diff < 0 : diff > 0;
  return (
    <Tooltip label={`Previous: ${previous}`}>
      <Text size="xs" fw={600} c={better ? 'green.7' : 'red.7'} className="tm-num">
        {diff > 0 ? '▲' : '▼'} {Math.abs(diff)}
      </Text>
    </Tooltip>
  );
}
