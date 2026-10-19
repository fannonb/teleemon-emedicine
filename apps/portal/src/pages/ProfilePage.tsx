import { Alert, Badge, Button, Card, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Patient, RelatedPerson } from '@medplum/fhirtypes';
import { IconAlertTriangle } from '@tabler/icons-react';
import { EXT, sexAtBirth } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { Show, useLoader } from '../components/states';
import { loadPatient } from '../data';
import { useMe, useSession } from '../session';
import { ContactFields, applyContact, editableContact } from './intake/AboutStep';
import { CardOnFile } from './intake/PaymentStep';

// X09 Profile and proxies. Contact details are self-service (the Patient Bot refuses changes to
// anything else); name, date of birth and guardians are changed by the care team.
export function ProfilePage(): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const data = useLoader(async () => ({
    patient: await loadPatient(medplum, me),
    proxies: await medplum.searchResources('RelatedPerson', me.access === 'limited' ? { _id: me.actor.split('/')[1] } : { patient: me.patientRef }, { cache: 'no-cache' }).catch(() => [] as RelatedPerson[]),
  }), [medplum, me.patientRef]);
  return (
    <Page title="Profile">
      <Show loaded={data}>
        {(d) => (
          <Stack gap="lg">
            {me.access === 'limited' ? (
              <Card><Text>{me.patientName}'s contact details are managed by {me.patientName} and the care team. Call us to change your own phone number or email.</Text></Card>
            ) : (
              <Contact patient={d.patient} onSaved={data.reload} />
            )}
            {me.access !== 'limited' && (
              <Card>
                <Stack gap="sm">
                  <Title order={2}>Payment card</Title>
                  <Text size="sm" c="dimmed">Used for copays and balances you choose to pay in Billing &amp; payments.</Text>
                  <CardOnFile />
                </Stack>
              </Card>
            )}
            <Card>
              <Stack gap="sm">
                <Title order={2}>Parents, guardians and proxies</Title>
                {d.proxies.length === 0 ? <Text size="sm" c="dimmed">Nobody else is linked to this record.</Text> : d.proxies.map((p) => (
                  <Group key={p.id} justify="space-between">
                    <Text>{[p.name?.[0]?.given?.[0], p.name?.[0]?.family].filter(Boolean).join(' ')}</Text>
                    <Badge color="gray">{p.relationship?.[0]?.text ?? p.relationship?.[0]?.coding?.[0]?.display ?? 'Related person'}</Badge>
                  </Group>
                ))}
                <Text size="xs" c="dimmed">Parents and guardians of patients under 18 can be invited to the portal by the care team. What they can see depends on the patient's age and state law. Call us to add or remove someone.</Text>
              </Stack>
            </Card>
          </Stack>
        )}
      </Show>
    </Page>
  );
}

function Contact({ patient, onSaved }: { readonly patient: Patient; readonly onSaved: () => void }): JSX.Element {
  const { medplum } = useSession();
  const [value, setValue] = useState(() => editableContact(patient));
  const [sms, setSms] = useState(!patient.extension?.some((e) => e.url === EXT.contactOptOut && e.valueCode === 'sms'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const email = patient.telecom?.find((t) => t.system === 'email')?.value;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const current = await medplum.readResource('Patient', patient.id as string, { cache: 'no-cache' });
      const updated = applyContact(current, value);
      const extension = (updated.extension ?? []).filter((e) => !(e.url === EXT.contactOptOut && e.valueCode === 'sms'));
      if (!sms) extension.push({ url: EXT.contactOptOut, valueCode: 'sms' });
      await medplum.updateResource({ ...updated, extension: extension.length ? extension : undefined });
      notifications.show({ color: 'brand', message: 'Profile saved.' });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Stack>
        <Title order={2}>Contact details</Title>
        <Text size="sm" c="dimmed">{patient.name?.[0]?.given?.join(' ')} {patient.name?.[0]?.family} · born {patient.birthDate} · sign-in email {email}. Send us a message to change these.</Text>
        <ContactFields value={value} onChange={setValue} sexLocked={!!sexAtBirth(patient)} />
        <Switch checked={sms} onChange={(e) => setSms(e.currentTarget.checked)} label="Text me appointment reminders" description="Texts never include health details. You can also reply STOP." />
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end"><Button loading={busy} onClick={() => void save()}>Save</Button></Group>
      </Stack>
    </Card>
  );
}
