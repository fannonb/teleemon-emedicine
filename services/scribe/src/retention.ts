import { OperationOutcomeError, isGone, isNotFound } from '@medplum/core';
import type { MedplumClient } from '@medplum/core';
import { SCRIBE_SYSTEM } from '@teleemon/core';
import type { ScribeSession } from '@teleemon/core';
import { saveSession, sessionData } from './service';

/** Signing-based deadline never overrides a hold. Never-signed/cancelled audio expires at the configured session deadline. */
export function retentionDue(session: ScribeSession, signedAt: string | undefined, now: Date): boolean {
  if (session.legalHold || session.audioDeletedAt) return false;
  if (['transcribing', 'drafting'].includes(session.state) && now.getTime() - Date.parse(session.processingStartedAt ?? session.createdAt) < 5 * 60000) return false;
  const unsigned = Date.parse(session.retainUntil);
  const signed = signedAt ? Date.parse(signedAt) + 7 * 86400000 : undefined;
  return Number.isFinite(unsigned) && now.getTime() >= (signed ?? unsigned);
}

/** Run with a dedicated retention client. Defaults to report-only; deployment schedules the explicit apply command. */
export async function runRetention(medplum: MedplumClient, apply = false, now = new Date()): Promise<{ due: number; deleted: number; held: number; failures: number }> {
  const report = { due: 0, deleted: 0, held: 0, failures: 0 };
  for await (const page of medplum.searchResourcePages('DocumentReference', { type: `${SCRIBE_SYSTEM}|session`, _count: '100' })) {
    for (const record of page) {
      try {
        let doc = await medplum.readResource('DocumentReference', record.id!, { cache: 'no-cache' }); let s = sessionData(doc);
        if (s.legalHold) { report.held++; continue; }
        const note = await medplum.searchOne('Composition', { encounter: `Encounter/${s.encounterId}`, status: 'final', _count: '1' }, { cache: 'no-cache' });
        if (!retentionDue(s, note?.attester?.[0]?.time ?? note?.date, now)) continue;
        report.due++; if (!apply) continue;
        // Re-read the hold just before each irreversible deletion. Production hold management
        // must coordinate with this maintenance window; no unconditional bucket lifecycle rule.
        for (const chunk of s.chunks) {
          doc = await medplum.readResource('DocumentReference', doc.id!, { cache: 'no-cache' }); s = sessionData(doc);
          if (s.legalHold) throw new Error('A legal hold was applied; retention stopped');
          // Only a confirmed 404/410 means already deleted; access or network errors must not mark audio deleted.
          const binary = await medplum.readResource('Binary', chunk.binaryId, { cache: 'no-cache' }).catch((error: unknown) => {
            const outcome = error instanceof OperationOutcomeError ? error.outcome : undefined;
            if (outcome && (isNotFound(outcome) || isGone(outcome))) return undefined;
            throw error;
          });
          if (!binary) continue; // retry after partial deletion
          if (binary.securityContext?.reference !== `DocumentReference/${doc.id}`) throw new Error('Audio security context mismatch');
          await medplum.deleteResource('Binary', chunk.binaryId);
        }
        s.audioDeletedAt = now.toISOString(); s.error = undefined;
        if (['recording', 'paused'].includes(s.state)) s.state = 'cancelled';
        await saveSession(medplum, doc, s);
        await medplum.createResource({ resourceType: 'AuditEvent', type: { system: SCRIBE_SYSTEM, code: 'audio-retention' }, action: 'D', recorded: now.toISOString(), outcome: '0', agent: [{ requestor: false, who: { display: 'Scribe retention service' } }], source: { observer: { display: 'Teleemon retention' } }, entity: [{ what: { reference: `DocumentReference/${doc.id}` } }] });
        report.deleted++;
      } catch { report.failures++; }
    }
  }
  return report;
}
