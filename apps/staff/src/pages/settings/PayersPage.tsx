import { Alert, Button, Group, List, Stack, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconBuildingBank, IconCoin, IconDeviceFloppy, IconListCheck, IconScale } from '@tabler/icons-react';
import type { BillingSettings } from '@teleemon/core';
import type { Basic } from '@medplum/fhirtypes';
import { readSettingsSnapshot, writeSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';
import { billingProblems } from './billingRules';
import { FeesPanel, PayersPanel } from './PayersPanels';
import { PolicyPanel, ScrubRulesPanel } from './RulesPanels';

// P40 Payers, fees & codes. One draft covers all four tabs, so a single save writes the whole
// billing configuration and nothing is half-saved.
export function PayersPage(): JSX.Element {
  const medplum = useMedplum();
  const settings = useLoader(() => readSettingsSnapshot(medplum, 'billing'), [medplum]);
  return (
    <PageBody>
      <PageHeader
        eyebrow="P40 · Settings"
        title="Payers, fees & codes"
        subtitle="The configuration that drives charges and claims. A change applies to the next charge or claim; anything already posted stays as it was."
      />
      <Section loaded={settings} padding="lg" rows={5}>
        {(saved) => <BillingEditor key={`${saved.resource?.id}:${saved.resource?.meta?.versionId}`} initial={saved.value} resource={saved.resource} reload={settings.reload} />}
      </Section>
    </PageBody>
  );
}

function BillingEditor({ initial, resource, reload }: { readonly initial: BillingSettings; readonly resource: Basic | null; readonly reload: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [version, setVersion] = useState(resource);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const problems = billingProblems(draft);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const updated = await writeSettings(medplum, 'billing', draft, version);
      setVersion(updated);
      setSaved(draft);
      notifications.show({ color: 'brand', message: 'Billing settings saved. New charges and claims use them from now on.' });
    } catch (err) {
      setSaveError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="sm" c={dirty ? 'orange' : 'dimmed'} fw={dirty ? 600 : undefined} aria-live="polite">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </Text>
        <Group gap="xs">
          <Button variant="default" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
            Discard changes
          </Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty || problems.length > 0 || saving} loading={saving} onClick={save}>
            Save changes
          </Button>
        </Group>
      </Group>

      {problems.length > 0 && (
        <Alert color="orange" variant="light" title={`${problems.length} ${problems.length === 1 ? 'thing needs' : 'things need'} fixing before saving`}>
          <List size="sm" spacing={4}>
            {problems.slice(0, 8).map((p) => (
              <List.Item key={p}>{p}</List.Item>
            ))}
          </List>
          {problems.length > 8 && <Text size="sm" mt={4}>and {problems.length - 8} more.</Text>}
        </Alert>
      )}
      {saveError && (
        <Alert color="red" variant="light" title="Not saved">
          {saveError} Reload the saved settings to review any changes made by another person.
          <Button variant="subtle" size="xs" onClick={reload}>Reload saved settings</Button>
        </Alert>
      )}

      <Tabs defaultValue="payers">
        <Tabs.List>
          <Tabs.Tab value="payers" leftSection={<IconBuildingBank size={14} />}>
            Payers
          </Tabs.Tab>
          <Tabs.Tab value="fees" leftSection={<IconCoin size={14} />}>
            Fee schedule
          </Tabs.Tab>
          <Tabs.Tab value="rules" leftSection={<IconListCheck size={14} />}>
            Scrub rules
          </Tabs.Tab>
          <Tabs.Tab value="policy" leftSection={<IconScale size={14} />}>
            Billing policy
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="payers" pt="md">
          <PayersPanel payers={draft.payers} onChange={(payers) => setDraft((d) => ({ ...d, payers }))} />
        </Tabs.Panel>
        <Tabs.Panel value="fees" pt="md">
          <FeesPanel fees={draft.fees} payers={draft.payers} onChange={(fees) => setDraft((d) => ({ ...d, fees }))} />
        </Tabs.Panel>
        <Tabs.Panel value="rules" pt="md">
          <ScrubRulesPanel
            disabledRules={draft.disabledScrubRules}
            onChange={(disabledScrubRules) => setDraft((d) => ({ ...d, disabledScrubRules }))}
          />
        </Tabs.Panel>
        <Tabs.Panel value="policy" pt="md">
          <PolicyPanel policy={draft.policy} onChange={(policy) => setDraft((d) => ({ ...d, policy }))} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
