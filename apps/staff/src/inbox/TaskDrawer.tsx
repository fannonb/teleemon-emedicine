import { Alert, Badge, Button, Drawer, Group, Modal, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Patient, Practitioner, Task } from '@medplum/fhirtypes';
import { ResourceInput, useMedplum } from '@medplum/react';
import type { Recurrence, Team } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, MIN_REASON, RECURRENCES, TEAMS, isOverdue, taskRecurrence, taskTeam, teamCoding } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { patientName } from '../fhir/patient';
import { formatDate } from '../utils/format';
import { staffOptions } from './inbox';

const PRIORITIES: { value: NonNullable<Task['priority']>; label: string }[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'asap', label: 'As soon as possible' },
  { value: 'stat', label: 'Immediately' },
];

/** Create or edit a task (P29). Generated tasks (faxes, results, refills) are worked on their own pages. */
export function TaskDrawer({ task, patient, staff, opened, onClose, onSaved }: {
  readonly task?: Task;
  readonly patient?: Patient;
  readonly staff: Practitioner[];
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): JSX.Element {
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md" title={<Text fw={650}>{task ? 'Task' : 'New task'}</Text>}>
      {opened && <TaskForm key={task?.id ?? patient?.id ?? 'new'} task={task} patient={patient} staff={staff} onClose={onClose} onSaved={onSaved} />}
    </Drawer>
  );
}

function TaskForm({ task, patient: initialPatient, staff, onClose, onSaved }: { readonly task?: Task; readonly patient?: Patient; readonly staff: Practitioner[]; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [description, setDescription] = useState(task?.description ?? '');
  const [patient, setPatient] = useState<Patient | undefined>(initialPatient);
  const [owner, setOwner] = useState<string | null>(task?.owner?.reference ?? null);
  const [team, setTeam] = useState<Team>(task ? taskTeam(task) : 'frontdesk');
  const [due, setDue] = useState<string>(task?.restriction?.period?.end?.slice(0, 10) ?? '');
  const [priority, setPriority] = useState<Task['priority']>(task?.priority ?? 'routine');
  const [recurrence, setRecurrence] = useState<Recurrence | null>(task ? taskRecurrence(task) ?? null : null);
  const [error, setError] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const generated = !!task && task.code?.coding?.some((c) => c.system === CODE_SYSTEMS.taskCode && c.code !== 'general');

  const build = (): Task => ({
    ...(task ?? { resourceType: 'Task', status: 'requested', intent: 'order', authoredOn: new Date().toISOString(), code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'general' }], text: 'Task' } }),
    description: description.trim(),
    for: task ? task.for : patient ? createReference(patient) : undefined,
    owner: owner ? { reference: owner } : undefined,
    performerType: teamCoding(team),
    priority,
    restriction: due === task?.restriction?.period?.end?.slice(0, 10) ? task.restriction : due ? { period: { end: `${due}T23:59:00.000Z` } } : undefined,
    extension: [...(task?.extension ?? []).filter((e) => e.url !== EXT.recurrence), ...(recurrence ? [{ url: EXT.recurrence, valueCode: recurrence }] : [])],
  });

  const save = async (status?: Task['status'], reason?: string): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      const next: Task = { ...build(), ...(status ? { status, statusReason: reason ? { text: reason } : undefined, lastModified: new Date().toISOString() } : {}) };
      if (task?.id) await medplum.updateResource(next, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
      else await medplum.createResource(next);
      notifications.show({ color: 'brand', message: status === 'completed' ? `Task completed${recurrence ? '; the next one is scheduled' : ''}.` : status ? 'Task closed.' : 'Task saved.' });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      {task && isOverdue(task) && <Alert color="red" variant="light">Overdue since {formatDate(task.restriction?.period?.end?.slice(0, 10))}</Alert>}
      {generated && <Badge variant="light">{task?.code?.text ?? 'Generated task'}</Badge>}
      <Textarea label="What needs doing" required autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} disabled={generated} />
      {task ? (
        <TextInput label="Patient" value={task.for ? patientName(patient) || task.for.display || 'Linked patient' : 'None'} readOnly />
      ) : (
        <ResourceInput<Patient> resourceType="Patient" name="patient" label="Patient (optional)" defaultValue={initialPatient} onChange={(p) => setPatient(p)} />
      )}
      <Group grow>
        <Select label="Assigned to" placeholder="Unassigned (team queue)" clearable searchable data={staffOptions(staff)} value={owner} onChange={setOwner} />
        <Select label="Team" data={TEAMS} value={team} onChange={(v) => v && setTeam(v as Team)} allowDeselect={false} />
      </Group>
      <Group grow>
        <TextInput type="date" label="Due" value={due} onChange={(e) => setDue(e.currentTarget.value)} />
        <Select label="Priority" data={PRIORITIES} value={priority} onChange={(v) => setPriority((v as Task['priority']) ?? 'routine')} allowDeselect={false} />
      </Group>
      <Select label="Repeats" placeholder="Does not repeat" clearable data={RECURRENCES} value={recurrence} onChange={(v) => setRecurrence(v as Recurrence | null)} disabled={generated}
        description={recurrence ? 'Completing it creates the next one automatically.' : undefined} />
      {error && <Alert color="red" variant="light" title="Not saved">{error}</Alert>}
      <Group justify="space-between" mt="sm">
        {task ? <Button variant="subtle" color="red" onClick={() => setClosing(true)}>Close with reason…</Button> : <span />}
        <Group gap="xs">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button variant={task ? 'default' : 'filled'} loading={busy} disabled={!description.trim()} onClick={() => save()}>Save</Button>
          {task && <Button loading={busy} onClick={() => save('completed')}>Complete</Button>}
        </Group>
      </Group>
      <CloseReasonModal opened={closing} onClose={() => setClosing(false)} title="Close task without completing it" onConfirm={(reason) => { setClosing(false); void save('cancelled', reason); }} />
    </Stack>
  );
}

/** Every item that ends without being done records why (enforced by the task-rules Bot). */
export function CloseReasonModal({ opened, onClose, onConfirm, title, label = 'Reason' }: { readonly opened: boolean; readonly onClose: () => void; readonly onConfirm: (reason: string) => void; readonly title: string; readonly label?: string }): JSX.Element {
  const [reason, setReason] = useState('');
  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack>
        <Textarea label={label} required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} description="Recorded with the item for audit; nothing is deleted." />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Back</Button>
          <Button color="red" disabled={reason.trim().length < MIN_REASON} onClick={() => { onConfirm(reason.trim()); setReason(''); }}>Confirm</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
