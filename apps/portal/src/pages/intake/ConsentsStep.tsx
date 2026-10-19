import { Alert, Badge, Button, Card, Checkbox, Group, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import type { ConsentDocument } from '@teleemon/core';
import { requiredPortalConsents, signedPortalConsent } from '@teleemon/core';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useMe, useSession } from '../../session';
import type { StepProps } from '../IntakePage';

// E-signatures: the server records the document version, a hash of its text, the signer and the time.
export function ConsentsStep({ overview, saved }: StepProps): JSX.Element {
  const consents = overview.intakeState?.consents ?? [];
  // The controlled-substance agreement is required only while the patient takes a controlled medication.
  const required = requiredPortalConsents(!!overview.intakeState?.onControlled);
  const pending = required.filter((d) => !signedPortalConsent(consents, d));
  return (
    <Stack>
      {required.map((doc) => {
        const signed = signedPortalConsent(consents, doc);
        return signed ? (
          <Group key={doc.type} justify="space-between" py={4}>
            <Group gap="xs"><IconCircleCheck size={18} color="var(--mantine-color-green-7)" /><Text>{doc.title}</Text></Group>
            <Badge color="green">Signed {new Date(signed.dateTime ?? '').toLocaleDateString()}</Badge>
          </Group>
        ) : null;
      })}
      {pending[0] ? <SignForm key={pending[0].type} doc={pending[0]} remaining={pending.length} onSigned={() => saved(pending.length === 1)} /> : (
        <Group justify="flex-end"><Button onClick={() => saved()}>Continue</Button></Group>
      )}
    </Stack>
  );
}

function SignForm({ doc, remaining, onSigned }: { readonly doc: ConsentDocument; readonly remaining: number; readonly onSigned: () => void }): JSX.Element {
  const { api } = useSession();
  const me = useMe();
  const [agree, setAgree] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sign = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post('consents', { type: doc.type, version: doc.version, signature, agree });
      onSigned();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between"><Text fw={650}>{doc.title}</Text><Text size="sm" c="dimmed">{remaining} to sign</Text></Group>
        <ScrollArea.Autosize mah={220} type="auto" offsetScrollbars>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{doc.body}</Text>
        </ScrollArea.Autosize>
        <Checkbox checked={agree} onChange={(e) => setAgree(e.currentTarget.checked)} label={me.access === 'self' ? 'I have read this and agree.' : `I have read this and agree on behalf of ${me.patientName}, as their parent or legal guardian.`} />
        <TextInput label="Type your full name to sign" value={signature} onChange={(e) => setSignature(e.currentTarget.value)} autoComplete="name" />
        <Text size="xs" c="dimmed">Version {doc.version}. Your typed name, the date and time and this exact wording are saved with your signature.</Text>
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end"><Button loading={busy} disabled={!agree || signature.trim().length < 2} onClick={() => void sign()}>Sign</Button></Group>
      </Stack>
    </Card>
  );
}
