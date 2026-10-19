import { Alert, Button, Card, Skeleton, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconInbox } from '@tabler/icons-react';
import type { DependencyList, JSX, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api';

export interface Loaded<T> {
  readonly data?: T;
  readonly error?: string;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** Loads data for a view and reloads when `deps` change; stale responses are ignored. */
export function useLoader<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    run().then(
      (data) => n === seq.current && setState({ data, loading: false }),
      (err: unknown) => n === seq.current && setState({ error: errorText(err), loading: false })
    );
  }, [run]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

export function Rows({ count = 3 }: { readonly count?: number }): JSX.Element {
  return (
    <Stack gap="sm" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} height={64} radius="md" />)}
    </Stack>
  );
}

export function ErrorState({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }): JSX.Element {
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title="This could not be loaded">
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{message}</Text>
        {onRetry && <Button size="xs" variant="white" color="red" onClick={onRetry}>Try again</Button>}
      </Stack>
    </Alert>
  );
}

export function Empty({ title, text, action }: { readonly title: string; readonly text: string; readonly action?: ReactNode }): JSX.Element {
  return (
    <Card>
      <Stack align="center" gap={6} py="md" ta="center">
        <ThemeIcon variant="light" color="gray" size={40} radius="xl"><IconInbox size={22} /></ThemeIcon>
        <Text fw={650}>{title}</Text>
        <Text size="sm" c="dimmed" maw={420}>{text}</Text>
        {action}
      </Stack>
    </Card>
  );
}

/** Renders loading, error or the content of a Loaded value. */
export function Show<T>({ loaded, children, rows }: { readonly loaded: Loaded<T>; readonly children: (data: T) => ReactNode; readonly rows?: number }): JSX.Element {
  if (loaded.error) return <ErrorState message={loaded.error} onRetry={loaded.reload} />;
  if (loaded.data === undefined) return <Rows count={rows} />;
  return <>{children(loaded.data)}</>;
}
