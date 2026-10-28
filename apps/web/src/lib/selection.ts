import { useCallback, useMemo, useState } from 'react';

/**
 * Shift-click range: everything between the anchor and the clicked index is added to the selection
 * (like Finder and Google Photos). Ids outside the range keep their state.
 */
export function rangeSelect(
  ids: string[],
  anchor: number,
  index: number,
  current: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  const a = Math.max(0, Math.min(anchor, index));
  const b = Math.min(ids.length - 1, Math.max(anchor, index));
  for (let i = a; i <= b; i++) {
    const id = ids[i];
    if (id !== undefined) next.add(id);
  }
  return next;
}

export interface Selection {
  selected: ReadonlySet<string>;
  selecting: boolean;
  count: number;
  setSelecting: (on: boolean) => void;
  /** Toggle one tile and make it the anchor for the next shift-click. */
  toggle: (id: string, index: number) => void;
  /** Shift-click: select from the anchor to here. */
  extend: (ids: string[], index: number) => void;
  set: (ids: Iterable<string>) => void;
  clear: () => void;
  /** Forget ids that are no longer in the list (moved to Trash, removed from the album). */
  prune: (keep: (id: string) => boolean) => void;
}

export function useSelection(alwaysOn = false): Selection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectingState, setSelectingState] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);
  const selecting = alwaysOn || selectingState || selected.size > 0;

  const toggle = useCallback((id: string, index: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    setAnchor(index);
    setSelectingState(true);
  }, []);
  const extend = useCallback(
    (ids: string[], index: number) => {
      setSelected((s) => rangeSelect(ids, anchor ?? index, index, s));
      setAnchor((a) => a ?? index);
      setSelectingState(true);
    },
    [anchor],
  );
  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
    setSelectingState(false);
  }, []);
  const set = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const prune = useCallback(
    (keep: (id: string) => boolean) =>
      setSelected((s) => {
        const n = new Set([...s].filter(keep));
        return n.size === s.size ? s : n;
      }),
    [],
  );
  const setSelecting = useCallback(
    (on: boolean) => {
      if (on) setSelectingState(true);
      else clear();
    },
    [clear],
  );

  return useMemo(
    () => ({ selected, selecting, count: selected.size, setSelecting, toggle, extend, set, clear, prune }),
    [selected, selecting, setSelecting, toggle, extend, set, clear, prune],
  );
}

// ---------------------------------------------------------------- grid keyboard movement

/** Tile rows as laid out on screen: each entry is the list of photo indexes in that visual row. */
export type GridLayout = number[][];

/**
 * Next focused index for an arrow/Home/End key. Up and Down keep the column where the next row has one
 * and otherwise land on that row's last tile (rows can be short at the end of a day).
 */
export function gridMove(layout: GridLayout, index: number, key: string): number {
  const total = layout.reduce((n, r) => n + r.length, 0);
  if (!total) return index;
  let row = -1;
  let col = -1;
  for (let r = 0; r < layout.length && row < 0; r++) {
    const c = (layout[r] ?? []).indexOf(index);
    if (c >= 0) {
      row = r;
      col = c;
    }
  }
  if (row < 0) return Math.max(0, Math.min(total - 1, index));
  switch (key) {
    case 'ArrowRight':
      return Math.min(total - 1, index + 1);
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'ArrowDown': {
      const next = layout[row + 1];
      return next?.[Math.min(col, next.length - 1)] ?? index;
    }
    case 'ArrowUp': {
      const prev = layout[row - 1];
      return prev?.[Math.min(col, prev.length - 1)] ?? index;
    }
    case 'Home':
      return 0;
    case 'End':
      return total - 1;
    default:
      return index;
  }
}
