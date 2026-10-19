import { Alert, Autocomplete, Badge, Button, Grid, Group, Modal, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { AllergyIntolerance, MedicationStatement, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertTriangle, IconFlask, IconPill, IconPlus } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT, MEDICATIONS, SCHEDULE_LABEL, findMedication } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { loadMeds, medName, medSchedule } from '../../fhir/clinical';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { PrescriptionsCard } from '../../prescribing/PrescriptionsCard';
import { useRoles } from '../../session/roles';
import { useChart } from './ChartContext';

const NKA_CODE = '716186003';

// P14 Medications and allergies.
export function MedicationsTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient, refresh } = useChart();
  const { roles } = useRoles();
  const canPrescribe = roles.includes('provider') && medplum.getProfile()?.resourceType === 'Practitioner';
  const [addingMed, setAddingMed] = useState(false);
  const [stopping, setStopping] = useState<MedicationStatement>();
  const [addingAllergy, setAddingAllergy] = useState(false);
  const meds = useLoader(() => loadMeds(medplum, patient, true), [patient.id]);
  const allergies = useLoader(() => medplum.searchResources('AllergyIntolerance', { patient: `Patient/${patient.id}`, _count: '50' }, { cache: 'no-cache' }), [patient.id]);
  const monitoring = useLoader(
    () =>
      medplum
        .searchResources('Task', { subject: `Patient/${patient.id}`, code: `${CODE_SYSTEMS.taskCode}|lab-monitoring`, status: 'requested,ready,in-progress', _count: '20' }, { cache: 'no-cache' })
        .catch(() => [] as Task[]),
    [patient.id], 5000
  );

  const confirmNka = async (): Promise<void> => {
    try {
      await medplum.createResource<AllergyIntolerance>({
        resourceType: 'AllergyIntolerance',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'confirmed' }] },
        code: { coding: [{ system: 'http://snomed.info/sct', code: NKA_CODE, display: 'No known allergy' }], text: 'No known allergies' },
        patient: createReference(patient),
        recordedDate: new Date().toISOString(),
      });
      allergies.reload();
      refresh();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <Section
          title="Medications"
          loaded={meds}
          actions={
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAddingMed(true)}>
              Add medication
            </Button>
          }
          isEmpty={(l) => l.length === 0}
          empty={{ icon: <IconPill size={22} />, title: 'No medications recorded', text: 'Record current and past medications. Prescriptions sent from the Prescriptions card appear here automatically.' }}
        >
          {(list) => {
            const active = list.filter((m) => m.status === 'active');
            const past = list.filter((m) => m.status !== 'active');
            const row = (m: MedicationStatement): JSX.Element => {
              const schedule = medSchedule(m);
              const rule = findMedication(medName(m))?.monitoring;
              return (
                <Table.Tr key={m.id} style={{ opacity: m.status === 'active' ? 1 : 0.6 }}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text size="sm" fw={600}>
                        {medName(m)}
                      </Text>
                      {schedule && (
                        <Tooltip label="Controlled substance: PDMP check and agreement required">
                          <Badge color="red" variant="light">
                            {SCHEDULE_LABEL[schedule]}
                          </Badge>
                        </Tooltip>
                      )}
                      {rule && m.status === 'active' && (
                        <Tooltip label={`Monitoring: ${rule.label} every ${rule.everyDays} days`}>
                          <Badge color="blue" variant="light" leftSection={<IconFlask size={11} />}>
                            Monitoring
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {m.dosage?.[0]?.text}
                    </Text>
                  </Table.Td>
                  <Table.Td className="tm-num">{formatDate(m.effectivePeriod?.start)}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {m.informationSource?.display ?? (m.informationSource?.reference?.startsWith('Patient') ? 'Patient-reported' : 'Practice')}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    {m.status === 'active' ? (
                      <Button size="xs" variant="subtle" color="gray" onClick={() => setStopping(m)}>
                        Stop
                      </Button>
                    ) : (
                      <Badge color="gray" variant="light">
                        {m.status}
                      </Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            };
            return (
              <Table.ScrollContainer minWidth={600}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Medication</Table.Th>
                      <Table.Th>Started</Table.Th>
                      <Table.Th>Source</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {active.map(row)}
                    {past.length > 0 && (
                      <Table.Tr>
                        <Table.Td colSpan={4}>
                          <Text size="xs" fw={650} tt="uppercase" c="dimmed" lts="0.05em">
                            Past
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    )}
                    {past.map(row)}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            );
          }}
        </Section>
        <Stack mt="lg">
          <PrescriptionsCard patient={patient} canPrescribe={canPrescribe} onChange={() => { meds.reload(); refresh(); }} />
        </Stack>
        <Text size="xs" c="dimmed" mt="sm">
          Pharmacy fill history (medication history from the vendor network) arrives when the e-prescribing vendor is connected.
        </Text>
      </Grid.Col>

      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Stack gap="lg">
          <Section
            title="Allergies"
            loaded={allergies}
            actions={
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAddingAllergy(true)}>
                Add
              </Button>
            }
          >
            {(list) => {
              const real = list.filter((a) => !a.code?.coding?.some((c) => c.code === NKA_CODE) && a.clinicalStatus?.coding?.[0]?.code !== 'inactive');
              const nka = list.some((a) => a.code?.coding?.some((c) => c.code === NKA_CODE));
              if (real.length === 0 && !nka) {
                return (
                  <Stack gap="xs">
                    <Group gap={6}>
                      <IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" />
                      <Text size="sm" fw={600} c="orange.7">
                        Allergies not yet recorded
                      </Text>
                    </Group>
                    <Button size="xs" variant="default" onClick={confirmNka}>
                      Confirm no known allergies
                    </Button>
                  </Stack>
                );
              }
              return real.length === 0 ? (
                <Text size="sm">No known allergies (confirmed)</Text>
              ) : (
                <Stack gap="sm">
                  {real.map((a) => (
                    <div key={a.id}>
                      <Group gap={6}>
                        <Text size="sm" fw={600} c="red.7">
                          {a.code?.text}
                        </Text>
                        {a.reaction?.[0]?.severity && (
                          <Badge size="xs" color={a.reaction[0].severity === 'severe' ? 'red' : 'orange'} variant="light">
                            {a.reaction[0].severity}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {a.reaction?.[0]?.manifestation?.[0]?.text ?? 'Reaction not recorded'}
                      </Text>
                    </div>
                  ))}
                </Stack>
              );
            }}
          </Section>
          <Section title="Lab monitoring due" loaded={monitoring} isEmpty={(l) => l.length === 0} empty={{ icon: <IconFlask size={22} />, title: 'Nothing due', text: 'Adding lithium, valproate, clozapine or an antipsychotic creates a monitoring task.' }}>
            {(tasks) => (
              <Stack gap="xs">
                {tasks.map((t) => (
                  <div key={t.id}>
                    <Text size="sm" fw={500}>
                      {t.description}
                    </Text>
                    <Text size="xs" c="dimmed" className="tm-num">
                      Due {formatDate(t.restriction?.period?.end?.slice(0, 10))}
                    </Text>
                  </div>
                ))}
              </Stack>
            )}
          </Section>
        </Stack>
      </Grid.Col>

      {addingMed && <AddMedicationModal onClose={() => setAddingMed(false)} onSaved={() => { setAddingMed(false); meds.reload(); monitoring.reload(); refresh(); }} />}
      {stopping && <StopMedicationModal med={stopping} onClose={() => setStopping(undefined)} onSaved={() => { setStopping(undefined); meds.reload(); refresh(); }} />}
      {addingAllergy && <AddAllergyModal existing={allergies.data ?? []} onClose={() => setAddingAllergy(false)} onSaved={() => { setAddingAllergy(false); allergies.reload(); refresh(); }} />}
    </Grid>
  );
}

function AddMedicationModal({ onClose, onSaved }: { readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [error, setError] = useState<string>();
  const form = useForm({
    initialValues: { name: '', dose: '', start: '', source: 'patient' },
    validate: { name: (v) => (v.trim() ? null : 'Required'), dose: (v) => (v.trim() ? null : 'Dose and directions are required') },
  });
  const entry = findMedication(form.values.name);

  const save = async (v: typeof form.values): Promise<void> => {
    const known = findMedication(v.name);
    try {
      await medplum.createResource<MedicationStatement>({
        resourceType: 'MedicationStatement',
        status: 'active',
        medicationCodeableConcept: { text: known?.name ?? v.name.trim() },
        subject: createReference(patient),
        effectivePeriod: v.start ? { start: v.start } : undefined,
        dateAsserted: new Date().toISOString(),
        informationSource: v.source === 'patient' ? { ...createReference(patient), display: 'Patient-reported' } : profile ? createReference(profile) : undefined,
        dosage: [{ text: v.dose.trim() }],
        extension: known?.schedule ? [{ url: EXT.controlledSchedule, valueCode: known.schedule }] : undefined,
      });
      notifications.show({ color: 'brand', message: `${known?.name ?? v.name} added${known?.monitoring ? '. Lab monitoring is being scheduled by the server.' : '.'}` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  return (
    <Modal opened onClose={onClose} title="Add medication" size="lg" centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <Autocomplete label="Medication" required data={MEDICATIONS.map((m) => m.name)} limit={12} {...form.getInputProps('name')} />
          {entry?.schedule && <Alert color="red" variant="light">{SCHEDULE_LABEL[entry.schedule]} controlled substance. A controlled-substance agreement is required, and every prescription needs a PDMP check (Phase 5).</Alert>}
          {entry?.monitoring && <Alert color="blue" variant="light">Requires monitoring: {entry.monitoring.label}. A task will be created.</Alert>}
          {form.values.name && !entry && <Text size="xs" c="dimmed">Not in the practice list: recorded as free text.</Text>}
          <TextInput label="Dose and directions" placeholder="e.g. 20 mg by mouth daily" required {...form.getInputProps('dose')} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Started" type="date" {...form.getInputProps('start')} />
            <Select label="Source" data={[{ value: 'patient', label: 'Patient-reported' }, { value: 'practice', label: 'Recorded by practice' }]} {...form.getInputProps('source')} />
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit">Add medication</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function StopMedicationModal({ med, onClose, onSaved }: { readonly med: MedicationStatement; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [reason, setReason] = useState('');
  const stop = async (): Promise<void> => {
    try {
      await medplum.updateResource<MedicationStatement>({
        ...med,
        status: 'stopped',
        effectivePeriod: { ...med.effectivePeriod, end: new Date().toISOString().slice(0, 10) },
        statusReason: reason.trim() ? [{ text: reason.trim() }] : undefined,
      });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    }
  };
  return (
    <Modal opened onClose={onClose} title={`Stop ${medName(med)}`} centered>
      <Stack>
        <Textarea label="Reason" placeholder="e.g. side effects, ineffective, patient preference" value={reason} onChange={(e) => setReason(e.currentTarget.value)} autosize />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="orange" onClick={stop}>Stop medication</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function AddAllergyModal({ existing, onClose, onSaved }: { readonly existing: AllergyIntolerance[]; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [error, setError] = useState<string>();
  const form = useForm({
    initialValues: { substance: '', reaction: '', severity: 'moderate', category: 'medication' },
    validate: { substance: (v) => (v.trim() ? null : 'Required') },
  });
  const save = async (v: typeof form.values): Promise<void> => {
    try {
      await medplum.createResource<AllergyIntolerance>({
        resourceType: 'AllergyIntolerance',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'unconfirmed' }] },
        category: [v.category as 'medication'],
        code: { text: v.substance.trim() },
        patient: createReference(patient),
        reaction: [{ manifestation: [{ text: v.reaction.trim() || 'Not specified' }], severity: v.severity as 'moderate' }],
        recordedDate: new Date().toISOString(),
      });
      // A real allergy supersedes an earlier "no known allergies" entry.
      for (const nka of existing.filter((a) => a.code?.coding?.some((c) => c.code === NKA_CODE))) {
        await medplum.updateResource({ ...nka, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'inactive' }] } });
      }
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened onClose={onClose} title="Add allergy or intolerance" centered>
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <TextInput label="Substance" required placeholder="e.g. Penicillin" {...form.getInputProps('substance')} />
          <TextInput label="Reaction" placeholder="e.g. Hives" {...form.getInputProps('reaction')} />
          <SimpleGrid cols={2}>
            <Select label="Severity" data={['mild', 'moderate', 'severe']} {...form.getInputProps('severity')} />
            <Select label="Type" data={[{ value: 'medication', label: 'Medication' }, { value: 'food', label: 'Food' }, { value: 'environment', label: 'Environment' }]} {...form.getInputProps('category')} />
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit">Add</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
