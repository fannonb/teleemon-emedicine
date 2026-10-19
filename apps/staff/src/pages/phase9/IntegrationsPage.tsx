import { Alert, Button, Card, Grid, Group, Modal, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference } from '@medplum/core';
import type { DocumentReference, Reference } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconActivity, IconFileCheck, IconPlugConnected } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { complianceEvidenceLabel, loadComplianceCheckpoints, saveComplianceAttestation } from '../../operations/compliance';
import type { ComplianceCheckpoint } from '../../operations/compliance';
import { loadIntegrationHealth } from '../../operations/integrations';
import { useLoader } from '../../hooks/useLoader';
import { useRoles } from '../../session/roles';
import { formatDate } from '../../utils/format';
import { formatTimestamp, StatusBadge } from './phase9Format';

function signalNote(signal: { state: string; lastOutcome?: string; lastSignalAt?: string }): string {
  if (signal.state === 'available') return `Last recorded success ${formatTimestamp(signal.lastSignalAt)}`;
  if (signal.state === 'unavailable') return `Last recorded failure ${formatTimestamp(signal.lastSignalAt)}`;
  if (signal.state === 'not-configured') return 'No configured signal is recorded';
  return 'No recent health signal is available';
}

export function IntegrationsPage(): JSX.Element {
  const medplum = useMedplum();
  const { roles } = useRoles();
  const allowed = roles.includes('admin');
  const data = useLoader(async () => {
    if (!allowed) return { integrations: [], checkpoints: [] };
    const [integrations, checkpoints] = await Promise.all([loadIntegrationHealth(medplum), loadComplianceCheckpoints(medplum)]);
    return { integrations, checkpoints };
  }, [medplum, allowed], 60000);
  const [selected, setSelected] = useState<ComplianceCheckpoint>();
  const [vendor, setVendor] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [executedOn, setExecutedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const counts = useMemo(() => {
    const list = data.data?.integrations ?? [];
    return {
      available: list.filter((item) => item.state === 'available').length,
      unavailable: list.filter((item) => item.state === 'unavailable').length,
      unknown: list.filter((item) => item.state === 'unknown').length,
      notConfigured: list.filter((item) => item.state === 'not-configured').length,
    };
  }, [data.data]);

  const openAttestation = (checkpoint: ComplianceCheckpoint): void => {
    setSelected(checkpoint);
    setVendor(checkpoint.vendor ?? '');
    setDocumentId('');
    setExecutedOn(checkpoint.executedOn ?? '');
    setExpiresOn(checkpoint.expiresOn ?? '');
    setNote('');
    setSaveError('');
  };

  const profile = useMedplumProfile();
  const save = async (): Promise<void> => {
    if (!selected || saving) return;
    if (profile?.resourceType !== 'Practitioner') {
      setSaveError('Only a signed-in administrator can record an attestation.');
      return;
    }
    const cleanId = documentId.trim().replace(/^DocumentReference\//, '');
    if (!cleanId) {
      setSaveError('Enter the ID of an existing DocumentReference that contains the evidence.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await saveComplianceAttestation(medplum, {
        checkpoint: selected.key.startsWith('baa-agreement') ? 'baa-agreement' : selected.key,
        title: selected.title,
        evidence: { reference: `DocumentReference/${cleanId}` } as Reference<DocumentReference>,
        recordedBy: createReference(profile),
        ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
        ...(executedOn ? { executedOn } : {}),
        ...(expiresOn ? { expiresOn } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      notifications.show({ color: 'brand', message: 'Attestation recorded. The evidence has not been independently verified.' });
      setSelected(undefined);
      data.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'The attestation could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageBody wide>
      <PageHeader eyebrow="P44 · Insight & admin" title="Integrations & compliance" subtitle="Review recorded system signals and the evidence the practice has documented." actions={<Button variant="default" onClick={data.reload} loading={data.loading}>Refresh</Button>} />
      {!allowed ? <Alert color="red" variant="light" title="Administrator access required">Integration configuration and compliance evidence are limited to administrators.</Alert> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : data.loading && !data.data ? <Card><RowsSkeleton rows={8} /></Card> : data.data ? (
        <Stack gap="lg">
          <Alert color="blue" variant="light" icon={<IconActivity size={17} />} title="Recorded health, not a live connection test">
            Integration status comes from recent health events stored in Teleemon. Unknown or stale signals stay unknown. No credentials are displayed, and this screen does not test vendor endpoints.
          </Alert>
          <Grid gutter="md">
            {[
              { label: 'Available', value: counts.available, color: 'green' },
              { label: 'Unavailable', value: counts.unavailable, color: 'red' },
              { label: 'Unknown', value: counts.unknown, color: 'gray' },
              { label: 'Not configured', value: counts.notConfigured, color: 'gray' },
            ].map((item) => <Grid.Col key={item.label} span={{ base: 6, sm: 3 }}><Card padding="md"><Text size="xs" c="dimmed">{item.label}</Text><Text size="xl" fw={700} c={`${item.color}.7`} className="tm-num">{item.value}</Text></Card></Grid.Col>)}
          </Grid>
          <Card>
            <Group justify="space-between" mb="md"><div><Title order={2}>Connected services</Title><Text size="sm" c="dimmed" mt={3}>Health records are metadata only; a configured service is not proof of a successful connection.</Text></div><IconPlugConnected size={20} /></Group>
            {!data.data.integrations.length ? <EmptyState icon={<IconPlugConnected size={20} />} title="No integrations are listed">Health events will appear here when recorded.</EmptyState> : (
              <Grid gutter="sm">{data.data.integrations.map((item) => <Grid.Col key={item.key} span={{ base: 12, md: 6 }}>
                <Card withBorder padding="md" h="100%">
                  <Group justify="space-between" align="flex-start"><div><Text fw={650}>{item.label}</Text><Text size="xs" c="dimmed" mt={4}>{signalNote(item)}</Text></div><StatusBadge status={item.state} /></Group>
                </Card>
              </Grid.Col>)}</Grid>
            )}
          </Card>
          <Card>
            <Group justify="space-between" align="flex-start" mb="md"><div><Title order={2}>Compliance evidence</Title><Text size="sm" c="dimmed" mt={3}>Attestations are staff-reported records and do not establish legal sufficiency or independent verification.</Text></div><IconFileCheck size={20} /></Group>
            <Table.ScrollContainer minWidth={760}>
              <Table striped highlightOnHover verticalSpacing="sm">
                <Table.Thead><Table.Tr><Table.Th>Checkpoint</Table.Th><Table.Th>Evidence status</Table.Th><Table.Th>Vendor / date</Table.Th><Table.Th>Evidence record</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                <Table.Tbody>{data.data.checkpoints.map((checkpoint) => <Table.Tr key={checkpoint.key}>
                  <Table.Td><Text fw={600}>{checkpoint.title}</Text></Table.Td>
                  <Table.Td><StatusBadge status={checkpoint.status} label={complianceEvidenceLabel(checkpoint)} /></Table.Td>
                  <Table.Td><Text size="sm">{checkpoint.vendor || '—'}</Text><Text size="xs" c="dimmed">{checkpoint.executedOn ? `Executed ${formatDate(checkpoint.executedOn)}` : 'Date not recorded'}{checkpoint.expiresOn ? ` · Expires ${formatDate(checkpoint.expiresOn)}` : ''}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{checkpoint.evidence?.kind === 'attestation' ? checkpoint.evidence.evidence?.reference ?? 'Linked evidence' : checkpoint.evidence?.kind === 'observed' ? checkpoint.evidence.source.reference : 'No evidence linked'}</Text></Table.Td>
                  <Table.Td ta="right">{checkpoint.status !== 'observed' && <Button size="xs" variant="subtle" onClick={() => openAttestation(checkpoint)}>Record attestation</Button>}</Table.Td>
                </Table.Tr>)}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        </Stack>
      ) : null}
      <Modal opened={!!selected} onClose={() => !saving && setSelected(undefined)} title="Record staff attestation" centered>
        {selected && <Stack>
          <Alert color="orange" variant="light" title="Not independently verified">This records an attestation and document reference only. It does not validate the document's contents or establish that the agreement is legally sufficient.</Alert>
          <Text fw={600}>{selected.title}</Text>
          {selected.key === 'baa-agreement' && <TextInput required label="Vendor" placeholder="Company named on the agreement" value={vendor} onChange={(event) => setVendor(event.currentTarget.value)} />}
          <TextInput required label="Evidence DocumentReference ID" description="Use an existing current document in the clinical record. Paste the ID, with or without DocumentReference/." placeholder="Document ID" value={documentId} onChange={(event) => setDocumentId(event.currentTarget.value)} />
          <Grid gutter="sm">
            <Grid.Col span={{ base: 12, sm: 6 }}><TextInput type="date" label={selected.key === 'baa-agreement' ? 'Agreement executed' : 'Completed on'} required={selected.key === 'baa-agreement'} value={executedOn} onChange={(event) => setExecutedOn(event.currentTarget.value)} /></Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}><TextInput type="date" label="Expires (optional)" value={expiresOn} onChange={(event) => setExpiresOn(event.currentTarget.value)} /></Grid.Col>
          </Grid>
          <Textarea label="Staff note (optional)" maxLength={500} value={note} onChange={(event) => setNote(event.currentTarget.value)} />
          {saveError && <Alert color="red" variant="light">{saveError}</Alert>}
          <Group justify="flex-end"><Button variant="default" onClick={() => setSelected(undefined)} disabled={saving}>Cancel</Button><Button onClick={() => void save()} loading={saving}>Save attestation</Button></Group>
        </Stack>}
      </Modal>
    </PageBody>
  );
}
