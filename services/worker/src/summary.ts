// Daily work summary email (P29): once a day after 7:00 AM practice time, each active staff member
// with an email address gets the number of open and overdue tasks assigned to them. Counts only:
// no patient names or clinical details leave the system in email.

import type { MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, GENERATED_IDENTIFIER_SYSTEM, OPEN_TASK_STATUS_PARAM, PRACTICE_TIME_ZONE, isOverdue, zonedDate, searchAll } from '@teleemon/core';
import type { Transport } from './transport';

const SEND_HOUR = 7;

function practiceHour(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: PRACTICE_TIME_ZONE }).format(now));
}

export async function sendDailySummaries(medplum: MedplumClient, email: Transport, now = new Date(), force = false, onlyPractitioner?: string, observeEmailOutcome?: (outcome: 'success' | 'failure', error?: unknown) => void): Promise<number> {
  if (!force && practiceHour(now) < SEND_HOUR) return 0;
  const day = zonedDate(now, PRACTICE_TIME_ZONE);
  let sent = 0;
  for (const prac of await searchAll(medplum, 'Practitioner', { active: 'true', _count: '100' })) {
    const address = prac.telecom?.find((t) => t.system === 'email' && t.value)?.value;
    if (!address || (onlyPractitioner && prac.id !== onlyPractitioner)) continue;
    const key = `daily-summary-${prac.id}-${day}`;
    if (await medplum.searchOne('Communication', { identifier: `${GENERATED_IDENTIFIER_SYSTEM}|${key}` }, { cache: 'no-cache' })) continue;
    const open = await searchAll(medplum, 'Task', { owner: `Practitioner/${prac.id}`, status: OPEN_TASK_STATUS_PARAM, _count: '100' });
    if (open.length === 0) continue;
    const overdue = open.filter((t) => isOverdue(t, now)).length;
    const subject = `Teleemon: ${open.length} open task${open.length === 1 ? '' : 's'}${overdue ? `, ${overdue} overdue` : ''}`;
    const text = `Good morning. You have ${open.length} open task${open.length === 1 ? '' : 's'} in Teleemon${overdue ? `, of which ${overdue} ${overdue === 1 ? 'is' : 'are'} overdue` : ''}. Sign in to review them under Tasks. This email intentionally contains no patient information.`;
    let result;
    try {
      result = await email.send(address, text, subject);
      observeEmailOutcome?.('success');
    } catch (err) {
      observeEmailOutcome?.('failure', err);
      throw err;
    }
    await medplum.createResource<Communication>({
      resourceType: 'Communication',
      identifier: [{ system: GENERATED_IDENTIFIER_SYSTEM, value: key }],
      status: 'completed',
      category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: 'staff-summary', display: 'Daily staff summary' }] }],
      recipient: [{ reference: `Practitioner/${prac.id}` }],
      sent: now.toISOString(),
      payload: [{ contentString: text }],
      note: [{ text: result.detail }],
    });
    sent++;
  }
  return sent;
}
