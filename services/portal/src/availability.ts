// Live free times for online booking (X01, X03). Only start times leave the service: never another
// patient's appointment, name or visit type.

import type { MedplumClient } from '@medplum/core';
import type { Appointment, Practitioner, Resource, Schedule, Slot } from '@medplum/fhirtypes';
import type { BookingChannel } from '@teleemon/core';
import { ACTIVE_STATUSES, PRACTICE_TIME_ZONE, availableStarts, busyIntervals, checkLicensure, findVisitType, licensedStates, onlineBookingProblem, readSettings, zonedDate } from '@teleemon/core';
import { badRequest } from './http';

export interface Provider {
  readonly practitioner: Practitioner;
  readonly schedule: Schedule;
  readonly name: string;
}

export async function loadProviders(medplum: MedplumClient): Promise<Provider[]> {
  const bundle = await medplum.search('Schedule', { active: 'true', _include: 'Schedule:actor', _count: '50' }, { cache: 'no-cache' });
  const practitioners = new Map<string, Practitioner>();
  const schedules: Schedule[] = [];
  for (const e of bundle.entry ?? []) {
    const r = e.resource as Resource | undefined;
    if (r?.resourceType === 'Practitioner' && r.active !== false) practitioners.set(`Practitioner/${r.id}`, r);
    if (r?.resourceType === 'Schedule') schedules.push(r);
  }
  return schedules.flatMap((schedule) => {
    const ref = schedule.actor.find((a) => a.reference?.startsWith('Practitioner/'))?.reference;
    const practitioner = ref ? practitioners.get(ref) : undefined;
    if (!practitioner) return [];
    const n = practitioner.name?.[0];
    const name = [n?.prefix?.[0], n?.given?.[0], n?.family].filter(Boolean).join(' ') + (n?.suffix?.length ? `, ${n.suffix.join(', ')}` : '');
    return [{ practitioner, schedule, name }];
  });
}

/** States where at least one bookable provider is licensed today. */
export async function bookableStates(medplum: MedplumClient): Promise<string[]> {
  const providers = await loadProviders(medplum);
  return [...new Set(providers.flatMap((p) => licensedStates(p.practitioner)))].sort();
}

export interface FreeTime {
  readonly start: string;
  readonly practitionerId: string;
  readonly provider: string;
}

export interface FreeDay {
  readonly date: string;
  readonly times: FreeTime[];
}

export interface FreeTimesQuery {
  readonly channel: BookingChannel;
  readonly state: string;
  readonly visitType: string;
  /** First practice-calendar day, YYYY-MM-DD; defaults to today. */
  readonly from?: string;
  readonly days?: number;
  /** Restrict to one provider (a returning patient's own provider). */
  readonly practitionerId?: string;
  readonly now?: Date;
}

export async function freeTimes(medplum: MedplumClient, q: FreeTimesQuery): Promise<FreeDay[]> {
  const now = q.now ?? new Date();
  const type = findVisitType(q.visitType);
  if (!type) throw badRequest('Choose a visit type.');
  if (!/^[A-Z]{2}$/.test(q.state)) throw badRequest('Choose the state you will be in during the visit.');
  const days = Math.min(Math.max(q.days ?? 7, 1), 14);
  const first = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : zonedDate(now, PRACTICE_TIME_ZONE);
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${first}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  const practice = await readSettings(medplum, 'practice');
  const closures = practice.closures.map((c) => c.date);

  const providers = (await loadProviders(medplum)).filter((p) => !q.practitionerId || p.practitioner.id === q.practitionerId);
  const licensed = providers.filter((p) => dates.some((d) => checkLicensure(p.practitioner, q.state, d).ok));
  if (licensed.length === 0) throw badRequest(`We can only see patients who are in ${(await bookableStates(medplum)).join(', ') || 'a licensed state'} during their visit.`, 'unlicensed-state');

  const rangeStart = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 86400000).toISOString();
  const rangeEnd = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 2 * 86400000).toISOString();
  const result = new Map<string, FreeTime[]>(dates.map((d) => [d, []]));
  for (const p of licensed) {
    const [appointments, blocked] = await Promise.all([
      medplum.searchResources('Appointment', new URLSearchParams([
        ['actor', `Practitioner/${p.practitioner.id}`], ['date', `ge${rangeStart}`], ['date', `lt${rangeEnd}`], ['status', ACTIVE_STATUSES.join(',')], ['_count', '500'],
      ]), { cache: 'no-cache' }) as Promise<Appointment[]>,
      medplum.searchResources('Slot', new URLSearchParams([
        ['schedule', `Schedule/${p.schedule.id}`], ['status', 'busy-unavailable'], ['start', `ge${rangeStart}`], ['start', `lt${rangeEnd}`], ['_count', '500'],
      ]), { cache: 'no-cache' }) as Promise<Slot[]>,
    ]);
    const busy = busyIntervals(appointments, blocked);
    for (const date of dates) {
      if (!checkLicensure(p.practitioner, q.state, date).ok) continue;
      for (const start of availableStarts(date, type.minutes, busy, { hours: practice.hours, closures, now })) {
        if (onlineBookingProblem({ channel: q.channel, visitType: type.code, start, state: q.state, now, hours: practice.hours, closures })) continue;
        result.get(date)?.push({ start, practitionerId: p.practitioner.id as string, provider: p.name });
      }
    }
  }
  return dates.map((date) => ({ date, times: (result.get(date) ?? []).sort((a, b) => a.start.localeCompare(b.start)) }));
}
