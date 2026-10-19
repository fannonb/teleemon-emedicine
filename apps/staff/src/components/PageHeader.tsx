import { Group, Text, Title } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly eyebrow?: ReactNode;
}): JSX.Element {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" gap="md">
      <div>
        {eyebrow && (
          <Text size="xs" fw={650} tt="uppercase" c="brand.7" lts="0.06em" mb={4}>
            {eyebrow}
          </Text>
        )}
        <Title order={1}>{title}</Title>
        {subtitle && (
          <Text c="dimmed" size="sm" mt={4}>
            {subtitle}
          </Text>
        )}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/** Standard content width and padding for every staff page. */
export function PageBody({ children, wide }: { readonly children: ReactNode; readonly wide?: boolean }): JSX.Element {
  return (
    <div style={{ maxWidth: wide ? 1600 : 1320, margin: '0 auto', padding: 'var(--mantine-spacing-xl) var(--mantine-spacing-lg)' }}>
      {children}
    </div>
  );
}
