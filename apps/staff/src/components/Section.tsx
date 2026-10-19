import { Card, Group, Text, ThemeIcon, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { isForbidden } from '../fhir/patient';
import type { Loaded } from '../hooks/useLoader';
import { EmptyState, ErrorState, RowsSkeleton } from './states';

/**
 * A card that renders a Loaded<T> through the standard states: skeleton, role-restricted,
 * error with retry, empty, or content. Every chart section uses it, so the states look and
 * behave the same everywhere.
 */
export function Section<T>({
  title,
  actions,
  loaded,
  isEmpty,
  empty,
  children,
  padding = 'lg',
  rows = 3,
}: {
  readonly title?: ReactNode;
  readonly actions?: ReactNode;
  readonly loaded: Loaded<T>;
  readonly isEmpty?: (data: T) => boolean;
  readonly empty?: { icon: ReactNode; title: string; text?: ReactNode; action?: ReactNode };
  readonly children: (data: T) => ReactNode;
  readonly padding?: 'md' | 'lg';
  readonly rows?: number;
}): JSX.Element {
  const { data, loading, error, reload } = loaded;
  let body: ReactNode;
  if (loading && data === undefined) {
    body = <RowsSkeleton rows={rows} />;
  } else if (error && isForbidden(error)) {
    body = <RoleRestricted />;
  } else if (error) {
    body = <ErrorState error={error} onRetry={reload} />;
  } else if (data !== undefined && empty && isEmpty?.(data)) {
    body = (
      <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>
        {empty.text}
      </EmptyState>
    );
  } else if (data !== undefined) {
    body = children(data);
  }

  return (
    <Card padding={padding}>
      {(title || actions) && (
        <Group justify="space-between" mb="md" wrap="nowrap">
          {typeof title === 'string' ? <Title order={2}>{title}</Title> : title}
          {!(error && isForbidden(error)) && actions}
        </Group>
      )}
      {body}
    </Card>
  );
}

export function RoleRestricted({ what = 'This information' }: { readonly what?: string }): JSX.Element {
  return (
    <Group gap="sm" wrap="nowrap" py="xs">
      <ThemeIcon variant="light" color="gray" radius="xl">
        <IconLock size={15} />
      </ThemeIcon>
      <Text size="sm" c="dimmed">
        {what} isn't available for your role. The server refused the request, and the refusal is logged.
      </Text>
    </Group>
  );
}
