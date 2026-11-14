import type { LibrarySummary } from '@zephyr/shared/client';
import { Dialog, Icon } from '@zephyr/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { PLAN_NAME } from '../lib/billing';
import { switchLibrary, useActiveLibrary, useLibraries } from '../lib/libraryContext';
import { useUploads } from '../lib/uploads';
import { ConfirmDialog } from './ai/AiBits';

const ROLE = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' } as const;

/** "Your library · Free plan" / "Team · Editor · Studio plan". */
export function librarySub(l: LibrarySummary, self: boolean): string {
  return self
    ? `Your library · ${PLAN_NAME[l.plan]} plan`
    : `Team · ${ROLE[l.role]} · ${PLAN_NAME[l.plan]} plan`;
}
/** Sidebar caption under the name: "Your library", "Team · Editor". */
function roleLine(l: LibrarySummary, self: boolean): string {
  return self ? 'Your library' : `Team · ${ROLE[l.role]}`;
}

function Mono({ l, team, size = 30 }: { l: LibrarySummary; team: boolean; size?: number }) {
  return (
    <span
      className={`libsw__mono${team ? ' libsw__mono--team' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {l.initials.slice(0, 2)}
    </span>
  );
}

/** Shared state for both switchers: the list, the choice, and the "stop uploads?" confirmation. */
function useSwitch() {
  const libs = useLibraries();
  const active = useActiveLibrary();
  const up = useUploads();
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const meId = libs?.[0]?.ownerId ?? null;
  const choose = (ownerId: string) => {
    if (ownerId === (active.ownerId ?? meId)) return false;
    if (up.busy) {
      setConfirmFor(ownerId);
      return true;
    }
    void switchLibrary(ownerId);
    return true;
  };
  const confirm = (
    <ConfirmDialog
      open={confirmFor !== null}
      title="Stop uploads and switch?"
      confirm="Stop uploads and switch"
      danger
      onClose={() => setConfirmFor(null)}
      onConfirm={() => {
        if (confirmFor) void switchLibrary(confirmFor);
      }}
    >
      <p>Photos still uploading to this library will stop. You can add them again after switching back.</p>
    </ConfirmDialog>
  );
  return { libs, active, meId, choose, confirm };
}

/**
 * Sidebar library switcher (desktop and tablet). Shown only when the member has more than one library, so
 * members without a team never see it.
 */
export function LibrarySwitcher() {
  const { libs, active, meId, choose, confirm } = useSwitch();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>('.libsw__btn')?.focus();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    wrap.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!libs || (libs.length < 2 && active.self)) return null;
  const cur = active.summary ?? libs[0];
  if (!cur) return null;
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next?.focus();
  };
  return (
    <div className="libsw" ref={wrap}>
      <button
        type="button"
        className="libsw__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Switch library: ${cur.name}, ${roleLine(cur, active.self)}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Mono l={cur} team={!active.self} />
        <span className="libsw__text">
          <span className="libsw__name">{cur.name}</span>
          <span className="libsw__role">{roleLine(cur, active.self)}</span>
        </span>
        <Icon name="chevD" size={16} />
      </button>
      {open && (
        <div
          className="libsw__menu"
          role="menu"
          id={menuId}
          aria-label="Switch library"
          tabIndex={-1}
          onKeyDown={onKey}
        >
          {libs.map((l) => {
            const self = l.ownerId === meId;
            const sel = l.ownerId === cur.ownerId;
            return (
              <button
                key={l.ownerId}
                type="button"
                role="menuitemradio"
                aria-checked={sel}
                className={`libsw__item${sel ? ' is-on' : ''}`}
                onClick={() => {
                  setOpen(false);
                  choose(l.ownerId);
                }}
              >
                <Mono l={l} team={!self} size={32} />
                <span className="libsw__text">
                  <span className="libsw__name">{l.name}</span>
                  <span className="libsw__role">{librarySub(l, self)}</span>
                </span>
                {sel && <Icon name="check" size={16} className="libsw__check" />}
              </button>
            );
          })}
          <span className="libsw__sep" aria-hidden="true" />
          <span className="libsw__note">
            Each library keeps its own photos, galleries and credits. Switching reloads Zephyr.
          </span>
        </div>
      )}
      {confirm}
    </div>
  );
}

/** Phone: a compact button in the top bar that opens a "Switch library" sheet. */
export function PhoneLibrarySwitcher() {
  const { libs, active, meId, choose, confirm } = useSwitch();
  const [open, setOpen] = useState(false);
  const name = useId();
  if (!libs || (libs.length < 2 && active.self)) return null;
  const cur = active.summary ?? libs[0];
  if (!cur) return null;
  return (
    <>
      <button
        type="button"
        className="libsw-phone"
        aria-haspopup="dialog"
        aria-label={`Switch library: ${cur.name}`}
        onClick={() => setOpen(true)}
      >
        <Mono l={cur} team={!active.self} size={28} />
        <Icon name="chevD" size={14} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Switch library">
        <fieldset className="libsw-sheet">
          <legend className="z-sr">Library</legend>
          {libs.map((l) => {
            const self = l.ownerId === meId;
            const sel = l.ownerId === cur.ownerId;
            return (
              <label key={l.ownerId} className={`libsw-sheet__item${sel ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  className="z-sr"
                  name={name}
                  value={l.ownerId}
                  checked={sel}
                  onChange={() => {
                    if (choose(l.ownerId)) setOpen(false);
                  }}
                />
                <Mono l={l} team={!self} size={36} />
                <span className="libsw__text">
                  <span className="libsw__name">{l.name}</span>
                  <span className="libsw__role">{librarySub(l, self)}</span>
                </span>
                {sel && <Icon name="check" size={18} className="libsw__check" />}
              </label>
            );
          })}
          <p className="z-hint">Each library keeps its own photos, galleries and credits.</p>
        </fieldset>
      </Dialog>
      {confirm}
    </>
  );
}
