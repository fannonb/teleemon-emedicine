import { Group, Text, Title } from '@mantine/core';
import type { JSX, ReactNode } from 'react';

/**
 * One header row for every dashboard card: title (and optional count) on the left, a single
 * action on the right, same height everywhere so card bodies line up across a row.
 */
export function CardHeader({ title, count, action, icon }: { readonly title: string; readonly count?: ReactNode; readonly action?: ReactNode; readonly icon?: ReactNode }): JSX.Element {
  return (
    <Group justify="space-between" wrap="nowrap" mih={32} mb="sm" gap="sm">
      <Group gap={8} wrap="nowrap" miw={0}>
        {icon}
        <Title order={2} fz={16} lh={1.3}>
          {title}
        </Title>
        {count !== undefined && (
          <Text size="sm" c="dimmed" className="tm-num">
            {count}
          </Text>
        )}
      </Group>
      {action}
    </Group>
  );
}
