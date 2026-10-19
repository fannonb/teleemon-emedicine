import { useMedplum, useMedplumProfile } from '@medplum/react';
import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Role } from '../navigation';
import type { RoleSession } from './roleResolution';
import { rolesFromSession } from './roleResolution';

// Role resolution for navigation. This decides what the UI shows; it is not a security
// boundary. Server-side AccessPolicies (Phase 1, P43) enforce the same roles on every request.

const PREVIEW_KEY = 'teleemon.previewRole';

interface RoleContextValue {
  readonly loading: boolean;
  readonly error: string | undefined;
  /** Roles granted by the user's project membership. */
  readonly actualRoles: Role[];
  /** Roles the UI is rendering for (differs only while an admin previews another role). */
  readonly roles: Role[];
  readonly previewRole: Role | undefined;
  readonly setPreviewRole: (role: Role | undefined) => void;
}

const RoleContext = createContext<RoleContextValue | undefined>(undefined);

export function RoleProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const membership = medplum.getProjectMembership();
  const sessionKey = `${membership?.id ?? ''}:${profile?.resourceType ?? ''}/${profile?.id ?? ''}`;
  const [resolved, setResolved] = useState<{ key: string; roles: Role[]; error?: string }>();
  useEffect(() => {
    let active = true;
    if (!profile) { setResolved({ key: sessionKey, roles: [] }); return; }
    void medplum.get<RoleSession>('auth/me', { cache: 'no-cache' }).then((session) => {
      if (active) setResolved({ key: sessionKey, roles: rolesFromSession(session) });
    }).catch(() => {
      if (active) setResolved({ key: sessionKey, roles: [], error: 'Your access could not be loaded. Refresh the page or sign in again.' });
    });
    return () => { active = false; };
  }, [medplum, sessionKey, profile]);
  const loading = resolved?.key !== sessionKey;
  const actualRoles = !loading && !resolved?.error ? resolved?.roles ?? [] : [];
  const [previewRole, setPreviewState] = useState<Role | undefined>(() => {
    try {
      return (sessionStorage.getItem(PREVIEW_KEY) as Role | null) ?? undefined;
    } catch {
      return undefined;
    }
  });

  const setPreviewRole = useCallback((role: Role | undefined) => {
    try {
      if (role) sessionStorage.setItem(PREVIEW_KEY, role);
      else sessionStorage.removeItem(PREVIEW_KEY);
    } catch {
      // Storage unavailable: preview still works for this page view.
    }
    setPreviewState(role);
  }, []);

  const isAdmin = actualRoles.includes('admin');
  const effectivePreview = isAdmin ? previewRole : undefined;
  const value = useMemo<RoleContextValue>(
    () => ({
      loading,
      error: resolved?.key === sessionKey ? resolved.error : undefined,
      actualRoles,
      roles: effectivePreview ? [effectivePreview] : actualRoles,
      previewRole: effectivePreview,
      setPreviewRole,
    }),
    [actualRoles, effectivePreview, setPreviewRole, loading, resolved, sessionKey]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRoles(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) {
    throw new Error('useRoles must be used inside RoleProvider');
  }
  return ctx;
}
