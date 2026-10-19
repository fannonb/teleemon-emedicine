import { PRACTICE_TIME_ZONE } from './fhir';

/** YYYY-MM-DD for an instant, in the given zone. */
export function zonedDate(instant: Date, timeZone = PRACTICE_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** Start and end (exclusive) of "today" in the practice time zone, as ISO instants. */
export function practiceDayBounds(now = new Date(), timeZone = PRACTICE_TIME_ZONE): { start: string; end: string } {
  const start = zonedMidnight(zonedDate(now, timeZone), timeZone);
  const next = new Date(start.getTime() + 36 * 3600 * 1000);
  return { start: start.toISOString(), end: zonedMidnight(zonedDate(next, timeZone), timeZone).toISOString() };
}

/** UTC instant of 00:00 on a calendar date in the given zone. */
export function zonedMidnight(ymd: string, timeZone: string): Date {
  return zonedTime(ymd, 0, 0, timeZone);
}

/** UTC instant for a wall-clock time on a calendar date in the given zone. */
export function zonedTime(ymd: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  const result = new Date(guess - offset);
  // Correct once if the offset differs at the result (DST boundary).
  const offset2 = zoneOffsetMs(result, timeZone);
  return offset2 === offset ? result : new Date(guess - offset2);
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Whole years between a FHIR birth date and a reference date. */
export function ageInYears(birthDate: string, on = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = on.getFullYear() - y;
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) {
    age--;
  }
  return age;
}

export function isMinor(birthDate: string | undefined, on = new Date()): boolean {
  return !!birthDate && ageInYears(birthDate, on) < 18;
}
