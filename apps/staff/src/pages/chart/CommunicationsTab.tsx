import { Alert, Badge, Button, Card, Group, SegmentedControl, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconLock, IconMessage, IconSend } from '@tabler/icons-react';
import { CODE_SYSTEMS } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { optedOut } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';
import { useChart } from './ChartContext';

const INTERNAL = { system: CODE_SYSTEMS.communicationCategory, code: 'internal-note', display: 'Internal staff note' };

function isInternal(c: Communication): boolean {
  return c.category?.some((x) => x.coding?.some((y) => y.code === INTERNAL.code)) ?? false;
}

// P20 Communications.
export function CommunicationsTab(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { patient } = useChart();
  const [mode, setMode] = useState<'internal' | 'message'>('internal');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const optOut = optedOut(patient);
  const thread = useLoader(() => medplum.searchResources('Communication', { subject: `Patient/${patient.id}`, _sort: 'sent', _count: '200' }, { cache: 'no-cache' }), [patient.id]);

  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: mode === 'internal' ? 'completed' : 'preparation',
        category: mode === 'internal' ? [{ coding: [INTERNAL] }] : undefined,
        subject: createReference(patient),
        sender: profile ? createReference(profile) : undefined,
        recipient: mode === 'message' ? [createReference(patient)] : undefined,
        sent: new Date().toISOString(),
        payload: [{ contentString: text.trim() }],
      });
      setText('');
      thread.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Stack gap="lg">
      {optOut.length > 0 && (
        <Alert color="orange" variant="light" title="Contact preferences">
          Opted out of {optOut.map((o) => (o === 'sms' ? 'text messages' : o === 'voice' ? 'voice calls' : 'email')).join(' and ')}. The messaging service will refuse to send on {optOut.length > 1 ? 'these channels' : 'this channel'} (Phase 2).
        </Alert>
      )}
      <Section title="Messages and notes" loaded={thread} isEmpty={(l) => l.length === 0} empty={{ icon: <IconMessage size={22} />, title: 'No messages yet', text: 'Secure messages, texts, emails, call notes and internal staff notes appear here in order.' }}>
        {(list) => (
          <Stack gap="sm">
            {list.map((c) => {
              const fromPatient = c.sender?.reference?.startsWith('Patient/');
              const internal = isInternal(c);
              return (
                <Card
                  key={c.id}
                  padding="sm"
                  withBorder
                  style={{
                    maxWidth: '80%',
                    alignSelf: fromPatient ? 'flex-start' : 'flex-end',
                    background: internal ? 'var(--mantine-color-yellow-light)' : fromPatient ? 'var(--tm-surface)' : 'var(--mantine-color-brand-light)',
                  }}
                >
                  <Group gap={6} mb={4}>
                    <Text size="xs" fw={650}>
                      {fromPatient ? 'Patient' : (c.sender?.display ?? 'Practice')}
                    </Text>
                    {internal && (
                      <Badge size="xs" color="yellow" leftSection={<IconLock size={10} />}>
                        Internal: not visible to patient
                      </Badge>
                    )}
                    {c.status === 'preparation' && (
                      <Tooltip label="Delivered through the patient portal">
                        <Badge size="xs" color="gray">
                          Queued
                        </Badge>
                      </Tooltip>
                    )}
                    <Text size="xs" c="dimmed" className="tm-num">
                      {formatDate(c.sent?.slice(0, 10))} {formatTime(c.sent)}
                    </Text>
                  </Group>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {c.payload?.[0]?.contentString}
                  </Text>
                </Card>
              );
            })}
          </Stack>
        )}
      </Section>
      <Card>
        <Group justify="space-between" mb="sm">
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            data={[
              { value: 'internal', label: 'Internal note' },
              { value: 'message', label: 'Secure message to patient' },
            ]}
          />
          <Text size="xs" c="dimmed">
            {mode === 'internal' ? 'Visible to staff only' : 'Notifications never contain message content'}
          </Text>
        </Group>
        <Textarea value={text} onChange={(e) => setText(e.currentTarget.value)} placeholder={mode === 'internal' ? 'Add a note for the care team…' : 'Write a message to the patient…'} autosize minRows={3} />
        <Group justify="flex-end" mt="sm">
          <Button leftSection={<IconSend size={16} />} loading={sending} disabled={!text.trim()} onClick={send}>
            {mode === 'internal' ? 'Add note' : 'Queue message'}
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
