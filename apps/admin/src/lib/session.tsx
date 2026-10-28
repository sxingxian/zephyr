import { ADMIN_API, type AdminSessionResponse } from '@zephyr/shared/client';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, setUnauthenticatedHandler } from './api';

type Staff = AdminSessionResponse['staff'];
interface State {
  /** undefined while loading; null when signed out. */
  staff: Staff | null | undefined;
  enrolOnly: boolean;
  /** Set when Cloudflare Access didn't let the request through. */
  accessDenied: boolean;
  setSession: (s: AdminSessionResponse | null) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<State | null>(null);

/** Sessions lock after 30 minutes without activity (the API enforces this too). */
export const IDLE_MS = 30 * 60 * 1000;

export function AdminSessionProvider({
  children,
  onUnauthenticated,
}: {
  children: ReactNode;
  onUnauthenticated: () => void;
}) {
  const [staff, setStaff] = useState<Staff | null | undefined>(undefined);
  const [enrolOnly, setEnrolOnly] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const setSession = useCallback((s: AdminSessionResponse | null) => {
    setStaff(s ? s.staff : null);
    setEnrolOnly(Boolean(s?.enrolOnly));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<AdminSessionResponse>(ADMIN_API.session, { quiet401: true }));
      setAccessDenied(false);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'forbidden') setAccessDenied(true);
      setSession(null);
    }
  }, [setSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api(ADMIN_API.signOut, { method: 'POST', body: {}, quiet401: true });
    } catch {
      /* signed out locally either way */
    }
    setSession(null);
  }, [setSession]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setSession(null);
      onUnauthenticated();
    });
    return () => setUnauthenticatedHandler(null);
  }, [onUnauthenticated, setSession]);

  // Idle lock: any input resets the timer; after 30 quiet minutes, sign out.
  useEffect(() => {
    if (!staff) return;
    let t = setTimeout(lock, IDLE_MS);
    function lock() {
      void signOut().then(onUnauthenticated);
    }
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(lock, IDLE_MS);
    };
    const evs = ['pointerdown', 'keydown', 'scroll', 'focus'] as const;
    for (const e of evs) window.addEventListener(e, bump, { passive: true });
    return () => {
      clearTimeout(t);
      for (const e of evs) window.removeEventListener(e, bump);
    };
  }, [staff, signOut, onUnauthenticated]);

  const value = useMemo(
    () => ({ staff, enrolOnly, accessDenied, setSession, refresh, signOut }),
    [staff, enrolOnly, accessDenied, setSession, refresh, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAdminSession(): State {
  const s = useContext(Ctx);
  if (!s) throw new Error('useAdminSession outside provider');
  return s;
}

export const canWrite = (role: Staff['role'] | undefined) => role === 'owner' || role === 'admin';
export const canChangeMode = (role: Staff['role'] | undefined) => role === 'owner';
export const ROLE_LABEL: Record<Staff['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  finance: 'Finance',
  safety: 'Safety',
  support: 'Support',
};
