import { FILE_TYPES, type PhotoItem, type PhotoListQuery } from '@zephyr/shared/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { onLibrary } from './bus';
import { listPhotos } from './library';

export const PAGE_SIZE = 120;

/** The time a photo sorts and groups by. */
export const sortTime = (p: PhotoItem, sort: PhotoListQuery['sort']) =>
  sort === 'added' ? p.createdAt : (p.takenAt ?? p.createdAt);

/** Newest first, ties by id (the server's keyset order). */
export function comparePhotos(a: PhotoItem, b: PhotoItem, sort: PhotoListQuery['sort']): number {
  const ta = new Date(sortTime(a, sort)).getTime();
  const tb = new Date(sortTime(b, sort)).getTime();
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether a newly uploaded photo belongs in a list (search results are left to the server). */
export function matchesQuery(p: PhotoItem, q: PhotoListQuery): boolean {
  if (q.q || q.albumId || q.from || q.to) return false;
  switch (q.view ?? 'library') {
    case 'library':
      return !p.trashedAt;
    case 'favourites':
      return p.favourite && !p.trashedAt;
    case 'raw':
      return FILE_TYPES[p.fileType]?.raw === true && !p.trashedAt;
    default:
      return false;
  }
}

export interface PhotoList {
  items: PhotoItem[];
  hasMore: boolean;
  loading: boolean;
  /** True until the first page has arrived. */
  initial: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
  remove: (ids: string[]) => void;
}

/** Keyset-paginated photo list that stays in step with uploads, favourites and Trash moves. */
export function usePhotoList(query: PhotoListQuery): PhotoList {
  const key = JSON.stringify(query);
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const q = useRef(query);
  q.current = query;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;

  const fetchPage = useCallback(async (after: string | null) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    try {
      const page = await listPhotos({ ...q.current, cursor: after ?? undefined, limit: PAGE_SIZE }, c.signal);
      if (c.signal.aborted) return;
      const got = Array.isArray(page?.items) ? page.items : [];
      const next = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
      setItems((prev) => {
        const base = after ? prev : [];
        const seen = new Set(base.map((p) => p.id));
        return [...base, ...got.filter((p) => !seen.has(p.id))];
      });
      setCursor(next);
      setHasMore(Boolean(next));
      setInitial(false);
    } catch (e) {
      if (c.signal.aborted || (e as Error).name === 'AbortError') return;
      setError(errorMessage(e));
      setInitial(false);
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch whenever the query (by value) changes
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(false);
    setInitial(true);
    void fetchPage(null);
    return () => ctrl.current?.abort();
  }, [key, fetchPage]);

  useEffect(
    () =>
      onLibrary((e) => {
        const cur = q.current;
        if (e.type === 'added') {
          if (!matchesQuery(e.photo, cur)) return;
          setItems((prev) => {
            if (prev.some((p) => p.id === e.photo.id)) return prev;
            const next = [...prev, e.photo].sort((a, b) => comparePhotos(a, b, cur.sort));
            // Only keep it if it falls inside what's loaded; otherwise a later page brings it.
            const last = prev[prev.length - 1];
            if (hasMoreRef.current && last && comparePhotos(e.photo, last, cur.sort) > 0) return prev;
            return next;
          });
        } else if (e.type === 'updated') {
          const byId = new Map(e.photos.map((p) => [p.id, p]));
          setItems((prev) =>
            prev
              .map((p) => (byId.has(p.id) ? { ...p, ...byId.get(p.id) } : p))
              .filter((p) => (cur.view === 'favourites' && byId.has(p.id) ? p.favourite : true)),
          );
        } else if (e.type === 'removed') {
          const gone = new Set(e.ids);
          setItems((prev) => prev.filter((p) => !gone.has(p.id)));
        }
      }),
    [],
  );
  const loadMore = useCallback(() => {
    if (!loading && cursor) void fetchPage(cursor);
  }, [loading, cursor, fetchPage]);
  const reload = useCallback(() => void fetchPage(null), [fetchPage]);
  const remove = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((p) => !gone.has(p.id)));
  }, []);

  return { items, hasMore, loading, initial, error, loadMore, reload, remove };
}
