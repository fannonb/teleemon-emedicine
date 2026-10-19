import { Alert, Badge, Button, Card, Grid, Group, Modal, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Consent, Reference, RelatedPerson } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconFileCertificate, IconPlus } from '@tabler/icons-react';
import type { ConsentTypeCode } from '@teleemon/core';
import { CODE_SYSTEMS, CONSENT_TYPES, EXT, findConsentDocument } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { consentIsCurrent, consentStatus, consentType, loadMeds, medSchedule } from '../../fhir/clinical';
import { patientIsMinor, patientName } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { useChart } from './ChartContext';

const METHODS = [
  { value: 'portal-esignature', label: 'Portal e-signature' },
  { value: 'in-person', label: 'Signed in person' },
  { value: 'paper-scan', label: 'Paper form (scanned)' },
  { value: 'verbal-recorded', label: 'Verbal, on recording' },
];

// P12 Consents and privacy.
export function ConsentsTab(): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [recording, setRecording] = useState<ConsentTypeCode | undefined>();
  const [revoking, setRevoking] = useState<Consent | undefined>();

  const data = useLoader(async () => {
    const [consents, related, meds] = await Promise.all([
      medplum.searchResources('Consent', { patient: `Patient/${patient.id}`, _count: '200', _sort: '-date' }, { cache: 'no-cache' }),
      medplum.searchResources('RelatedPerson', { patient: `Patient/${patient.id}` }, { cache: 'no-cache' }).catch(() => [] as RelatedPerson[]),
      loadMeds(medplum, patient).catch(() => []),
    ]);
    return { consents, related, onControlled: meds.some((m) => medSchedule(m)) };
  }, [patient.id]);

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 8 }}>
        <Stack gap="lg">
          <Section title="Standing consents" loaded={data}>
            {({ consents, onControlled }) => (
              <Table.ScrollContainer minWidth={620}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Consent</Table.Th>
                    <Table.Th w={100}>Status</Table.Th>
                    <Table.Th w={135}>Signed</Table.Th>
                    <Table.Th w={85} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {consentStatus(consents, onControlled).map((s) => (
                    <Table.Tr key={s.code}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {s.label}
                        </Text>
                        {s.code === 'recording' && (
                          <Text size="xs" c="dimmed">
                            Standing permission to record and use the AI scribe. Each recorded session still needs the patient's verbal consent.
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {s.current ? (
                          <Badge color="green">On file</Badge>
                        ) : s.expired ? (
                          <Badge color="orange">Expired</Badge>
                        ) : s.required ? (
                          <Badge color={s.code === 'recording' ? 'red' : 'orange'}>Missing</Badge>
                        ) : (
                          <Badge color="gray">Not required</Badge>
                        )}
                      </Table.Td>
                      <Table.Td className="tm-num">
                        {s.current ? (
                          <Text size="sm">
                            {formatDate(s.current.dateTime?.slice(0, 10))}
                            {s.current.provision?.period?.end && (
                              <Text span size="xs" c="dimmed">
                                {' '}
                                · expires {formatDate(s.current.provision.period.end)}
                              </Text>
                            )}
                          </Text>
                        ) : (
                          '—'
                        )}
                      </Table.Td>
                      <Table.Td ta="right">
                        {s.current ? (
                          <Button size="xs" variant="subtle" color="red" onClick={() => setRevoking(s.current)}>
                            Revoke
                          </Button>
                        ) : (
                          <Button size="xs" variant="light" onClick={() => setRecording(s.code)}>
                            Record
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              </Table.ScrollContainer>
            )}
          </Section>

          <Section
            title="Release of information and restrictions"
            loaded={data}
            actions={
              <Group gap="xs">
                <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setRecording('roi')}>
                  Release of information
                </Button>
                <Button size="xs" variant="default" onClick={() => setRecording('restriction')}>
                  Restriction request
                </Button>
              </Group>
            }
          >
            {({ consents }) => {
              const list = consents.filter((c) => ['roi', 'restriction'].includes(consentType(c) ?? ''));
              return list.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No releases or restriction requests recorded.
                </Text>
              ) : (
                <Stack gap="xs">
                  {list.map((c) => (
                    <Group key={c.id} justify="space-between">
                      <div>
                        <Text size="sm" fw={500}>
                          {c.category?.[0]?.coding?.[0]?.display}
                          {c.provision?.actor?.[0]?.reference?.display ? ` → ${c.provision.actor[0].reference.display}` : ''}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {c.policyRule?.text} · {formatDate(c.dateTime?.slice(0, 10))}
                        </Text>
                      </div>
                      <Group gap="xs">
                        <Badge color={consentIsCurrent(c) ? 'green' : 'gray'}>{consentIsCurrent(c) ? 'Active' : c.status}</Badge>
                        {consentIsCurrent(c) && <Button size="xs" variant="subtle" color="red" onClick={() => setRevoking(c)}>Revoke</Button>}
                      </Group>
                    </Group>
                  ))}
                </Stack>
              );
            }}
          </Section>
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, lg: 4 }}>
        <Stack gap="lg">
          <Card>
            <Title order={3} mb="xs">
              42 CFR Part 2
            </Title>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Text size="sm" c="dimmed">
                Not enabled. Record segmentation and disclosure enforcement require further implementation and verification after the practice decides whether Part 2 applies (decision D2).
              </Text>
              <Tooltip label="Turned on by an administrator after legal review">
                <Switch checked={false} disabled aria-label="Part 2 segmentation" />
              </Tooltip>
            </Group>
          </Card>
          {patientIsMinor(patient) && (
            <Card>
              <Title order={3} mb="xs">
                Minor confidentiality
              </Title>
              <Text size="sm" c="dimmed">
                This patient is under 18. Which records a parent or guardian can see in the portal depends on the patient's age and state, and is applied automatically from Phase 7.
              </Text>
            </Card>
          )}
          <Section title="History" loaded={data}>
            {({ consents }) => (
              <Stack gap={6}>
                {consents.flatMap((c) => [
                  { key: `${c.id}-signed`, date: c.dateTime, title: c.category?.[0]?.coding?.[0]?.display, label: 'Signed', color: 'green.7' },
                  ...(c.status === 'inactive' ? [{ key: `${c.id}-revoked`, date: c.extension?.find((e) => e.url === EXT.revokedAt)?.valueDateTime ?? c.meta?.lastUpdated, title: c.category?.[0]?.coding?.[0]?.display, label: 'Revoked', color: 'dimmed' }] : []),
                ]).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 20).map((entry) => (
                  <Text key={entry.key} size="xs" className="tm-num">
                    {formatDate(entry.date)} · {entry.title} · <Text span c={entry.color}>{entry.label}</Text>
                  </Text>
                ))}
              </Stack>
            )}
          </Section>
        </Stack>
      </Grid.Col>

      {recording && data.data && (
        <RecordConsentModal
          type={recording}
          related={data.data.related}
          onClose={() => setRecording(undefined)}
          onSaved={() => {
            setRecording(undefined);
            data.reload();
          }}
        />
      )}
      {revoking && (
        <RevokeModal
          consent={revoking}
          onClose={() => setRevoking(undefined)}
          onSaved={() => {
            setRevoking(undefined);
            data.reload();
          }}
        />
      )}
    </Grid>
  );
}

interface ConsentForm {
  signer: string;
  method: string;
  date: string;
  expires: string;
  recipient: string;
  note: string;
}

function RecordConsentModal({ type, related, onClose, onSaved }: { readonly type: ConsentTypeCode; readonly related: RelatedPerson[]; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const { patient } = useChart();
  const [error, setError] = useState<string>();
  const def = CONSENT_TYPES.find((t) => t.code === type);
  const minor = patientIsMinor(patient);
  const signers = [
    { value: `Patient/${patient.id}`, label: `${patientName(patient)} (patient)` },
    ...related.map((r) => ({ value: `RelatedPerson/${r.id}`, label: `${[r.name?.[0]?.given?.join(' '), r.name?.[0]?.family].join(' ')} (${r.relationship?.[0]?.coding?.[0]?.display ?? 'related'})` })),
  ];
  const form = useForm<ConsentForm>({
    initialValues: { signer: minor && related[0] ? `RelatedPerson/${related[0].id}` : `Patient/${patient.id}`, method: 'in-person', date: new Date().toISOString().slice(0, 10), expires: '', recipient: '', note: '' },
    validate: {
      date: (v) => (v ? null : 'Required'),
      recipient: (v) => (type === 'roi' && !v.trim() ? 'Who may receive the information?' : null),
      note: (v) => (type === 'restriction' && !v.trim() ? 'Describe the restriction requested' : null),
      signer: (v) => (minor && v.startsWith('Patient/') && type === 'treatment' ? 'A guardian must sign consent to treatment for a minor (check your state rules)' : null),
    },
  });

  // The same document the portal shows, so a consent signed on paper or verbally records which
  // wording it was, exactly as an e-signature does (version and SHA-256 of the text).
  const doc = findConsentDocument(type);
  const save = async (v: ConsentForm): Promise<void> => {
    const signer = signers.find((s) => s.value === v.signer);
    try {
      const hash = doc ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(doc.body)))].map((b) => b.toString(16).padStart(2, '0')).join('') : undefined;
      await medplum.createResource<Consent>({
        resourceType: 'Consent',
        status: 'active',
        scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: type === 'privacy-notice' || type === 'roi' || type === 'restriction' ? 'patient-privacy' : 'treatment' }] },
        category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: type, display: def?.display }] }],
        patient: createReference(patient),
        dateTime: new Date(`${v.date}T12:00:00`).toISOString(),
        performer: [{ reference: v.signer, display: signer?.label } as Reference<never>],
        policyRule: { text: type === 'restriction' ? v.note.trim() : doc ? `Teleemon ${doc.title}, ${doc.version}` : `Teleemon ${def?.display}, version 2026.1` },
        provision: {
          type: type === 'restriction' ? 'deny' : 'permit',
          period: { start: v.date, end: v.expires || undefined },
          actor: type === 'roi' ? [{ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP', display: 'information recipient' }] }, reference: { display: v.recipient.trim() } }] : undefined,
        },
        extension: [
          { url: EXT.consentMethod, valueCode: v.method },
          ...(doc && hash ? [{ url: EXT.consentDocument, valueString: doc.version }, { url: EXT.consentTextHash, valueString: hash }] : []),
        ],
      });
      notifications.show({ color: 'brand', message: `${def?.display} recorded.` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };

  return (
    <Modal opened onClose={onClose} title={<Group gap={8}><IconFileCertificate size={18} />{def?.display}</Group>} centered size="lg">
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select label="Signed by" data={signers} {...form.getInputProps('signer')} />
            <Select label="How it was captured" data={METHODS} {...form.getInputProps('method')} />
            <TextInput label="Date signed" type="date" required {...form.getInputProps('date')} />
            <TextInput label="Expires" type="date" description="Leave blank if it does not expire" {...form.getInputProps('expires')} />
          </SimpleGrid>
          {type === 'roi' && <TextInput label="Recipient" placeholder="e.g. Dr. A. Rivera, primary care" required {...form.getInputProps('recipient')} />}
          {type === 'restriction' && <Textarea label="Restriction requested" placeholder="e.g. Do not bill insurance for visits paid in full out of pocket" required {...form.getInputProps('note')} />}
          <Text size="xs" c="dimmed">
            Patients sign electronically in the portal; this records a consent captured another way.{doc ? ` The patient must have seen the current wording (${doc.version}), which is recorded with the consent.` : ''}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Record consent</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RevokeModal({ consent, onClose, onSaved }: { readonly consent: Consent; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const revoke = async (): Promise<void> => {
    if (reason.trim().length < 3) {
      setError('Add the reason the consent was withdrawn.');
      return;
    }
    try {
      // Revocation takes effect immediately. The earlier version stays in the resource history.
      await medplum.updateResource<Consent>({
        ...consent,
        status: 'inactive',
        provision: { ...consent.provision, period: { ...consent.provision?.period, end: new Date().toISOString().slice(0, 10) } },
        extension: [...(consent.extension ?? []), { url: EXT.revocationReason, valueString: reason.trim() }, { url: EXT.revokedAt, valueDateTime: new Date().toISOString() }],
      });
      notifications.show({ color: 'orange', message: 'Consent revoked.' });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  };
  return (
    <Modal opened onClose={onClose} title="Revoke consent" centered>
      <Stack>
        <Text size="sm">
          Revoking <b>{consent.category?.[0]?.coding?.[0]?.display}</b> takes effect immediately and is recorded in the history.
        </Text>
        <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)} required autosize minRows={2} />
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" onClick={revoke}>
            Revoke
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
