import type { GuestPhoto, GuestPhotoPage } from '@zephyr/shared/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GuestApiError } from './api';

export interface Selection {
  count: number;
  sentAt: string | null;
  name: string | null;
}
export interface PhotoState {
  items: GuestPhoto[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  selection: Selection;
  loadMore: () => void;
  /** Image URLs are signed for an hour: when one fails, fetch the loaded pages again for fresh ones. */
  refreshUrls: () => Promise<void>;
  /** Local update after a favourite is toggled (the server already has it). */
  markFavourite: (id: string, on: boolean) => void;
  markSent: (name: string) => void;
  /** Fetches every remaining page (for "Download all") and returns the whole gallery. */
  loadAll: () => Promise<GuestPhoto[]>;
}

/** Wait at least this long between URL refreshes, so a broken image can't loop. */
export const REFRESH_COOLDOWN_MS = 20_000;

/**
 * Pages of a gallery's photos. `fetchPage` is the guest or preview photo route; a 401 means the unlock has
 * expired (or the passcode changed), which the caller handles by showing the passcode screen again.
 */
export function useGuestPhotos(
  fetchPage: (cursor: string | null) => Promise<GuestPhotoPage>,
  onLocked: () => void,
  now: () => number = Date.now,
): PhotoState {
  const [items, setItems] = useState<GuestPhoto[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ count: 0, sentAt: null, name: null });
  const cursors = useRef<(string | null)[]>([]);
  const nextRef = useRef<string | null | undefined>(undefined);
  const itemsRef = useRef<GuestPhoto[]>([]);
  itemsRef.current = items;
  const busy = useRef(false);
  const lastRefresh = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const cb = useRef({ fetchPage, onLocked });
  cb.current = { fetchPage, onLocked };

  const fail = useCallback((e: unknown) => {
    if (e instanceof GuestApiError && e.status === 401) cb.current.onLocked();
    else setError(e instanceof GuestApiError && e.status === 0 ? 'offline' : 'failed');
  }, []);

  const load = useCallback(
    async (cursor: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        const page = await cb.current.fetchPage(cursor);
        cursors.current.push(cursor);
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
        });
        setNext(page.nextCursor);
        nextRef.current = page.nextCursor;
        if (page.selection) setSelection(page.selection);
        setError(null);
      } catch (e) {
        fail(e);
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [fail],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: first page once
  useEffect(() => {
    void load(null);
  }, []);

  const loadMore = useCallback(() => {
    if (next) void load(next);
  }, [next, load]);

  const refreshUrls = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    if (now() - lastRefresh.current < REFRESH_COOLDOWN_MS) return Promise.resolve();
    lastRefresh.current = now();
    const run = (async () => {
      try {
        const fresh = new Map<string, GuestPhoto>();
        for (const c of cursors.current) {
          const page = await cb.current.fetchPage(c);
          for (const p of page.items) fresh.set(p.id, p);
          if (page.selection) setSelection(page.selection);
        }
        setItems((prev) => prev.filter((p) => fresh.has(p.id)).map((p) => fresh.get(p.id) as GuestPhoto));
      } catch (e) {
        fail(e);
      } finally {
        refreshing.current = null;
      }
    })();
    refreshing.current = run;
    return run;
  }, [fail, now]);

  const markFavourite = useCallback((id: string, on: boolean) => {
    let changed = false;
    setItems((prev) =>
      prev.map((p) => {
        if (p.id !== id || Boolean(p.favourite) === on) return p;
        changed = true;
        return { ...p, favourite: on };
      }),
    );
    setSelection((s) => (changed ? { ...s, count: Math.max(0, s.count + (on ? 1 : -1)) } : s));
  }, []);
  const markSent = useCallback((name: string) => {
    setSelection((s) => ({ ...s, name, sentAt: new Date().toISOString() }));
  }, []);

  const loadAll = useCallback(async () => {
    const all = new Map(itemsRef.current.map((p) => [p.id, p]));
    let cursor = nextRef.current;
    while (cursor) {
      const page = await cb.current.fetchPage(cursor);
      cursors.current.push(cursor);
      for (const p of page.items) if (!all.has(p.id)) all.set(p.id, p);
      cursor = page.nextCursor;
      nextRef.current = cursor;
    }
    const list = [...all.values()];
    setItems(list);
    setNext(null);
    return list;
  }, []);

  return {
    loadAll,
    items,
    hasMore: next !== undefined && next !== null,
    loading,
    error,
    selection,
    loadMore,
    refreshUrls,
    markFavourite,
    markSent,
  };
}
