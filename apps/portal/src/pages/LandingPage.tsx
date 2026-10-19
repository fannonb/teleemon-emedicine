import { Anchor, Button, Card, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCalendarPlus, IconLogin } from '@tabler/icons-react';
import type { JSX } from 'react';
import { Link } from 'react-router';

export function LandingPage(): JSX.Element {
  return (
    <div className="tm-page">
      <Stack gap="lg">
        <div>
          <Title order={1}>Psychiatric care by video</Title>
          <Text c="dimmed" mt={6}>For patients in Washington, California, Colorado or Rhode Island at the time of their visit.</Text>
        </div>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Card>
            <Stack gap="sm">
              <ThemeIcon size={40} radius="xl" variant="light"><IconCalendarPlus size={22} /></ThemeIcon>
              <Title order={2}>New here?</Title>
              <Text size="sm" c="dimmed">Pick a time for your first visit. We will help you set up your account.</Text>
              <Button component={Link} to="/book">Book a first visit</Button>
              <Text size="sm" c="dimmed">Prefer to do your forms first? <Anchor component={Link} to="/register">Create an account</Anchor></Text>
            </Stack>
          </Card>
          <Card>
            <Stack gap="sm">
              <ThemeIcon size={40} radius="xl" variant="light" color="navy"><IconLogin size={22} /></ThemeIcon>
              <Title order={2}>Already a patient?</Title>
              <Text size="sm" c="dimmed">Book, check in, message us and see your visit summaries.</Text>
              <Button component={Link} to="/signin" variant="light" color="navy">Sign in</Button>
            </Stack>
          </Card>
        </SimpleGrid>
        <Text size="xs" c="dimmed">No ads or tracking on this site.</Text>
      </Stack>
    </div>
  );
}
