import { PRACTICE_TIME_ZONE } from '@teleemon/core';

export { practiceDayBounds } from '@teleemon/core';

/** FHIR date (YYYY-MM-DD) to MM/DD/YYYY without time-zone shifts. */
export function formatDate(date: string | undefined): string {
  if (!date) {
    return '—';
  }
  const [y, m, d] = date.slice(0, 10).split('-');
  return d ? `${m}/${d}/${y}` : date;
}

export function formatTime(instant: string | undefined, timeZone = PRACTICE_TIME_ZONE): string {
  if (!instant) {
    return '—';
  }
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(instant));
}

export function formatLongDate(date: Date, timeZone = PRACTICE_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }).format(date);
}

/** Short time-zone label such as "ET" or "PT" for a zone at a given instant. */
export function timeZoneAbbrev(instant: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName');
  return part?.value.replace(/^([A-Z])[SD]T$/, '$1T') ?? '';
}

/** "12 min", "3 h", "2 d" — compact age for work-queue items. */
export function formatAge(since: string | undefined, now = Date.now()): string {
  if (!since) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now - new Date(since).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function relativeFromNow(instant: string, now = Date.now()): string {
  const minutes = Math.round((new Date(instant).getTime() - now) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}
