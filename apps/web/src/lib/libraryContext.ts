import {
  LIBRARY_HEADER,
  type LibrariesResult,
  type LibraryAction,
  type LibraryRole,
  type LibrarySummary,
  roleCan,
  TEAM_API,
} from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { isAppReadOnly, useAppReadOnly } from './appStatus';
import { browser, endSession, onSessionEnd, sessionUserId } from './sessionGuard';

/**
 * Phase 7: which library this tab works in (the member's own, or a Studio team library they belong to).
 *
 * - Kept per tab in sessionStorage, bound to the member who chose it, so another member signing in on this
 *   tab never inherits it.
 * - Every API call names it (X-Zephyr-Library); media URLs that the browser loads by itself (<img>, downloads)
 *   carry it as `?library=`.
 * - Switching runs the session-end clean-up (upload queue, AI scanner, device runner, editor, masks, caches)
 *   and reloads the app, so nothing of one library stays in memory while another is open.
 * - The API checks membership on every request. A 403 library_unavailable (removed, suspended, Studio lapsed)
 *   sends the tab back to the member's own library with a notice.
 */

const KEY = 'zephyr.library';
const NOTICE_KEY = 'zephyr.libraryNotice';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Stored {
  user: string;
  owner: string;
}
function readStored(): Stored | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored> | null;
    if (!v || typeof v.user !== 'string' || typeof v.owner !== 'string' || !UUID.test(v.owner)) return null;
    return { user: v.user, owner: v.owner };
  } catch {
    return null;
  }
}
function writeStored(v: Stored | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private mode without storage: the tab simply stays in the member's own library.
  }
}

/** The team library's owner id when this tab works in someone else's library; null for the member's own. */
export function activeOwner(): string | null {
  const me = sessionUserId();
  const s = readStored();
  if (!me || !s || s.user !== me || s.owner === me) return null;
  return s.owner;
}

/** Header for every API request (empty in the member's own library). */
export function libraryHeaders(): Record<string, string> {
  const o = activeOwner();
  return o ? { [LIBRARY_HEADER]: o } : {};
}

/** Adds `library=<owner>` to a same-origin media URL the browser fetches by itself (img src, links). */
export function withLibrary(url: string): string {
  const o = activeOwner();
  if (!o) return url;
  return `${url}${url.includes('?') ? '&' : '?'}library=${encodeURIComponent(o)}`;
}

// ---------------------------------------------------------------- the member's libraries
let list: LibrarySummary[] | null = null;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

type Fetcher = () => Promise<LibrariesResult>;
// api.ts imports this module for the header; the cycle is safe because both only call each other at runtime.
const defaultFetcher: Fetcher = () => api<LibrariesResult>(TEAM_API.libraries);
let fetcher: Fetcher = defaultFetcher;
/** Tests swap the network. */
export function setLibrariesFetcher(f: Fetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

/**
 * Reads the member's libraries. When the stored team library isn't among them any more, falls back to the
 * member's own library.
 */
export function refreshLibraries(): Promise<void> {
  inflight ??= fetcher()
    .then((r) => {
      list = Array.isArray(r.libraries) ? r.libraries : [];
      emit();
      const o = activeOwner();
      if (o && !list.some((l) => l.ownerId === o)) void fallbackToOwnLibrary();
    })
    .catch(() => {
      // Offline or a hiccup: keep what we have; the next call tries again.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
/** Replace the list after a team change (accepting an invite, leaving a team). */
export function setLibraries(next: LibrarySummary[]): void {
  list = next;
  emit();
}
export function getLibraries(): LibrarySummary[] | null {
  return list;
}

export function useLibraries(): LibrarySummary[] | null {
  const v = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => list,
    () => list,
  );
  useEffect(() => {
    if (!list && sessionUserId()) void refreshLibraries();
  }, []);
  return v;
}

/** The library open in this tab, as far as we know. */
export interface ActiveLibrary {
  ownerId: string | null;
  self: boolean;
  role: LibraryRole;
  state: LibrarySummary['state'];
  summary: LibrarySummary | null;
  /** True while a team library's role isn't confirmed yet (treated as view-only meanwhile). */
  pending: boolean;
}
export function currentLibrary(libs: LibrarySummary[] | null = list): ActiveLibrary {
  const owner = activeOwner();
  const me = sessionUserId();
  const target = owner ?? me;
  const summary = libs?.find((l) => l.ownerId === target) ?? null;
  if (!owner) {
    return {
      ownerId: me,
      self: true,
      role: 'owner',
      state: summary?.state ?? 'active',
      summary,
      pending: false,
    };
  }
  return {
    ownerId: owner,
    self: false,
    // The most restrictive role until the list confirms it; the API enforces the real one regardless.
    role: summary?.role ?? 'viewer',
    state: summary?.state ?? 'active',
    summary,
    pending: !summary,
  };
}
export function useActiveLibrary(): ActiveLibrary {
  const libs = useLibraries();
  return currentLibrary(libs);
}
const WRITES: readonly LibraryAction[] = ['upload', 'edit', 'ai', 'galleries'];
/**
 * May the member do this in the open library? A read-only library (over its plan's storage) and Zephyr's
 * read-only mode (phase 8, set in Admin or by itself during a storage incident) block writes that add data.
 */
export function canInLibrary(lib: ActiveLibrary, action: LibraryAction): boolean {
  if (!roleCan(lib.role, action)) return false;
  if ((lib.state === 'read_only' || isAppReadOnly()) && WRITES.includes(action)) return false;
  return true;
}
export function useCan(action: LibraryAction): boolean {
  // Subscribes to read-only mode so write entry points disappear and come back with it.
  useAppReadOnly();
  return canInLibrary(useActiveLibrary(), action);
}

// ---------------------------------------------------------------- switching
let switching = false;
/**
 * Opens another library in this tab. Stops everything bound to the current library first (while the session
 * and the current library header are still valid, so the server can drop staged uploads), then reloads.
 * Callers confirm with the member beforehand when uploads are in progress.
 */
export async function switchLibrary(ownerId: string): Promise<void> {
  const me = sessionUserId();
  if (!me || switching) return;
  const next = ownerId === me ? null : ownerId;
  if (next === activeOwner()) return;
  switching = true;
  try {
    await endSession('library', true);
  } finally {
    writeStored(next ? { user: me, owner: next } : null);
    switching = false;
    browser.assign('/');
  }
}

/** 403 library_unavailable: back to the member's own library, with a notice after the reload. */
export async function fallbackToOwnLibrary(): Promise<void> {
  if (!activeOwner() || switching) return;
  switching = true;
  try {
    await endSession('library', false);
  } finally {
    writeStored(null);
    try {
      sessionStorage.setItem(NOTICE_KEY, 'unavailable');
    } catch {
      // No notice then.
    }
    switching = false;
    browser.assign('/');
  }
}

/** Reads (once) the notice left by a fallback, for a toast after the reload. */
export function takeLibraryNotice(): 'unavailable' | null {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return v === 'unavailable' ? v : null;
  } catch {
    return null;
  }
}

/** Forget everything (sign-out, another member, account deleted). Not on a library switch. */
export function resetLibraryContext(): void {
  list = null;
  emit();
}
onSessionEnd(({ reason }) => {
  if (reason === 'library') return;
  writeStored(null);
  resetLibraryContext();
});

/** Test helper. */
export function __setActiveForTest(user: string | null, owner: string | null): void {
  writeStored(user && owner ? { user, owner } : null);
}
