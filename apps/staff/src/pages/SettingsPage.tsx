import { Badge, Card, Group, SimpleGrid, Text, ThemeIcon, Title, UnstyledButton } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import {
  IconBuildingHospital,
  IconCertificate,
  IconChevronRight,
  IconMessages,
  IconPlugConnected,
  IconReceipt2,
  IconTemplate,
  IconUsersGroup,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../components/PageHeader';
import { SETTINGS_PAGE_IDS, canSee, getPage } from '../navigation';
import { useRoles } from '../session/roles';
import classes from './SettingsPage.module.css';

const ICONS: Record<string, ReactNode> = {
  P38: <IconBuildingHospital size={20} />,
  P39: <IconCertificate size={20} />,
  P40: <IconReceipt2 size={20} />,
  P41: <IconTemplate size={20} />,
  P42: <IconMessages size={20} />,
  P43: <IconUsersGroup size={20} />,
  P44: <IconPlugConnected size={20} />,
};

export function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const medplum = useMedplum();
  const { roles } = useRoles();
  const mfaRequired = medplum.getProject()?.setting?.find((s) => s.name === 'mfaRequired')?.valueBoolean === true;
  const pages = SETTINGS_PAGE_IDS.map(getPage).filter((p) => canSee(p, roles));

  return (
    <PageBody>
      <PageHeader eyebrow="Insight & admin" title="Settings" subtitle="Configuration that drives booking, prescribing, billing and security." />
      <Card mb="lg" padding="md">
        <Group justify="space-between">
          <Group gap="sm">
            <ThemeIcon color={mfaRequired ? 'green' : 'orange'} variant="light" radius="xl">
              <IconUsersGroup size={16} />
            </ThemeIcon>
            <div>
              <Text size="sm" fw={600}>
                Two-factor sign-in
              </Text>
              <Text size="xs" c="dimmed">
                {mfaRequired
                  ? 'Required for every user in this project. Enforced by the server.'
                  : 'Not enforced yet. Run `npm run setup -- --mfa` to require it for every user.'}
              </Text>
            </div>
          </Group>
          <Badge color={mfaRequired ? 'green' : 'orange'}>{mfaRequired ? 'Enforced' : 'Off'}</Badge>
        </Group>
      </Card>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        {pages.map((page) => (
          <UnstyledButton key={page.id} className={classes.tile} onClick={() => navigate(page.path)}>
            <Group wrap="nowrap" align="flex-start" gap="md">
              <ThemeIcon size={40} radius="md" variant="light" color="navy">
                {ICONS[page.id]}
              </ThemeIcon>
              <div style={{ flex: 1 }}>
                <Group gap={6} mb={2}>
                  <Title order={3}>{page.title}</Title>
                </Group>
                <Text size="sm" c="dimmed" lineClamp={2}>
                  {page.purpose}
                </Text>
                <Badge mt="sm" size="xs" color="gray">
                  {page.id} · Phase {page.phase}
                </Badge>
              </div>
              <IconChevronRight size={18} className={classes.chevron} />
            </Group>
          </UnstyledButton>
        ))}
      </SimpleGrid>
    </PageBody>
  );
}
