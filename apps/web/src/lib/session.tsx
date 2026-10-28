import { APP_API, type SessionResponse, type SessionUser } from '@zephyr/shared/client';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, setUnauthenticatedHandler } from './api';

interface SessionState {
  /** undefined while the first check is in flight. */
  user: SessionUser | null | undefined;
  setUser: (u: SessionUser | null) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({
  children,
  onUnauthenticated,
}: {
  children: ReactNode;
  onUnauthenticated: () => void;
}) {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const r = await api<SessionResponse>(APP_API.session, { quiet401: true });
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiFailure && (e.code === 'unauthenticated' || e.code === 'forbidden')) setUser(null);
      else setUser((u) => (u === undefined ? null : u));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
      onUnauthenticated();
    });
    return () => setUnauthenticatedHandler(null);
  }, [onUnauthenticated]);

  const signOut = useCallback(async () => {
    try {
      await api(APP_API.signOut, { method: 'POST', body: {}, quiet401: true });
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(() => ({ user, setUser, refresh, signOut }), [user, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

export function initials(u: Pick<SessionUser, 'displayName' | 'email'>): string {
  const src = u.displayName?.trim() || u.email.split('@')[0] || '?';
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
