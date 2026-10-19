import type { MedplumClient } from '@medplum/core';
import type { Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, integrationHealth, integrationSignalFromTask } from '@teleemon/core';
import type { IntegrationHealth } from '@teleemon/core';
import { collectResources } from './shared';

const EXPECTED_LOCAL_COMPONENTS = [
  { key: 'worker', label: 'Background worker' },
  { key: 'sms', label: 'SMS delivery' },
  { key: 'email', label: 'Email delivery' },
  { key: 'erx', label: 'E-prescribing' },
  { key: 'fax', label: 'Fax delivery' },
  { key: 'billing', label: 'Billing workflow' },
  { key: 'clearinghouse', label: 'Claims clearinghouse' },
  { key: 'lab-interface', label: 'Lab interface' },
  { key: 'google-meet', label: 'Google Meet' },
  { key: 'openai-scribe', label: 'OpenAI scribe' },
] as const;

export async function loadIntegrationHealth(medplum: MedplumClient, now = new Date(), maxAgeMs = 5 * 60_000): Promise<IntegrationHealth[]> {
  const tasks = await collectResources<Task>(medplum, 'Task', new URLSearchParams([['code', `${CODE_SYSTEMS.operations}|integration-health`], ['_sort', '-authored-on']]), 1000);
  const latest = new Map<string, Task>();
  for (const task of tasks) {
    const signal = integrationSignalFromTask(task);
    if (signal && !latest.has(signal.key)) latest.set(signal.key, task);
  }
  const signals = EXPECTED_LOCAL_COMPONENTS.map((component) => {
    const signal = latest.has(component.key) ? integrationSignalFromTask(latest.get(component.key)!) : undefined;
    return signal ?? { key: component.key, label: component.label, configured: undefined };
  });
  return integrationHealth(signals, now, maxAgeMs);
}
