import { Button, Chip, Group, Stack, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { PRACTICE_TIME_ZONE, US_STATE_TIME_ZONES } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ErrorState, Rows, useLoader } from './states';

export interface FreeTime {
  readonly start: string;
  readonly practitionerId: string;
  readonly provider: string;
}

export interface FreeDay {
  readonly date: string;
  readonly times: FreeTime[];
}

const addDays = (ymd: string, n: number): string => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: PRACTICE_TIME_ZONE }).format(new Date());

export function zoneFor(state: string | undefined): string {
  return (state && US_STATE_TIME_ZONES[state]) || PRACTICE_TIME_ZONE;
}

export function formatTime(iso: string, state?: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zoneFor(state) }).format(new Date(iso));
}

export function formatWhen(iso: string, state?: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zoneFor(state), timeZoneName: 'short' }).format(new Date(iso));
}

const zoneName = (state?: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: zoneFor(state), timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';

/**
 * Seven days at a time of free start times. Days without times stay visible but disabled, so the
 * patient sees that the practice is booked rather than closed.
 */
export function SlotPicker({ load, state, value, onChange }: { readonly load: (from: string) => Promise<FreeDay[]>; readonly state: string; readonly value?: FreeTime; readonly onChange: (t: FreeTime | undefined) => void }): JSX.Element {
  const [from, setFrom] = useState(today());
  const days = useLoader(() => load(from), [from, load]);
  const [day, setDay] = useState<string>();

  useEffect(() => {
    if (!days.data) return;
    if (!day || !days.data.some((d) => d.date === day && d.times.length)) setDay(days.data.find((d) => d.times.length)?.date);
  }, [days.data, day]);

  if (days.error) return <ErrorState message={days.error} onRetry={days.reload} />;
  const selected = days.data?.find((d) => d.date === day);
  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Button variant="subtle" size="sm" leftSection={<IconChevronLeft size={16} />} disabled={from <= today()} onClick={() => { setFrom(addDays(from, -7)); onChange(undefined); }}>Earlier</Button>
        <Text size="sm" c="dimmed" ta="center">Times in {zoneName(state)}</Text>
        <Button variant="subtle" size="sm" rightSection={<IconChevronRight size={16} />} onClick={() => { setFrom(addDays(from, 7)); onChange(undefined); }}>Later</Button>
      </Group>
      {!days.data || days.loading ? (
        <Rows count={2} />
      ) : (
        <>
          <div className="tm-day-strip" role="radiogroup" aria-label="Day">
            {days.data.map((d) => {
              const label = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.date}T12:00:00Z`));
              return (
                <Chip key={d.date} checked={d.date === day} disabled={!d.times.length} onChange={() => { setDay(d.date); onChange(undefined); }} size="md" radius="md">
                  {label}{!d.times.length && ' · no times'}
                </Chip>
              );
            })}
          </div>
          {selected ? (
            <div className="tm-times" role="radiogroup" aria-label="Time">
              {selected.times.map((t) => (
                <Button key={`${t.start}-${t.practitionerId}`} variant={value?.start === t.start && value.practitionerId === t.practitionerId ? 'filled' : 'default'} onClick={() => onChange(t)} aria-pressed={value?.start === t.start} className="tm-num">
                  {formatTime(t.start, state)}
                </Button>
              ))}
            </div>
          ) : (
            <Text c="dimmed" size="sm">No times this week. Choose Later to see the next week.</Text>
          )}
        </>
      )}
    </Stack>
  );
}
