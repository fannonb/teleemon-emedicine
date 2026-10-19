// Tells patients a portal reply is waiting. The email says only that there is a message: the
// content stays in the portal.

import type { MedplumClient } from '@medplum/core';
import type { Communication, Patient, Reference } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT, PORTAL_REPLY } from '@teleemon/core';
import { emailOf, portalBaseUrl, sendEmail } from './mail';

export async function notifyReplies(service: MedplumClient, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * 86400000).toISOString();
  const replies = await service.searchResources('Communication', { category: `${CODE_SYSTEMS.communicationCategory}|${PORTAL_REPLY}`, _lastUpdated: `ge${since}`, _count: '200' }, { cache: 'no-cache' });
  let sent = 0;
  for (const reply of replies) {
    if (reply.extension?.some((e) => e.url === EXT.notifiedAt)) continue;
    // Mark first (version-checked) so two passes never email twice.
    let marked: Communication;
    try {
      marked = await service.updateResource<Communication>({ ...reply, extension: [...(reply.extension ?? []), { url: EXT.notifiedAt, valueDateTime: now.toISOString() }] }, { headers: { 'If-Match': `W/"${reply.meta?.versionId}"` } });
    } catch {
      continue;
    }
    const patient = await service.readReference(marked.subject as Reference<Patient>).catch(() => undefined);
    const email = patient && emailOf(patient);
    if (!email) continue;
    await sendEmail(email, 'You have a new message from Teleemon', `Your care team replied to your message. Sign in to read it: ${portalBaseUrl()}messages`);
    sent++;
  }
  return sent;
}
