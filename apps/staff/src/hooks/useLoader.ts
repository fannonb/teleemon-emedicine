import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
}

/**
 * Runs an async loader and tracks loading/error state. Pass `refreshMs` to poll; polling
 * refreshes in place without flashing the loading state.
 */
export function useLoader<T>(load: () => Promise<T>, deps: readonly unknown[], refreshMs?: number): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useCallback((showLoading: boolean) => {
    const gen = ++generation.current;
    if (showLoading) setLoading(true);
    loadRef
      .current()
      .then((result) => {
        if (gen === generation.current) {
          setData(result);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (gen === generation.current) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    run(true);
    const timer = refreshMs ? window.setInterval(() => run(false), refreshMs) : undefined;
    return () => {
      ++generation.current;
      if (timer) window.clearInterval(timer);
    };
  }, [...deps, refreshMs, run]);

  return { data, error, loading, reload: useCallback(() => run(true), [run]) };
}
