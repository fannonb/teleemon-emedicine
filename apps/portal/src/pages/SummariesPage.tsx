import { Button, Card, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DocumentReference } from '@medplum/fhirtypes';
import { IconDownload, IconFileText } from '@tabler/icons-react';
import { CODE_SYSTEMS } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../api';
import { Page } from '../components/Shell';
import { Empty, Show, useLoader } from '../components/states';
import { useMe, useSession } from '../session';

// X06 Visit summaries: after-visit summaries the provider released. The policy allows nothing else.
export function SummariesPage(): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const docs = useLoader(
    () => medplum.searchResources('DocumentReference', { patient: me.patientRef, category: `${CODE_SYSTEMS.documentCategory}|after-visit-summary`, status: 'current', _sort: '-date', _count: '100' }, { cache: 'no-cache' }),
    [medplum, me.patientRef]
  );
  return (
    <Page title="Visit summaries" subtitle="Instructions and next steps from your visits.">
      <Show loaded={docs}>
        {(list) => list.length === 0 ? (
          <Empty title="No summaries yet" text="After a visit, your provider's summary appears here." />
        ) : (
          <Stack gap="sm">{list.map((d) => <Summary key={d.id} doc={d} />)}</Stack>
        )}
      </Show>
    </Page>
  );
}

function Summary({ doc }: { readonly doc: DocumentReference }): JSX.Element {
  const { medplum } = useSession();
  const [busy, setBusy] = useState(false);
  const attachment = doc.content?.[0]?.attachment;
  const download = async (): Promise<void> => {
    if (!attachment?.url) return;
    setBusy(true);
    try {
      const blob = await medplum.download(attachment.url);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.title?.replace(/[^\w .-]/g, '_') || 'visit-summary';
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      notifications.show({ color: 'red', title: 'Download failed', message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card padding="md">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <IconFileText size={22} />
          <Stack gap={0}>
            <Text fw={600}>{doc.description ?? attachment?.title ?? 'Visit summary'}</Text>
            <Text size="sm" c="dimmed">{doc.date ? new Date(doc.date).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''}</Text>
          </Stack>
        </Group>
        <Button variant="light" leftSection={<IconDownload size={16} />} loading={busy} onClick={() => void download()} disabled={!attachment?.url}>Download</Button>
      </Group>
    </Card>
  );
}
