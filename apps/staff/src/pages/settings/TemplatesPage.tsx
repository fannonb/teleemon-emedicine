import { Accordion, ActionIcon, Badge, Button, Card, Grid, Group, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import { useMedplum } from '@medplum/react';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import type { SectionKey, TemplateCode, TemplateSettings } from '@teleemon/core';
import { MEASURE_LIST, NOTE_TEMPLATES, SECTION_LABELS, VISIT_TYPES, readSettings, writeSettings } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';

const TEXT_SECTIONS: SectionKey[] = ['chiefComplaint', 'intervalHistory', 'psychRos', 'substanceUse', 'pastHistory', 'socialHistory', 'assessment', 'plan', 'followUp'];

// P41 Templates and questionnaires.
export function TemplatesPage(): JSX.Element {
  const medplum = useMedplum();
  const settings = useLoader(() => readSettings(medplum, 'templates'), [medplum]);
  return (
    <PageBody>
      <PageHeader eyebrow="P41 · Settings" title="Templates and questionnaires" subtitle="Changes apply to new notes only: a note copies its template when it is created, so signed and draft notes never change." />
      <Section loaded={settings}>{(s) => <TemplatesForm initial={s} onSaved={settings.reload} />}</Section>
    </PageBody>
  );
}

function TemplatesForm({ initial, onSaved }: { readonly initial: TemplateSettings; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const [s, setS] = useState<TemplateSettings>(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(initial), [initial]);

  const triggers = s.phrases.map((p) => p.trigger.toLowerCase());
  const badTrigger = s.phrases.find((p, i) => !/^\.[a-z0-9-]{2,}$/i.test(p.trigger) || triggers.indexOf(p.trigger.toLowerCase()) !== i);

  const setDefault = (template: TemplateCode, key: SectionKey, value: string): void => {
    const forTemplate = { ...(s.defaults[template] ?? {}), [key]: value };
    if (!value) delete forTemplate[key];
    setS({ ...s, defaults: { ...s.defaults, [template]: forTemplate } });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await writeSettings(medplum, 'templates', { ...s, phrases: s.phrases.filter((p) => p.trigger && p.text.trim()) });
      notifications.show({ color: 'brand', message: 'Templates saved. New notes use them from now on.' });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not saved', message: normalizeErrorString(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, lg: 7 }}>
        <Card>
          <Group justify="space-between" mb="sm">
            <Title order={2}>Note templates</Title>
            <Button leftSection={<IconDeviceFloppy size={16} />} loading={saving} disabled={!!badTrigger} onClick={save}>
              Save templates
            </Button>
          </Group>
          <Accordion variant="separated" chevronPosition="left">
            {NOTE_TEMPLATES.map((t) => (
              <Accordion.Item key={t.code} value={t.code}>
                <Accordion.Control>
                  <Group justify="space-between" pr="sm">
                    <Text fw={600} size="sm">
                      {t.label}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {t.sections.length} sections
                    </Badge>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Text size="xs" c="dimmed" mb="sm">
                    Sections: {t.sections.map((k) => SECTION_LABELS[k]).join(' · ')}. Default text pre-fills new notes; leave blank for none.
                  </Text>
                  <Stack gap="xs">
                    {t.sections
                      .filter((k) => TEXT_SECTIONS.includes(k))
                      .map((k) => (
                        <Textarea key={k} size="xs" label={SECTION_LABELS[k]} autosize minRows={1} value={s.defaults[t.code]?.[k] ?? t.defaults[k] ?? ''} onChange={(e) => setDefault(t.code, k, e.currentTarget.value)} />
                      ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </Card>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 5 }}>
        <Stack gap="lg">
          <Card>
            <Group justify="space-between" mb="xs">
              <Title order={2}>Smart phrases</Title>
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setS({ ...s, phrases: [...s.phrases, { trigger: '.', text: '' }] })}>
                Add
              </Button>
            </Group>
            <Text size="xs" c="dimmed" mb="sm">
              Type the trigger followed by a space in any note section to insert the text.
            </Text>
            {badTrigger && (
              <Text size="xs" c="red" mb="xs">
                Triggers start with a dot, use letters, numbers or dashes, and must be unique ({badTrigger.trigger || 'empty'}).
              </Text>
            )}
            <Table verticalSpacing={6}>
              <Table.Tbody>
                {s.phrases.map((p, i) => (
                  <Table.Tr key={i}>
                    <Table.Td w={110} style={{ verticalAlign: 'top' }}>
                      <TextInput size="xs" value={p.trigger} onChange={(e) => setS({ ...s, phrases: s.phrases.map((x, j) => (j === i ? { ...x, trigger: e.currentTarget.value.trim() } : x)) })} aria-label="Trigger" />
                    </Table.Td>
                    <Table.Td>
                      <Textarea size="xs" autosize minRows={1} value={p.text} onChange={(e) => setS({ ...s, phrases: s.phrases.map((x, j) => (j === i ? { ...x, text: e.currentTarget.value } : x)) })} aria-label="Text" />
                    </Table.Td>
                    <Table.Td w={36} style={{ verticalAlign: 'top' }}>
                      <ActionIcon variant="subtle" color="red" onClick={() => setS({ ...s, phrases: s.phrases.filter((_, j) => j !== i) })} aria-label={`Remove ${p.trigger}`}>
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
          <Card>
            <Title order={2} mb="xs">
              Questionnaires
            </Title>
            <Stack gap={4}>
              {MEASURE_LIST.map((m) => (
                <Group key={m.key} justify="space-between">
                  <Text size="sm">{m.title}</Text>
                  <Badge size="xs" variant="light">
                    {m.items.length} items
                  </Badge>
                </Group>
              ))}
            </Stack>
            <Text size="sm" fw={600} mt="md">
              Sent before each visit type
            </Text>
            <Stack gap={4} mt={4}>
              {VISIT_TYPES.map((v) => (
                <Group key={v.code} justify="space-between" gap="xs" wrap="nowrap">
                  <Text size="xs">{v.label}</Text>
                  <Text size="xs" c="dimmed" ta="right">
                    {v.measures.length ? v.measures.map((k) => MEASURE_LIST.find((m) => m.key === k)?.shortTitle ?? k).join(', ') : 'None'}
                  </Text>
                </Group>
              ))}
            </Stack>
            <Text size="xs" c="dimmed" mt="sm">
              Patients answer these in the portal before the visit. Scoring rules and the per-visit-type list are fixed in code, so portal and in-session scores always match.
            </Text>
          </Card>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
