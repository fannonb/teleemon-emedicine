import type { MedplumClient } from '@medplum/core';
import type { DocumentReference, Reference, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, buildComplianceAttestation, complianceEvidenceFromTask } from '@teleemon/core';
import type { ComplianceAttestationDraft, ComplianceEvidence } from '@teleemon/core';
import { collectResources } from './shared';

export const COMPLIANCE_CHECKPOINTS = [
  { key: 'risk-analysis', title: 'Security risk analysis' },
  { key: 'workforce-training', title: 'Workforce privacy and security training' },
  { key: 'incident-response', title: 'Incident response plan' },
  { key: 'backup-recovery', title: 'Backup and recovery test' },
  { key: 'access-review', title: 'User access review' },
] as const;

export interface ComplianceCheckpoint {
  readonly key: string;
  readonly title: string;
  readonly evidence?: ComplianceEvidence;
  readonly task?: Task;
  readonly status: 'attested' | 'observed' | 'not-recorded';
  readonly vendor?: string;
  readonly executedOn?: string;
  readonly expiresOn?: string;
}

export interface BaaAttestation extends ComplianceCheckpoint {
  readonly key: string;
  readonly normalizedVendor: string;
  readonly vendor: string;
  readonly status: 'attested';
}

const inputValue = (task: Task, code: string) => task.input?.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code));

export async function loadComplianceCheckpoints(medplum: MedplumClient): Promise<ComplianceCheckpoint[]> {
  const tasks = await collectResources<Task>(medplum, 'Task', new URLSearchParams([['code', `${CODE_SYSTEMS.operations}|compliance-checkpoint`], ['_sort', '-authored-on']]));
  const checkpoints: ComplianceCheckpoint[] = COMPLIANCE_CHECKPOINTS.map(({ key, title }) => {
    const candidates = tasks.filter((task) => inputValue(task, 'compliance-checkpoint')?.valueCode === key)
      .sort((a, b) => (b.lastModified ?? b.authoredOn ?? '').localeCompare(a.lastModified ?? a.authoredOn ?? ''));
    const task = candidates[0];
    const evidence = task ? complianceEvidenceFromTask(task) : undefined;
    const kind = task ? inputValue(task, 'evidence-kind')?.valueCode : undefined;
    return {
      key,
      title,
      task,
      evidence,
      status: kind === 'observed' ? 'observed' : kind === 'attestation' ? 'attested' : 'not-recorded',
      vendor: task ? inputValue(task, 'vendor')?.valueString : undefined,
      executedOn: task ? inputValue(task, 'executed-on')?.valueDate : undefined,
      expiresOn: task ? inputValue(task, 'expires-on')?.valueDate : undefined,
    };
  });
  const baas = baaAttestationsFromTasks(tasks);
  return [...checkpoints, ...(baas.length ? baas : [{ key: 'baa-agreement', title: 'Business Associate Agreement', status: 'not-recorded' as const }])];
}

/** Returns the most recent attestation per vendor. BAA claims remain labelled as attestations. */
export async function loadBaaAttestations(medplum: MedplumClient): Promise<BaaAttestation[]> {
  const tasks = await collectResources<Task>(medplum, 'Task', new URLSearchParams([['code', `${CODE_SYSTEMS.operations}|compliance-checkpoint`], ['_sort', '-authored-on']]));
  return baaAttestationsFromTasks(tasks);
}

function baaAttestationsFromTasks(tasks: readonly Task[]): BaaAttestation[] {
  const latest = new Map<string, Task>();
  for (const task of tasks) {
    if (inputValue(task, 'compliance-checkpoint')?.valueCode !== 'baa-agreement') continue;
    const vendor = inputValue(task, 'vendor')?.valueString?.trim();
    const normalizedVendor = (vendor || 'unknown vendor').toLocaleLowerCase().replace(/\s+/g, ' ');
    const existing = latest.get(normalizedVendor);
    const order = (candidate: Task): string => candidate.meta?.lastUpdated ?? candidate.authoredOn ?? inputValue(candidate, 'attested-at')?.valueDateTime ?? '';
    if (!existing || order(task) > order(existing)) latest.set(normalizedVendor, task);
  }
  return [...latest.entries()].map(([normalizedVendor, task]) => {
    const vendor = inputValue(task, 'vendor')?.valueString?.trim() || 'Vendor not recorded';
    return {
      key: `baa-agreement:${normalizedVendor}`,
      title: `Business Associate Agreement — ${vendor}`,
      task,
      evidence: complianceEvidenceFromTask(task),
      status: 'attested' as const,
      normalizedVendor,
      vendor,
      executedOn: inputValue(task, 'executed-on')?.valueDate,
      expiresOn: inputValue(task, 'expires-on')?.valueDate,
    };
  }).sort((a, b) => a.vendor.localeCompare(b.vendor));
}

/** Records an explicit staff attestation and its evidence reference; it does not verify the document. */
export async function saveComplianceAttestation(
  medplum: MedplumClient,
  draft: ComplianceAttestationDraft & { readonly evidence: Reference<DocumentReference>; readonly recordedBy: NonNullable<ComplianceAttestationDraft['recordedBy']> },
  now = new Date()
): Promise<Task> {
  if (draft.checkpoint === 'baa-agreement') {
    if (!draft.vendor?.trim() || !draft.executedOn || !draft.evidence.reference?.startsWith('DocumentReference/')) {
      throw new Error('A BAA attestation needs a vendor, execution date, and a linked agreement document.');
    }
    const evidence = await medplum.readReference(draft.evidence);
    if (evidence.status !== 'current') throw new Error('The linked agreement document is not current.');
  }
  const task = buildComplianceAttestation(draft, now);
  const identifier = task.identifier?.find((item) => item.system)?.value;
  if (!identifier) throw new Error('Unable to generate a stable compliance record identifier.');
  return medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier: `https://fhir.teleemon.com/identifier/derived|${identifier}` }).toString());
}

export function complianceEvidenceLabel(checkpoint: ComplianceCheckpoint): string {
  if (checkpoint.status === 'observed') return 'Observed';
  if (checkpoint.status === 'attested') return 'Attested — not independently verified';
  return 'Not recorded';
}
