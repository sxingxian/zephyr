import { FILE_TYPES, type FileTypeId, type Usage } from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';
import { fetchUsage } from './library';

let current: Usage | null = null;

function isUsage(u: unknown): u is Usage {
  const x = u as Partial<Usage> | null;
  return Boolean(
    x &&
      typeof x.usedBytes === 'number' &&
      typeof x.limitBytes === 'number' &&
      typeof x.photoCount === 'number' &&
      Array.isArray(x.fileTypes),
  );
}
let inflight: Promise<void> | null = null;
let stale = true;
const subs = new Set<() => void>();

function set(u: Usage | null) {
  current = u;
  for (const s of subs) s();
}

/** Re-reads /me/usage (after uploads, Trash changes and so on). Concurrent calls share one request. */
export function refreshUsage(): Promise<void> {
  stale = false;
  inflight ??= fetchUsage()
    .then((u) => {
      if (!isUsage(u)) throw new Error('unexpected usage response');
      set(u);
    })
    .catch(() => {
      stale = true;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
export function getUsage(): Usage | null {
  return current;
}
/** Forget the cached usage (sign-out, account switch). */
export function resetUsage(): void {
  stale = true;
  set(null);
}

/** Current usage; fetched on first use and shared by every component. */
export function useUsage(): Usage | null {
  const u = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
    () => current,
  );
  useEffect(() => {
    if (stale) void refreshUsage();
  }, []);
  return u;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** 1,000-based sizes, like file managers on macOS and phones: "28.4 MB", "3.1 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 1 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits).replace(/\.0$/, '')} ${UNITS[i]}`;
}
/** "3.1 of 5 GB" with the unit chosen from the limit. */
export function formatOf(used: number, limit: number): string {
  const unit = limit >= 1e12 ? 1e12 : limit >= 1e9 ? 1e9 : 1e6;
  const name = unit === 1e12 ? 'TB' : unit === 1e9 ? 'GB' : 'MB';
  const f = (x: number) => {
    const v = x / unit;
    return v >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString('en') : v.toFixed(1);
  };
  return `${f(used)} of ${f(limit)} ${name}`;
}

/** File picker `accept` value for the plan's file types (extensions plus MIME types). */
export function acceptFor(types: FileTypeId[]): string {
  const parts = new Set<string>();
  for (const t of types) {
    const ft = FILE_TYPES[t];
    if (!ft) continue;
    for (const e of ft.exts) parts.add(`.${e}`);
    if (!ft.raw) parts.add(ft.mime);
  }
  return [...parts].join(',');
}

/** "JPEG, PNG and WEBP up to 50 MB on Free · RAW on Pro" for the drop overlay and empty state. */
export function uploadRulesLine(u: Usage | null): string {
  if (!u) return 'JPEG, PNG and WEBP · RAW (CR2, NEF, ARW) on Pro';
  const plain = u.fileTypes.filter((t) => !FILE_TYPES[t]?.raw).map((t) => FILE_TYPES[t].label);
  const raw = u.fileTypes.some((t) => FILE_TYPES[t]?.raw);
  const list =
    plain.length > 1 ? `${plain.slice(0, -1).join(', ')} and ${plain[plain.length - 1]}` : (plain[0] ?? '');
  const plan = u.plan === 'free' ? 'Free' : u.plan === 'pro' ? 'Pro' : 'Studio';
  const size = `up to ${formatBytes(u.maxFileBytes)}`;
  if (raw) return `${list}${list ? ' and ' : ''}RAW (CR2, NEF, ARW) ${size} on ${plan}`;
  return `${list} ${size} on ${plan} · RAW on Pro`;
}
