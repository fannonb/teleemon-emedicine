import type { MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, buildIntegrationHealthTask } from '@teleemon/core';
import type { WorkerOperationalSignal } from '@teleemon/core';

type HealthOutcome = NonNullable<WorkerOperationalSignal['outcome']>;

function getInput(task: Task | undefined, code: string): Task['input'] extends (infer T)[] | undefined ? T | undefined : never {
  return task?.input?.find((item) => item.type.coding?.some((coding) => coding.system === CODE_SYSTEMS.operations && coding.code === code)) as never;
}

async function upsertHealthTask(medplum: MedplumClient, task: Task, key: string): Promise<void> {
  const identifier = `${DERIVED_IDENTIFIER_SYSTEM}|integration-health:${key}`;
  const existing = await medplum.searchOne('Task', { identifier }, { cache: 'no-cache' });
  if (!existing) {
    await medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier }).toString());
    return;
  }
  const updated: Task = { ...existing, ...task, id: existing.id, meta: existing.meta };
  await medplum.updateResource(updated, { headers: { 'If-Match': `W/"${existing.meta?.versionId}"` } });
}

/** Records observed operational results without PHI or provider/vendor response text. */
export async function recordWorkerSignal(
  medplum: MedplumClient,
  signal: WorkerOperationalSignal
): Promise<void> {
  if (!signal.outcome || !signal.observedAt) throw new Error('An operational result needs an outcome and observation time.');
  await upsertHealthTask(medplum, buildIntegrationHealthTask(signal), signal.key);
}

/** Refreshes adapter configuration while keeping the most recent actual observation intact. */
export async function recordWorkerConfiguration(
  medplum: MedplumClient,
  configuration: Pick<WorkerOperationalSignal, 'key' | 'label' | 'configured' | 'mode'>
): Promise<void> {
  if (configuration.configured === undefined) throw new Error('Configuration state must be explicit.');
  const identifier = `${DERIVED_IDENTIFIER_SYSTEM}|integration-health:${configuration.key}`;
  const existing = await medplum.searchOne('Task', { identifier }, { cache: 'no-cache' });
  const outcome = getInput(existing, 'signal-outcome')?.valueCode;
  const observedAt = getInput(existing, 'observed-at')?.valueDateTime;
  const failureClass = getInput(existing, 'failure-class')?.valueCode;
  const signal: WorkerOperationalSignal = {
    ...configuration,
    ...(outcome === 'success' || outcome === 'failure' ? { outcome: outcome as HealthOutcome, observedAt } : {}),
    ...(outcome === 'failure' && failureClass ? { failureClass } : {}),
  };
  const task = buildIntegrationHealthTask(signal);
  if (existing) {
    const updated: Task = { ...existing, ...task, id: existing.id, meta: existing.meta };
    await medplum.updateResource(updated, { headers: { 'If-Match': `W/"${existing.meta?.versionId}"` } });
    return;
  }
  await medplum.createResourceIfNoneExist(task, new URLSearchParams({ identifier }).toString());
}

/** The worker heartbeat is separate from individual transport/workflow signals. */
export async function recordWorkerHeartbeat(medplum: MedplumClient, outcome: HealthOutcome, error?: unknown, at = new Date()): Promise<void> {
  await recordWorkerSignal(medplum, {
    key: 'worker',
    label: 'Background worker',
    configured: true,
    outcome,
    observedAt: at.toISOString(),
    failureClass: outcome === 'failure' && error instanceof Error ? error.name : undefined,
  });
}
