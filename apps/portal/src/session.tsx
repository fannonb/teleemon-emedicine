import type { MedplumClient } from '@medplum/core';
import { useMedplum } from '@medplum/react-hooks';
import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { portalApi } from './api';

export interface Me {
  readonly actor: string;
  readonly actorName: string;
  readonly patientRef: string;
  /** 'self', or a proxy's level: 'full' (sees what the patient sees) or 'limited' (scheduling and insurance only). */
  readonly access: 'self' | 'full' | 'limited';
  readonly patientName: string;
  readonly visitTypes: { code: string; label: string; minutes: number }[];
  readonly states: string[];
  readonly lastState?: string;
}

interface SessionValue {
  readonly medplum: MedplumClient;
  readonly api: ReturnType<typeof portalApi>;
  readonly me?: Me;
  readonly loading: boolean;
  readonly error?: string;
  readonly reload: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function PortalSessionProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const api = useMemo(() => portalApi(medplum), [medplum]);
  const [me, setMe] = useState<Me>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async (): Promise<void> => {
    if (!medplum.getAccessToken()) {
      setMe(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setMe(await api.get<Me>('me'));
      setError(undefined);
    } catch (err) {
      setMe(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api, medplum]);

  const signOut = useCallback(async (): Promise<void> => {
    await medplum.signOut().catch(() => medplum.clear());
    setMe(undefined);
  }, [medplum]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  // Shared and family devices: sign out after 15 minutes without activity.
  useEffect(() => {
    if (!me) return undefined;
    let timer = window.setTimeout(() => void signOut(), 15 * 60000);
    const reset = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void signOut(), 15 * 60000);
    };
    const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [me, signOut]);

  const value = useMemo(() => ({ medplum, api, me, loading, error, reload, signOut }), [medplum, api, me, loading, error, reload, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside PortalSessionProvider');
  return ctx;
}

/** A signed-in page: `me` is always present. */
export function useMe(): Me & { readonly clinical: boolean } {
  const { me } = useSession();
  if (!me) throw new Error('useMe on a public page');
  return { ...me, clinical: me.access !== 'limited' };
}
