import type { MedplumClient } from '@medplum/core';
import type { Communication, Patient, Practitioner, Resource, Task } from '@medplum/fhirtypes';
import type { InboxKind, Team } from '@teleemon/core';
import { CODE_SYSTEMS, OPEN_TASK_STATUS_PARAM, PATIENT_MESSAGE_CATEGORIES, inboxKind, taskTeam } from '@teleemon/core';
import type { Role } from '../navigation';

/**
 * The queue definitions shared by the Today tiles and the Inbox/Tasks/Fax lists, so a dashboard
 * count always equals the rows behind it (P03 acceptance).
 */
export const QUEUES = {
  // Patient texts and portal messages (X05) share one queue and the same handling rules.
  messages: { resourceType: 'Communication' as const, params: (): Record<string, string> => ({ status: 'in-progress', category: PATIENT_MESSAGE_CATEGORIES.map((c) => `${CODE_SYSTEMS.communicationCategory}|${c}`).join(',') }) },
  faxes: { resourceType: 'Task' as const, params: (): Record<string, string> => ({ code: `${CODE_SYSTEMS.taskCode}|fax-review`, status: OPEN_TASK_STATUS_PARAM }) },
  results: { resourceType: 'Task' as const, params: (me: string): Record<string, string> => ({ code: `${CODE_SYSTEMS.taskCode}|result-review`, owner: me, status: OPEN_TASK_STATUS_PARAM }) },
  myTasks: { resourceType: 'Task' as const, params: (me: string): Record<string, string> => ({ owner: me, status: OPEN_TASK_STATUS_PARAM }) },
};

export function teamsForRoles(roles: readonly Role[]): Team[] {
  if (roles.includes('admin')) return ['frontdesk', 'provider', 'biller'];
  return roles.filter((r): r is Team => r === 'frontdesk' || r === 'provider' || r === 'biller');
}

export interface InboxRow {
  readonly key: string;
  readonly kind: InboxKind;
  readonly task?: Task;
  readonly message?: Communication;
  readonly patient?: Patient;
  readonly owner?: string;
  readonly team: Team;
  readonly arrived: string;
  readonly due?: string;
}

function byRef(entries: { resource?: Resource; search?: { mode?: string } }[] | undefined): Map<string, Resource> {
  const map = new Map<string, Resource>();
  for (const e of entries ?? []) if (e.resource && e.search?.mode === 'include') map.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
  return map;
}

/** Every open item the signed-in user can see: open Tasks and open patient messages. */
export async function loadInbox(medplum: MedplumClient): Promise<InboxRow[]> {
  const collect = async (type: 'Task' | 'Communication', params: URLSearchParams) => {
    const entries: NonNullable<import('@medplum/fhirtypes').Bundle['entry']> = [];
    for await (const page of medplum.searchResourcePages(type, params, { cache: 'no-cache' })) entries.push(...(page.bundle.entry ?? []));
    return { entry: entries };
  };
  const [tasks, messages] = await Promise.all([
    collect('Task', new URLSearchParams([['status', OPEN_TASK_STATUS_PARAM], ['_count', '100'], ['_sort', 'authored-on'], ['_include', 'Task:patient']])),
    collect('Communication', new URLSearchParams([...Object.entries(QUEUES.messages.params()), ['_count', '100'], ['_sort', 'sent'], ['_include', 'Communication:subject']])),
  ]);
  const included = new Map([...byRef(tasks.entry), ...byRef(messages?.entry)]);
  const rows: InboxRow[] = [];
  for (const e of tasks.entry ?? []) {
    const t = e.resource as Task | undefined;
    if (!t || e.search?.mode === 'include' || t.resourceType !== 'Task') continue;
    // PDMP checks are completed records, never open work.
    if (t.code?.coding?.some((c) => c.code === 'pdmp-check')) continue;
    // Portal invitation requests are processed by the portal service within a minute, not by people.
    if (t.code?.coding?.some((c) => c.code === 'portal-invite')) continue;
    rows.push({ key: `Task/${t.id}`, kind: inboxKind(t), task: t, patient: included.get(t.for?.reference ?? '') as Patient | undefined, owner: t.owner?.reference, team: taskTeam(t), arrived: t.authoredOn ?? t.meta?.lastUpdated ?? '', due: t.restriction?.period?.end });
  }
  for (const e of messages?.entry ?? []) {
    const m = e.resource as Communication | undefined;
    if (!m || e.search?.mode === 'include' || m.resourceType !== 'Communication') continue;
    rows.push({ key: `Communication/${m.id}`, kind: 'message', message: m, patient: included.get(m.subject?.reference ?? '') as Patient | undefined, team: 'frontdesk', arrived: m.sent ?? m.meta?.lastUpdated ?? '' });
  }
  return rows.sort((a, b) => a.arrived.localeCompare(b.arrived));
}

/** Staff who can be assigned work: active Practitioners in the practice. */
export async function loadStaff(medplum: MedplumClient): Promise<Practitioner[]> {
  return medplum.searchResources('Practitioner', { active: 'true', _count: '200' });
}

export function staffName(p: Practitioner | undefined): string {
  const n = p?.name?.[0];
  return n ? [n.given?.[0], n.family].filter(Boolean).join(' ') : 'Unknown';
}

export function staffOptions(staff: Practitioner[]): { value: string; label: string }[] {
  return staff.map((p) => ({ value: `Practitioner/${p.id}`, label: staffName(p) }));
}
