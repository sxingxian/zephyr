/** Date and photo-setting formatting for the library (British-style day-month, like the mockups). */

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const day = (i: number) => DAYS[i] ?? '';
const month = (i: number) => MONTHS[i] ?? '';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface WallTime {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  min: number;
}

/**
 * The wall-clock time a photo was taken, as the camera recorded it ("15:42 in Singapore" stays 15:42 when
 * viewed from London). Falls back to the browser's local time for timestamps without an offset.
 */
export function wallTime(iso: string): WallTime | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m && /([+-]\d{2}:\d{2})$/.test(iso)) {
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
    return { y, m: mo, d, h, min: mi };
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), min: t.getMinutes() };
}

/** The day a photo belongs to in the grid: date taken (wall clock), else date added (local). */
export function dayKey(iso: string): string {
  const w = wallTime(iso);
  return w ? `${w.y}-${pad(w.m)}-${pad(w.d)}` : 'unknown';
}

/** "Today", "Yesterday", "Saturday, 24 Oct", or "Saturday, 24 Oct 2025" for other years. */
export function dayLabel(key: string, now = new Date()): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Date unknown';
  const [y, mo, d] = m.slice(1, 4).map(Number) as [number, number, number];
  const date = new Date(y, mo - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const base = `${day(date.getDay())}, ${d} ${month(mo - 1)}`;
  return y === now.getFullYear() ? base : `${base} ${y}`;
}

/** "Sat 24 Oct 2026, 15:42" (for the info panel). */
export function longDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const w = wallTime(iso);
  if (!w) return null;
  const date = new Date(w.y, w.m - 1, w.d);
  return `${day(date.getDay()).slice(0, 3)} ${w.d} ${month(w.m - 1)} ${w.y}, ${pad(w.h)}:${pad(w.min)}`;
}
/** "Sat 24 Oct, 15:42" (viewer header). */
export function shortDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const w = wallTime(iso);
  if (!w) return null;
  const date = new Date(w.y, w.m - 1, w.d);
  return `${day(date.getDay()).slice(0, 3)} ${w.d} ${month(w.m - 1)}, ${pad(w.h)}:${pad(w.min)}`;
}
/** "Today, 09:12", "Yesterday, 18:03" or "12 Oct 2026, 09:12" in local time (upload times). */
export function relativeDateTime(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const label = dayLabel(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, now);
  if (label === 'Today' || label === 'Yesterday') return `${label}, ${time}`;
  return `${t.getDate()} ${month(t.getMonth())} ${t.getFullYear()}, ${time}`;
}
/** "27 Nov" or "27 Nov 2027" for deadlines. */
export function shortDate(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const base = `${t.getDate()} ${month(t.getMonth())}`;
  return t.getFullYear() === now.getFullYear() ? base : `${base} ${t.getFullYear()}`;
}

/** Whole days left until `iso` (rounded up, never below 0). */
export function daysLeft(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

/** "1/500 s", "0.8 s", "30 s". */
export function exposure(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds >= 1) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  const inv = 1 / seconds;
  if (inv >= 1.5) return `1/${Math.round(inv)} s`;
  return `${seconds.toFixed(1)} s`;
}

/** Camera make and model without the brand repeated ("Canon Canon EOS R6" → "Canon EOS R6"). */
export function cameraName(make?: string, model?: string): string | null {
  if (!make && !model) return null;
  if (!make) return model ?? null;
  if (!model) return make;
  const first = (make.split(/\s+/)[0] ?? '').toLowerCase();
  return model.toLowerCase().startsWith(first) ? model : `${make} ${model}`;
}

/** "ETA" phrase for the upload tray. */
export function etaText(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 50) return 'less than a minute left';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'} left`;
  const h = Math.round(m / 60);
  return `about ${h} hour${h === 1 ? '' : 's'} left`;
}
