import { Group, Kbd, Modal, Stack, Text } from '@mantine/core';
import type { JSX } from 'react';

const SHORTCUTS: [string[], string][] = [
  [['Ctrl', 'K'], 'Search patients'],
  [['/'], 'Search patients'],
  [['Alt', 'T'], 'Today'],
  [['Alt', 'P'], 'Find patient'],
  [['Alt', 'C'], 'Calendar'],
  [['Alt', 'N'], 'New patient'],
  [['?'], 'Show this list'],
];

export function ShortcutsModal({ opened, onClose }: { readonly opened: boolean; readonly onClose: () => void }): JSX.Element {
  return (
    <Modal opened={opened} onClose={onClose} title="Keyboard shortcuts" centered size="sm">
      <Stack gap={10}>
        {SHORTCUTS.map(([keys, label]) => (
          <Group key={`${keys.join('+')}-${label}`} justify="space-between">
            <Text size="sm">{label}</Text>
            <Group gap={4}>
              {keys.map((k) => (
                <Kbd key={k} size="sm">
                  {k}
                </Kbd>
              ))}
            </Group>
          </Group>
        ))}
        <Text size="xs" c="dimmed" mt="xs">
          Shortcuts are ignored while you type in a field.
        </Text>
      </Stack>
    </Modal>
  );
}
