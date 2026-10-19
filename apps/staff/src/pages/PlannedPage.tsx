import { Badge, Card, Group, List, Stack, Text, ThemeIcon, Timeline, Title } from '@mantine/core';
import { IconCircleCheck, IconHammer, IconTarget } from '@tabler/icons-react';
import type { JSX } from 'react';
import { PageBody, PageHeader } from '../components/PageHeader';
import type { PageDef } from '../navigation';

const PHASE_NAMES: Record<number, string> = {
  0: 'Foundation and design system',
  1: 'Patients and chart',
  2: 'Scheduling and licensure',
  3: 'Encounter documentation',
  4: 'AI scribe',
  5: 'E-prescribing and PDMP',
  6: 'Inbox, tasks, documents and fax',
  7: 'Patient portal',
  8: 'Revenue cycle',
  9: 'Reports, compliance and go-live',
};

// Shown for every page in the scope that a later phase delivers, so the full product is
// navigable from day one and each page states what "done" means for it.

export function PlannedPage({ page, context }: { readonly page: PageDef; readonly context?: string }): JSX.Element {
  return (
    <PageBody>
      <PageHeader
        eyebrow={`${page.id} · Planned`}
        title={page.title}
        subtitle={context ?? page.purpose}
        actions={
          <Badge size="lg" color="navy" variant="light" leftSection={<IconHammer size={14} />}>
            Phase {page.phase}: {PHASE_NAMES[page.phase]}
          </Badge>
        }
      />
      <Group align="stretch" grow wrap="wrap" gap="lg">
        <Card miw={300}>
          <Group gap="xs" mb="sm">
            <ThemeIcon variant="light" color="brand" radius="xl">
              <IconTarget size={16} />
            </ThemeIcon>
            <Title order={3}>Purpose</Title>
          </Group>
          <Text size="sm">{page.purpose}</Text>
        </Card>
        <Card miw={300}>
          <Group gap="xs" mb="sm">
            <ThemeIcon variant="light" color="brand" radius="xl">
              <IconCircleCheck size={16} />
            </ThemeIcon>
            <Title order={3}>Acceptance criteria</Title>
          </Group>
          {page.acceptance.length > 0 ? (
            <List size="sm" spacing={6}>
              {page.acceptance.map((a) => (
                <List.Item key={a}>{a}</List.Item>
              ))}
            </List>
          ) : (
            <Text size="sm" c="dimmed">
              Defined in the scope document, section 15 ({page.id}). Confirmed at the start of Phase {page.phase}.
            </Text>
          )}
        </Card>
      </Group>
      <Card mt="lg">
        <Title order={3} mb="md">
          Where this fits
        </Title>
        <Stack gap="xs">
          <Timeline active={0} bulletSize={18} lineWidth={2} color="brand">
            {Object.entries(PHASE_NAMES).map(([n, name]) => (
              <Timeline.Item
                key={n}
                title={
                  <Text size="sm" fw={Number(n) === page.phase ? 700 : 500} c={Number(n) === page.phase ? undefined : 'dimmed'}>
                    Phase {n} · {name}
                    {Number(n) === page.phase && ' ← this page'}
                  </Text>
                }
              />
            ))}
          </Timeline>
        </Stack>
      </Card>
    </PageBody>
  );
}
