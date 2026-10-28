import type { PhotoItem } from '@zephyr/shared/client';
import { Icon, type IconName } from '@zephyr/ui';
import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useState } from 'react';

// ---------------------------------------------------------------- segmented control
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="seg">
      <legend className="z-sr">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className="seg__btn">
          <input
            type="radio"
            className="z-sr"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

export function SortSelect<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="sort">
      <span>Sort</span>
      <select className="sort__select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Library search with a clear button. The parent debounces. */
export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <search className="search">
      <Icon name="search" size={17} className="search__icon" />
      <input
        type="search"
        className="search__input"
        aria-label="Search photos by file name or camera"
        placeholder="Search file names and cameras"
        value={value}
        maxLength={100}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="search__clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <Icon name="x" size={15} />
        </button>
      )}
    </search>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------- selection toolbar
export interface BarAction {
  icon: IconName;
  label: string;
  onClick?: () => void;
  /** Shown but not usable yet. */
  soon?: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  /** Tooltip when disabled. */
  hint?: string;
}

export function SelectionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: BarAction[];
  onClear: () => void;
}) {
  return (
    <div
      className={`selbar${actions.length > 7 ? ' selbar--dense' : ''}`}
      role="toolbar"
      aria-label="Selection actions"
    >
      <span className="selbar__count" aria-live="polite">
        {count === 0 ? 'Select photos' : `${count.toLocaleString('en')} selected`}
      </span>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className={`selbar__btn${a.danger ? ' selbar__btn--danger' : ''}${a.soon ? ' selbar__btn--soon' : ''}`}
          onClick={a.onClick}
          disabled={Boolean(a.soon) || count === 0 || a.busy || a.disabled}
          aria-busy={a.busy || undefined}
          title={a.soon ?? (a.disabled ? a.hint : undefined) ?? a.label}
          aria-label={a.soon ? `${a.label} (${a.soon.toLowerCase()})` : a.label}
        >
          <Icon name={a.icon} size={15} />
          <span className="selbar__label">{a.label}</span>
          {a.soon && <span className="selbar__soon">Soon</span>}
        </button>
      ))}
      <span className="selbar__spacer" />
      <button type="button" className="selbar__close" aria-label="Clear selection" onClick={onClear}>
        <Icon name="x" size={17} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- viewer list (grid → viewer)
export interface ViewerList {
  items: PhotoItem[];
  hasMore: boolean;
  loadMore: () => void;
  /** Where Back goes, e.g. "Library" or the album name. */
  backLabel: string;
  /** Known total, when the page knows it (the whole library). */
  total?: number;
}
interface HostCtx {
  list: ViewerList | null;
  setList: (l: ViewerList | null) => void;
  returnId: string | null;
  setReturnId: (id: string | null) => void;
}
const Host = createContext<HostCtx>({ list: null, setList: () => {}, returnId: null, setReturnId: () => {} });

export function ViewerHostProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ViewerList | null>(null);
  const [returnId, setReturnId] = useState<string | null>(null);
  const v = useMemo(() => ({ list, setList, returnId, setReturnId }), [list, returnId]);
  return <Host.Provider value={v}>{children}</Host.Provider>;
}
export function useViewerHost(): HostCtx {
  return useContext(Host);
}
/** A grid page shares its loaded photos with the viewer, for prev/next and the filmstrip. */
export function useShareWithViewer(list: ViewerList): void {
  const { setList } = useViewerHost();
  const { items, hasMore, loadMore, backLabel, total } = list;
  useEffect(() => {
    setList({ items, hasMore, loadMore, backLabel, total });
  }, [items, hasMore, loadMore, backLabel, total, setList]);
  useEffect(() => () => setList(null), [setList]);
}
