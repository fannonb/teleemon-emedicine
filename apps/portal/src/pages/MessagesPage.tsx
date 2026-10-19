import { Alert, Badge, Button, Card, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Communication } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconSend } from '@tabler/icons-react';
import { CODE_SYSTEMS, CRISIS_LINES, PORTAL_MESSAGE, PORTAL_REPLY, PORTAL_RULES, communicationCategory, crisisLanguage } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { Empty, Show, useLoader } from '../components/states';
import { useMe, useSession } from '../session';
import { CrisisNow } from './intake/CrisisNow';

const when = (iso?: string): string => (iso ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');

/** When this patient last opened Messages, so a reply that arrived since is flagged as new. */
const SEEN_KEY = 'teleemon.portal.messagesSeen:';

function readSeen(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeSeen(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full store: the badge is a convenience, never a failure.
  }
}

// X05 Secure messages: non-urgent questions to the care team. The server marks possible crisis
// language urgent for staff; the patient sees 988 and 911 straight away.
export function MessagesPage(): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const messages = useLoader(
    () => medplum.searchResources('Communication', { subject: me.patientRef, category: `${CODE_SYSTEMS.communicationCategory}|${PORTAL_MESSAGE},${CODE_SYSTEMS.communicationCategory}|${PORTAL_REPLY}`, _sort: 'sent', _count: '200' }, { cache: 'no-cache' }),
    [medplum, me.patientRef]
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sentUrgent, setSentUrgent] = useState(false);
  const worrying = crisisLanguage(text);

  const seenKey = `${SEEN_KEY}${me.patientRef}`;
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  const flagged = useRef(false);

  // Refresh quietly so a reply appears without a manual reload; the loaded list stays visible while it reloads.
  useEffect(() => {
    const timer = window.setInterval(() => messages.reload(), 30000);
    return () => window.clearInterval(timer);
  }, [messages.reload]);

  // On the first load, mark care-team replies that arrived since the last visit, then record this visit.
  // The guard (not an effect cleanup) keeps this StrictMode-safe; later polls never clear the marks.
  useEffect(() => {
    const list = messages.data;
    if (!list || flagged.current) return;
    flagged.current = true;
    const baseline = readSeen(seenKey);
    setNewIds(new Set(list.filter((m) => m.id && communicationCategory(m) === PORTAL_REPLY && (m.sent ?? '') > baseline).map((m) => m.id as string)));
    writeSeen(seenKey, new Date().toISOString());
  }, [messages.data, seenKey]);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const msg = await medplum.createResource<Communication>({
        resourceType: 'Communication',
        status: 'in-progress',
        category: [{ coding: [{ system: CODE_SYSTEMS.communicationCategory, code: PORTAL_MESSAGE, display: 'Portal message' }] }],
        subject: { reference: me.patientRef },
        sender: { reference: me.actor, display: me.actorName },
        payload: [{ contentString: text.trim() }],
      });
      setSentUrgent(msg.priority === 'urgent');
      setText('');
      notifications.show({ color: 'brand', message: 'Message sent to your care team.' });
      messages.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Messages"
      subtitle="For non-urgent questions. We reply within 2 business days."
      actions={newIds.size > 0 ? <Badge color="brand" variant="filled">{newIds.size} new</Badge> : undefined}
    >
      <Alert color="orange" icon={<IconAlertTriangle size={18} />}>{CRISIS_LINES.notMonitored} {CRISIS_LINES.lifeline}</Alert>
      <Show loaded={messages}>
        {(list) => list.length === 0 ? (
          <Empty title="No messages yet" text="Questions you send and replies from your care team appear here." />
        ) : (
          <Stack gap="sm" aria-live="polite">
            {list.map((m) => {
              const mine = communicationCategory(m) === PORTAL_MESSAGE;
              return (
                <Paper key={m.id} withBorder p="sm" radius="lg" maw="85%" style={{ alignSelf: mine ? 'flex-end' : 'flex-start', background: mine ? 'var(--mantine-color-brand-light)' : 'var(--tm-surface-raised)' }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" c="dimmed">{mine ? (m.sender?.display ?? 'You') : (m.sender?.display ?? 'Care team')} · {when(m.sent)}</Text>
                    {!mine && !!m.id && newIds.has(m.id) && <Badge size="xs" color="brand">New</Badge>}
                  </Group>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{m.payload?.map((p) => p.contentString).join('\n')}</Text>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Show>
      <Card>
        <Stack>
          <Textarea label="New message" placeholder="Write your question for the care team" maxLength={PORTAL_RULES.maxMessageLength} value={text} onChange={(e) => setText(e.currentTarget.value)} minRows={4} />
          {(worrying || sentUrgent) && <CrisisNow />}
          {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
          <Group justify="space-between">
            <Text size="xs" c="dimmed" className="tm-num">{text.length}/{PORTAL_RULES.maxMessageLength}</Text>
            <Button leftSection={<IconSend size={16} />} loading={busy} disabled={!text.trim()} onClick={() => void send()}>Send</Button>
          </Group>
        </Stack>
      </Card>
    </Page>
  );
}
