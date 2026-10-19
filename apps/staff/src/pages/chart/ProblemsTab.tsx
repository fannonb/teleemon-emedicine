import { Alert, Badge, Button, Group, Menu, Modal, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Condition } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconChevronDown, IconListDetails, IconPlus } from '@tabler/icons-react';
import { DIAGNOSES, ICD10CM_SYSTEM, findDiagnosis, isSubstanceUseCode } from '@teleemon/core';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Section } from '../../components/Section';
import { conditionCode, conditionStatus, loadConditions } from '../../fhir/clinical';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

const STATUS: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'brand' },
  remission: { label: 'In remission', color: 'blue' },
  resolved: { label: 'Resolved', color: 'gray' },
  inactive: { label: 'Inactive', color: 'gray' },
};

const DX_OPTIONS = Object.entries(
  DIAGNOSES.reduce<Record<string, { value: string; label: string }[]>>((acc, d) => {
    (acc[d.group] ??= []).push({ value: d.code, label: `${d.code}  ${d.display}` });
    return acc;
  }, {})
).map(([group, items]) => ({ group, items }));

// P13 Problems and diagnoses.
export function ProblemsTab(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [filter, setFilter] = useState('active');
  const [adding, setAdding] = useState(false);
  const conditions = useLoader(() => loadConditions(medplum, patient), [patient.id]);

  const setStatus = async (c: Condition, status: string): Promise<void> => {
    try {
      await medplum.updateResource<Condition>({
        ...c,
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] },
        abatementDateTime: status === 'resolved' ? new Date().toISOString() : undefined,
        recorder: profile ? createReference(profile) : c.recorder,
      });
      notifications.show({ color: 'brand', message: `${c.code?.text} marked ${STATUS[status].label.toLowerCase()}.` });
      conditions.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };

  return (
    <>
      <Section
        title="Problems and diagnoses"
        loaded={conditions}
        actions={
          <Group gap="xs">
            <SegmentedControl size="xs" value={filter} onChange={setFilter} data={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
              Add diagnosis
            </Button>
          </Group>
        }
        isEmpty={(l) => l.length === 0}
        empty={{ icon: <IconListDetails size={22} />, title: 'No diagnoses recorded', text: 'Add DSM-5 diagnoses; each maps to a billable ICD-10-CM code.' }}
      >
        {(list) => {
          const shown = list.filter((c) => filter === 'all' || ['active', 'remission'].includes(conditionStatus(c)));
          return (
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={90}>ICD-10-CM</Table.Th>
                    <Table.Th>Diagnosis (DSM-5)</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Onset</Table.Th>
                    <Table.Th>Recorded</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shown.map((c) => {
                    const code = conditionCode(c);
                    const valid = !!findDiagnosis(code);
                    const status = STATUS[conditionStatus(c)] ?? STATUS.active;
                    return (
                      <Table.Tr key={c.id}>
                        <Table.Td>
                          <Tooltip label={valid ? 'Billable code in the current catalogue' : 'Not in the validated catalogue: cannot be attached to a claim'}>
                            <Badge variant="outline" color={valid ? 'gray' : 'red'} className="tm-num">
                              {code ?? '—'}
                            </Badge>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6}>
                            <Text size="sm" fw={500}>
                              {c.code?.text ?? c.code?.coding?.[0]?.display}
                            </Text>
                            {isSubstanceUseCode(code) && (
                              <Tooltip label="Substance use disorder. May be subject to 42 CFR Part 2 once decision D2 is made.">
                                <Badge size="xs" color="grape" variant="light">
                                  SUD
                                </Badge>
                              </Tooltip>
                            )}
                          </Group>
                          {c.note?.[0]?.text && (
                            <Text size="xs" c="dimmed">
                              {c.note[0].text}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Badge color={status.color} variant="light">
                            {status.label}
                          </Badge>
                        </Table.Td>
                        <Table.Td className="tm-num">{formatDate(c.onsetDateTime?.slice(0, 10))}</Table.Td>
                        <Table.Td className="tm-num">
                          <Text size="sm">{formatDate(c.recordedDate?.slice(0, 10))}</Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Menu position="bottom-end">
                            <Menu.Target>
                              <Button size="xs" variant="subtle" rightSection={<IconChevronDown size={12} />}>
                                Status
                              </Button>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {['active', 'remission', 'resolved'].map((s) => (
                                <Menu.Item key={s} disabled={conditionStatus(c) === s} onClick={() => setStatus(c, s)}>
                                  {STATUS[s].label}
                                </Menu.Item>
                              ))}
                            </Menu.Dropdown>
                          </Menu>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          );
        }}
      </Section>
      {adding && (
        <AddDiagnosisModal
          existing={conditions.data ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            conditions.reload();
          }}
        />
      )}
    </>
  );
}

function AddDiagnosisModal({ existing, onClose, onSaved }: { readonly existing: Condition[]; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [error, setError] = useState<string>();
  const activeCodes = useMemo(() => new Set(existing.filter((c) => conditionStatus(c) !== 'resolved').map(conditionCode)), [existing]);
  const form = useForm({
    initialValues: { code: '', status: 'active', onset: '', note: '' },
    validate: {
      code: (v) => (!v ? 'Choose a diagnosis' : activeCodes.has(v) ? 'This diagnosis is already on the active problem list' : !findDiagnosis(v) ? 'Not a billable code in the catalogue' : null),
      onset: (v) => (v && v > new Date().toISOString().slice(0, 10) ? 'Onset cannot be in the future' : null),
    },
  });
  const save = async (v: typeof form.values): Promise<void> => {
    const dx = findDiagnosis(v.code);
    try {
      await medplum.createResource<Condition>({
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: v.status }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        code: { coding: [{ system: ICD10CM_SYSTEM, code: v.code, display: dx?.display }], text: dx?.display },
        subject: createReference(patient),
        onsetDateTime: v.onset || undefined,
        recordedDate: new Date().toISOString(),
        recorder: profile ? createReference(profile) : undefined,
        note: v.note.trim() ? [{ text: v.note.trim() }] : undefined,
      });
      notifications.show({ color: 'brand', message: `${dx?.display} added.` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened onClose={onClose} title="Add diagnosis" size="lg" centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <Select label="Diagnosis" placeholder="Search by name or ICD-10 code" data={DX_OPTIONS} searchable required maxDropdownHeight={320} nothingFoundMessage="Not in the psychiatric catalogue" {...form.getInputProps('code')} />
          {isSubstanceUseCode(form.values.code) && (
            <Alert color="grape" variant="light">
              Substance use disorder diagnosis. If 42 CFR Part 2 applies to the practice (decision D2), these records will be segmented and need specific consent to disclose.
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select label="Status" data={[{ value: 'active', label: 'Active' }, { value: 'remission', label: 'In remission' }]} {...form.getInputProps('status')} />
            <TextInput label="Onset" type="date" {...form.getInputProps('onset')} />
          </SimpleGrid>
          <Textarea label="Specifiers or note" placeholder="e.g. with anxious distress" autosize minRows={2} {...form.getInputProps('note')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Add diagnosis</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
