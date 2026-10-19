import { Alert, Button, Center, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}): JSX.Element {
  return (
    <Center py="xl">
      <Stack align="center" gap={6} maw={360} ta="center">
        <ThemeIcon size={44} radius="xl" variant="light" color="gray">
          {icon}
        </ThemeIcon>
        <Text fw={600} mt={4}>
          {title}
        </Text>
        {children && (
          <Text size="sm" c="dimmed">
            {children}
          </Text>
        )}
        {action}
      </Stack>
    </Center>
  );
}

export function ErrorState({ error, onRetry }: { readonly error: Error; readonly onRetry: () => void }): JSX.Element {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Could not load this section">
      <Text size="sm" mb="xs">
        {error.message}
      </Text>
      <Button size="xs" variant="white" color="red" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

export function RowsSkeleton({ rows = 5, height = 44 }: { readonly rows?: number; readonly height?: number }): JSX.Element {
  return (
    <Stack gap="xs" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} radius="md" />
      ))}
    </Stack>
  );
}
