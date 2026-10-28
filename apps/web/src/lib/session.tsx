import { APP_API, type SessionResponse, type SessionUser } from '@zephyr/shared/client';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ApiFailure,
  api,
  setPendingDeletionHandler,
  setSessionChangedHandler,
  setUnauthenticatedHandler,
} from './api';
import { browser, endSession, onOtherTabSession, setSessionUserId } from './sessionGuard';
import { resetUsage } from './usage';

/** The session user; `pendingDeletion` is set while the account is scheduled for deletion. */
export type AppUser = SessionUser;

interface SessionState {
  /** undefined while the first check is in flight. */
  user: AppUser | null | undefined;
  setUser: (u: AppUser | null) => void;
  refresh: () => Promise<void>;
  /** Stops this member's uploads, signs out, then reloads the app at sign-in so no photo data stays in memory. */
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
  const [user, setUserState] = useState<AppUser | null | undefined>(undefined);
  const lastId = useRef<string | null>(null);
  const setUser = useCallback((u: AppUser | null) => {
    // A different member (or none): forget the cached storage figures and stop the previous member's
    // uploads before anything can be sent with the new session.
    if (!u || (lastId.current && lastId.current !== u.id)) {
      resetUsage();
      void endSession(u ? 'switched' : 'unauthenticated', false);
    }
    lastId.current = u?.id ?? null;
    setSessionUserId(lastId.current);
    setUserState(u);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<SessionResponse>(APP_API.session, { quiet401: true });
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiFailure && (e.code === 'unauthenticated' || e.code === 'forbidden')) setUser(null);
      else setUserState((u) => (u === undefined ? null : u));
    }
  }, [setUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
      onUnauthenticated();
    });
    return () => setUnauthenticatedHandler(null);
  }, [onUnauthenticated, setUser]);

  // Another tab signed out, or signed in as someone else (the cookie is shared): stop everything here and
  // reload, which re-reads the session.
  useEffect(
    () =>
      onOtherTabSession(() => {
        void endSession('switched', false);
        browser.assign('/');
      }),
    [],
  );

  // An upload call found the cookie now belongs to someone else (a tab that missed the broadcast): same
  // as above, stop everything and reload.
  useEffect(() => {
    setSessionChangedHandler(() => {
      void endSession('switched', false);
      browser.assign('/');
    });
    return () => setSessionChangedHandler(null);
  }, []);

  // Any call answering 403 account_pending_deletion: re-read the session, which then routes to Restore.
  useEffect(() => {
    setPendingDeletionHandler(() => void refresh());
    return () => setPendingDeletionHandler(null);
  }, [refresh]);

  const signOut = useCallback(async () => {
    // First, while the session is still valid: stop this member's uploads and drop them on the server.
    await endSession('sign-out', true);
    try {
      await api(APP_API.signOut, { method: 'POST', body: {}, quiet401: true });
    } catch {
      // Signed out here regardless; the reload below re-reads the session from the server.
    } finally {
      setUser(null);
      browser.assign('/sign-in');
    }
  }, [setUser]);

  const value = useMemo(() => ({ user, setUser, refresh, signOut }), [user, setUser, refresh, signOut]);
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
