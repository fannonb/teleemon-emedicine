import { Alert, Badge, Button, Card, Checkbox, Grid, Group, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { Communication, Patient, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconDeviceFloppy, IconMessage } from '@tabler/icons-react';
import type { MessagingSettings } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, MERGE_FIELDS, readSettings, renderReminder, templateProblems, writeSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { patientName } from '../../fhir/patient';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';

const SAMPLE = { firstName: 'Maya', start: new Date(Date.now() + 26 * 3600000).toISOString(), timeZone: 'America/New_York', practicePhone: '' };

/** SMS segments: 160 GSM characters, or 153 per part when split. */
function segments(text: string): number {
  return text.length <= 160 ? 1 : Math.ceil(text.length / 153);
}

// P42 Messaging and reminders.
export function MessagingPage(): JSX.Element {
  const medplum = useMedplum();
  const settings = useLoader(() => readSettings(medplum, 'messaging'), [medplum]);
  return (
    <PageBody>
      <PageHeader eyebrow="P42 · Settings" title="Messaging and reminders" subtitle="Reminders never contain clinical details. Quiet hours and opt-outs are enforced by the worker immediately before each send." />
      <Section loaded={settings}>{(s) => <MessagingForm initial={s} onSaved={settings.reload} />}</Section>
      <RecentMessages />
    </PageBody>
  );
}

function MessagingForm({ initial, onSaved }: { readonly initial: MessagingSettings; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [s, setS] = useState<MessagingSettings>(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(initial), [initial]);
  const problems = [...templateProblems(s.smsTemplate).map((p) => `Text message: ${p}`), ...templateProblems(s.emailTemplate).map((p) => `Email: ${p}`), ...templateProblems(s.emailSubject).map((p) => `Email subject: ${p}`)];
  const preview = (t: string): string => renderReminder(t, { ...SAMPLE, practicePhone: s.practicePhone });

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await writeSettings(medplum, 'messaging', s);
      notifications.show({ color: 'brand', message: 'Reminder settings saved. They apply from the worker’s next run.' });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="lg">
          <Card>
            <Title order={2} mb="sm">
              When reminders go out
            </Title>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Before the visit</Table.Th>
                  <Table.Th ta="center">Text</Table.Th>
                  <Table.Th ta="center">Email</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {s.offsets.map((o, i) => (
                  <Table.Tr key={o.hours}>
                    <Table.Td className="tm-num">{o.hours} hours</Table.Td>
                    {(['sms', 'email'] as const).map((ch) => (
                      <Table.Td key={ch} ta="center">
                        <Checkbox
                          style={{ display: 'inline-block' }}
                          checked={o[ch]}
                          aria-label={`${ch} at ${o.hours} hours`}
                          onChange={(e) => {
                            const offsets = s.offsets.map((x, j) => (j === i ? { ...x, [ch]: e.currentTarget.checked } : x));
                            setS({ ...s, offsets });
                          }}
                        />
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed" mt="xs">
              Only the nearest reminder is sent: a visit booked 20 hours ahead gets the 2-hour reminder, not a late 24-hour one.
            </Text>
          </Card>
          <Card>
            <Title order={2} mb="sm">
              Quiet hours (patient's local time)
            </Title>
            <Group grow>
              <TextInput label="From" type="time" value={s.quietStart} onChange={(e) => setS({ ...s, quietStart: e.currentTarget.value })} />
              <TextInput label="Until" type="time" value={s.quietEnd} onChange={(e) => setS({ ...s, quietEnd: e.currentTarget.value })} />
            </Group>
            <TextInput mt="sm" label="Practice phone in messages" value={s.practicePhone} onChange={(e) => setS({ ...s, practicePhone: e.currentTarget.value })} />
          </Card>
          <Alert variant="light" color="blue" title="Delivery">
            Messages are recorded by the worker's log transport until an SMS vendor is chosen and its BAA signed (decision D7). Setting <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> and <code>TWILIO_FROM</code> switches texts to Twilio with no code change. Replies STOP, START, HELP and C (confirm) are handled automatically; 10DLC registration is required before go-live.
          </Alert>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <Card>
          <Group justify="space-between" mb="sm">
            <Title order={2}>Message text</Title>
            <Button leftSection={<IconDeviceFloppy size={16} />} loading={saving} disabled={problems.length > 0} onClick={save}>
              Save settings
            </Button>
          </Group>
          {problems.length > 0 && (
            <Alert color="red" mb="sm">
              {problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
            </Alert>
          )}
          <Text size="xs" c="dimmed" mb="sm">
            Merge fields: {MERGE_FIELDS.join(' ')}
          </Text>
          <Stack gap="md">
            <div>
              <Textarea label="Text message" autosize minRows={3} value={s.smsTemplate} onChange={(e) => setS({ ...s, smsTemplate: e.currentTarget.value })} />
              <Group justify="space-between" mt={4}>
                <Text size="xs" c="dimmed">
                  Preview: {preview(s.smsTemplate)}
                </Text>
                <Badge size="xs" variant="light" color={segments(preview(s.smsTemplate)) > 2 ? 'orange' : 'gray'}>
                  {preview(s.smsTemplate).length} chars · {segments(preview(s.smsTemplate))} segment{segments(preview(s.smsTemplate)) > 1 ? 's' : ''}
                </Badge>
              </Group>
            </div>
            <TextInput label="Email subject" value={s.emailSubject} onChange={(e) => setS({ ...s, emailSubject: e.currentTarget.value })} />
            <Textarea label="Email" autosize minRows={6} value={s.emailTemplate} onChange={(e) => setS({ ...s, emailTemplate: e.currentTarget.value })} />
            <Card withBorder padding="sm" bg="var(--tm-surface)">
              <Text size="xs" c="dimmed" mb={4}>
                Email preview (sample patient in Rhode Island)
              </Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {preview(s.emailTemplate)}
              </Text>
            </Card>
          </Stack>
        </Card>
      </Grid.Col>
    </Grid>
  );
}

function RecentMessages(): JSX.Element {
  const medplum = useMedplum();
  const data = useLoader(async () => {
    const bundle = await medplum.search('Communication', { category: `${CODE_SYSTEMS.communicationCategory}|reminder`, _sort: '-_lastUpdated', _count: '40', _include: 'Communication:subject' }, { cache: 'no-cache' });
    const patients = new Map<string, Patient>();
    const msgs: Communication[] = [];
    for (const e of bundle.entry ?? []) {
      const r = e.resource as Resource | undefined;
      if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
      if (r?.resourceType === 'Communication') msgs.push(r);
    }
    return { msgs, patients };
  }, [medplum], 30000);
  const STATUS: Record<string, { label: string; color: string }> = {
    preparation: { label: 'Queued', color: 'gray' },
    completed: { label: 'Sent', color: 'green' },
    'not-done': { label: 'Not sent', color: 'orange' },
  };
  return (
    <div style={{ marginTop: 'var(--mantine-spacing-lg)' }}>
      <Section title="Recent reminders" loaded={data} isEmpty={(d) => d.msgs.length === 0} empty={{ icon: <IconMessage size={22} />, title: 'No reminders yet', text: 'Start the worker (`npm run worker`) to queue and send reminders.' }}>
        {({ msgs, patients }) => (
          <Table.ScrollContainer minWidth={720}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Queued</Table.Th>
                  <Table.Th>Patient</Table.Th>
                  <Table.Th>Channel</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Detail</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {msgs.map((m) => {
                  const st = STATUS[m.status] ?? { label: m.status, color: 'gray' };
                  return (
                    <Table.Tr key={m.id}>
                      <Table.Td className="tm-num">
                        {formatDate(m.meta?.lastUpdated?.slice(0, 10))} {formatTime(m.meta?.lastUpdated)}
                      </Table.Td>
                      <Table.Td>{patientName(patients.get(m.subject?.reference ?? ''))}</Table.Td>
                      <Table.Td>{getExtensionValue(m, EXT.channel) === 'sms' ? 'Text' : 'Email'}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={st.color}>
                          {st.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {m.statusReason?.text ?? m.note?.[0]?.text ?? (m.status === 'preparation' ? 'Waiting for the next worker run or the end of quiet hours' : '')}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Section>
    </div>
  );
}
