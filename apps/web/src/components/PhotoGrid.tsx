import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { FILE_TYPES, type PhotoItem, type PhotoListQuery } from '@zephyr/shared/client';
import { Icon, Spinner } from '@zephyr/ui';
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { dayKey, dayLabel, daysLeft } from '../lib/format';
import { editKey, thumbUrl } from '../lib/library';
import { sortTime } from '../lib/photos';
import { type GridLayout, gridMove, type Selection } from '../lib/selection';

type Row =
  | { kind: 'head'; key: string; label: string; count: number; first: number }
  | { kind: 'tiles'; key: string; indexes: number[] }
  | { kind: 'ad'; key: string; slot: number };

/** Phase 8: a Free member's library grid shows an ad after the first 24 tiles, then every 48. */
export const AD_FIRST = 24;
export const AD_EVERY = 48;

interface Metrics {
  cols: number;
  gap: number;
  tileH: number;
  headH: number;
  phone: boolean;
}
function metricsFor(width: number, phone: boolean): Metrics {
  if (phone) {
    const gap = 2;
    const cols = width >= 540 ? 4 : 3;
    const tile = (width - gap * (cols - 1)) / cols;
    return { cols, gap, tileH: Math.round(tile), headH: 48, phone };
  }
  const gap = 6;
  const min = 180;
  const cols = Math.max(2, Math.floor((width + gap) / (min + gap)));
  const tile = (width - gap * (cols - 1)) / cols;
  return { cols, gap, tileH: Math.round((tile * 3) / 4), headH: 54, phone };
}

/** Day groups (date taken, else date added) flattened into header and tile rows. */
export function buildRows(
  items: PhotoItem[],
  sort: PhotoListQuery['sort'],
  cols: number,
  grouped = true,
  ads = false,
): Row[] {
  const rows: Row[] = [];
  let tiles = 0;
  let nextAd = AD_FIRST;
  let slot = 0;
  const keyAt = (k: number) => {
    const p = items[k];
    return p ? dayKey(sortTime(p, sort)) : '';
  };
  let i = 0;
  while (i < items.length) {
    const key = grouped ? keyAt(i) : 'all';
    let j = i;
    while (j < items.length && (!grouped || keyAt(j) === key)) j++;
    if (grouped)
      rows.push({ kind: 'head', key: `h:${key}:${i}`, label: dayLabel(key), count: j - i, first: i });
    for (let k = i; k < j; k += cols) {
      const indexes: number[] = [];
      for (let x = k; x < Math.min(j, k + cols); x++) indexes.push(x);
      rows.push({ kind: 'tiles', key: `t:${k}`, indexes });
      tiles += indexes.length;
      // Only between rows: never after the last tile.
      if (ads && tiles >= nextAd && tiles < items.length) {
        rows.push({ kind: 'ad', key: `a:${slot}`, slot });
        slot++;
        nextAd += AD_EVERY;
      }
    }
    i = j;
  }
  return rows;
}

function usePhone() {
  const q = '(max-width: 860px)';
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(q);
    const h = () => setPhone(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return phone;
}

export interface PhotoGridProps {
  items: PhotoItem[];
  sort?: PhotoListQuery['sort'];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  selection: Selection;
  /** Open a photo (not called in Trash, where tiles only select). */
  onOpen?: (index: number) => void;
  trash?: boolean;
  grouped?: boolean;
  /** Photo to focus when coming back from the viewer. */
  focusId?: string | null;
  label: string;
  /** Phase 8: renders the ad in an ad row (rows are only added when this is given). */
  renderAd?: (slot: number) => ReactNode;
}

/** Virtualised photo grid grouped by day, with sticky day headers, selection and keyboard support. */
export function PhotoGrid({
  items,
  sort,
  hasMore,
  loading,
  loadMore,
  selection,
  onOpen,
  trash,
  grouped = true,
  focusId,
  label,
  renderAd,
}: PhotoGridProps) {
  const wrap = useRef<HTMLElement>(null);
  const phone = usePhone();
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const [topbar, setTopbar] = useState(0);
  const [focus, setFocus] = useState(0);
  const pendingFocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setMargin(el.getBoundingClientRect().top + window.scrollY);
      const tb = document.querySelector<HTMLElement>('.topbar');
      setTopbar(tb ? tb.getBoundingClientRect().height : 0);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const tb = document.querySelector<HTMLElement>('.topbar');
    if (tb) ro.observe(tb);
    return () => ro.disconnect();
  }, []);

  const m = metricsFor(width || 900, phone);
  const withAds = Boolean(renderAd) && !trash;
  const rows = useMemo(
    () => buildRows(items, sort, m.cols, grouped, withAds),
    [items, sort, m.cols, grouped, withAds],
  );
  const adH = m.phone ? 132 : 156;
  const layout: GridLayout = useMemo(
    () => rows.flatMap((r) => (r.kind === 'tiles' ? [r.indexes] : [])),
    [rows],
  );
  const rowOf = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach((r, ri) => {
      if (r.kind === 'tiles') for (const i of r.indexes) map.set(i, ri);
    });
    return map;
  }, [rows]);
  const size = useCallback(
    (i: number) => {
      const k = rows[i]?.kind;
      return k === 'head' ? m.headH : k === 'ad' ? adH + m.gap : m.tileH + m.gap;
    },
    [rows, m.headH, m.tileH, m.gap, adH],
  );
  const starts = useMemo(() => {
    const s: number[] = [];
    let acc = 0;
    for (let i = 0; i < rows.length; i++) {
      s.push(acc);
      acc += size(i);
    }
    return s;
  }, [rows, size]);

  const v = useWindowVirtualizer({
    count: rows.length,
    estimateSize: size,
    overscan: 6,
    scrollMargin: margin,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row sizes change
  useEffect(() => {
    v.measure();
  }, [m.tileH, m.headH, rows.length]);

  const virtual = v.getVirtualItems();
  // Load the next page when the last rows come into view.
  useEffect(() => {
    const last = virtual[virtual.length - 1];
    if (last && hasMore && !loading && last.index >= rows.length - 4) loadMore();
  }, [virtual, hasMore, loading, rows.length, loadMore]);

  // Sticky day header: the group whose header has scrolled under the top bar (and selection bar).
  const selbar = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('.selbar') : null;
  const stickyTop = topbar + (selbar ? selbar.getBoundingClientRect().height + 8 : 0);
  const top = (v.scrollOffset ?? 0) - margin + stickyTop;
  let sticky: Extract<Row, { kind: 'head' }> | null = null;
  if (grouped) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const at = starts[i] ?? 0;
      if (!r || at > top) break;
      if (r.kind === 'head') sticky = at < top - 1 ? r : null;
    }
  }

  const ids = useMemo(() => items.map((p) => p.id), [items]);
  const selecting = selection.selecting || Boolean(trash);

  const focusTile = useCallback(
    (i: number) => {
      const n = Math.max(0, Math.min(items.length - 1, i));
      setFocus(n);
      const ri = rowOf.get(n);
      if (ri !== undefined) v.scrollToIndex(ri, { align: 'auto' });
      pendingFocus.current = n;
    },
    [items.length, rowOf, v],
  );
  // Move DOM focus once the target tile is rendered.
  useEffect(() => {
    const n = pendingFocus.current;
    if (n === null) return;
    const el = wrap.current?.querySelector<HTMLElement>(`[data-index="${n}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });
  // Back from the viewer: focus the photo that was open.
  useEffect(() => {
    if (!focusId) return;
    const i = ids.indexOf(focusId);
    if (i >= 0) focusTile(i);
  }, [focusId, ids, focusTile]);

  useEffect(() => {
    if (focus > items.length - 1) setFocus(Math.max(0, items.length - 1));
  }, [focus, items.length]);

  // Touch: long-press starts selecting.
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(
    null,
  );
  const longPressed = useRef(false);
  const onPointerDown = (e: PointerEvent, id: string, i: number) => {
    if (e.pointerType !== 'touch') return;
    longPressed.current = false;
    const t = setTimeout(() => {
      longPressed.current = true;
      if (!selection.selected.has(id)) selection.toggle(id, i);
      navigator.vibrate?.(8);
    }, 450);
    press.current = { t, x: e.clientX, y: e.clientY, fired: false };
  };
  const cancelPress = (e?: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (e && e.type === 'pointermove' && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 10) return;
    clearTimeout(p.t);
    press.current = null;
  };

  const onTileClick = (e: MouseEvent, i: number) => {
    const id = ids[i];
    if (id === undefined) return;
    setFocus(i);
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    if (e.shiftKey) return selection.extend(ids, i);
    if (selecting || e.metaKey || e.ctrlKey) return selection.toggle(id, i);
    onOpen?.(i);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const idx = Number(target.dataset.index);
    if (Number.isNaN(idx)) return;
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const n = gridMove(layout, idx, e.key);
      if (e.shiftKey && n !== idx) selection.extend(ids, n);
      focusTile(n);
      if (n >= items.length - m.cols * 2 && hasMore) loadMore();
    } else if (e.key === ' ') {
      e.preventDefault();
      const id = ids[idx];
      if (id !== undefined) selection.toggle(id, idx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const id = ids[idx];
      if (trash && id !== undefined) selection.toggle(id, idx);
      else if (!trash) onOpen?.(idx);
    } else if (e.key === 'Escape' && selection.count > 0) {
      e.preventDefault();
      selection.clear();
    }
  };

  return (
    <section
      ref={wrap}
      className={`pgrid${phone ? ' pgrid--phone' : ''}`}
      aria-label={label}
      aria-describedby="pgrid-help"
      onKeyDown={onKeyDown}
    >
      <p id="pgrid-help" className="z-sr">
        Arrow keys move between photos. Enter opens a photo, Space selects it, Shift with arrows or click
        selects a range.
      </p>
      {sticky && (
        <div
          className="pgrid__sticky"
          style={{ height: m.headH, marginBottom: -m.headH, top: stickyTop }}
          aria-hidden="true"
        >
          <h2 className="pgrid__day">{sticky.label}</h2>
        </div>
      )}
      <div className="pgrid__body" style={{ height: v.getTotalSize() }}>
        {virtual.map((vr) => {
          const r = rows[vr.index];
          const y = vr.start - margin;
          if (!r) return null;
          if (r.kind === 'ad') {
            return (
              <div key={r.key} className="pgrid__ad" style={{ transform: `translateY(${y}px)`, height: adH }}>
                {renderAd?.(r.slot)}
              </div>
            );
          }
          if (r.kind === 'head') {
            const all = ids.slice(r.first, r.first + r.count);
            const allOn = all.every((id) => selection.selected.has(id));
            return (
              <div
                key={r.key}
                className="pgrid__head"
                style={{ transform: `translateY(${y}px)`, height: m.headH }}
              >
                <h2 className="pgrid__day">{r.label}</h2>
                <span className="pgrid__count">
                  {r.count} photo{r.count === 1 ? '' : 's'}
                </span>
                {selecting && (
                  <button
                    type="button"
                    className="pgrid__dayselect"
                    onClick={() =>
                      selection.set(
                        allOn
                          ? [...selection.selected].filter((id) => !all.includes(id))
                          : [...selection.selected, ...all],
                      )
                    }
                  >
                    {allOn ? 'Deselect day' : 'Select day'}
                  </button>
                )}
              </div>
            );
          }
          return (
            <div
              key={r.key}
              className="pgrid__row"
              style={{
                transform: `translateY(${y}px)`,
                height: m.tileH,
                gridTemplateColumns: `repeat(${m.cols}, minmax(0, 1fr))`,
                gap: m.gap,
              }}
            >
              {r.indexes.map((i) => {
                const p = items[i];
                if (!p) return null;
                const sel = selection.selected.has(p.id);
                return (
                  <Tile
                    key={p.id}
                    photo={p}
                    index={i}
                    focused={i === focus}
                    selected={sel}
                    selecting={selecting}
                    trash={trash}
                    onClick={onTileClick}
                    onPointerDown={onPointerDown}
                    onPointerEnd={cancelPress}
                    onContextMenu={(e) => {
                      // Long-press on touch selects; don't also open the browser's image menu.
                      if (press.current || longPressed.current) e.preventDefault();
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {loading && (
        <div className="pgrid__more" aria-live="polite">
          <Spinner size={18} label="Loading photos" />
        </div>
      )}
    </section>
  );
}

function Tile({
  photo: p,
  index,
  focused,
  selected,
  selecting,
  trash,
  onClick,
  onPointerDown,
  onPointerEnd,
  onContextMenu,
}: {
  photo: PhotoItem;
  index: number;
  focused: boolean;
  selected: boolean;
  selecting: boolean;
  trash?: boolean;
  onClick: (e: MouseEvent, i: number) => void;
  onPointerDown: (e: PointerEvent, id: string, i: number) => void;
  onPointerEnd: (e?: PointerEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const raw = FILE_TYPES[p.fileType]?.raw;
  const days = trash ? daysLeft(p.purgeAt) : 0;
  const name = `${p.filename}${p.edit ? ', edited' : ''}${p.favourite ? ', favourite' : ''}${selected ? ', selected' : ''}`;
  return (
    <button
      type="button"
      className={`tile${selected ? ' tile--sel' : ''}${selecting ? ' tile--selecting' : ''}`}
      data-index={index}
      tabIndex={focused ? 0 : -1}
      aria-label={trash || selecting ? name : `Open ${name}`}
      aria-pressed={selecting ? selected : undefined}
      onClick={(e) => onClick(e, index)}
      onPointerDown={(e) => onPointerDown(e, p.id, index)}
      onPointerUp={() => onPointerEnd()}
      onPointerCancel={() => onPointerEnd()}
      onPointerMove={(e) => onPointerEnd(e)}
      onContextMenu={onContextMenu}
    >
      <span className="tile__img">
        {p.hasThumb ? (
          <img
            src={thumbUrl(p.id, editKey(p))}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={loaded ? 'is-loaded' : undefined}
            onLoad={() => setLoaded(true)}
          />
        ) : (
          <Icon name="image" size={22} />
        )}
      </span>
      {selecting && (
        <span className="tile__check" aria-hidden="true">
          {selected && <Icon name="check" size={14} />}
        </span>
      )}
      {p.favourite && !trash && (
        <span className="tile__fav" aria-hidden="true">
          <Icon name="heart" size={16} />
        </span>
      )}
      {p.edit && !trash && (
        <span
          className={`tile__edited${p.edit.rendered ? '' : ' tile__edited--pending'}`}
          title={p.edit.rendered ? 'Edited' : 'Edited · thumbnail updating'}
          aria-hidden="true"
        >
          <Icon name="sliders" size={12} />
        </span>
      )}
      {trash ? (
        <span className={`tile__days${days <= 2 ? ' tile__days--warn' : ''}`}>
          <span className="tile__days-long">{days === 1 ? '1 day left' : `${days} days left`}</span>
          <span className="tile__days-short">{days}d</span>
        </span>
      ) : (
        raw && <span className="tile__raw">RAW</span>
      )}
    </button>
  );
}
