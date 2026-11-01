/**
 * What to do when a guest image fails to load. An <img> can't see the response, so the failed URL is asked
 * once more with fetch to learn why:
 * - `pending`: the server is still preparing that size (an edit not rendered yet, a watermark not set up,
 *   storage full on the photographer's side, a rendition being made). Show "Preparing" and try again later.
 * - `expired`: the signed URL ran out (401/403) or the photo is gone (404 with no pending marker): fetch the
 *   page of URLs again, which also drops removed photos.
 * - `error`: anything else (offline, 5xx): treated like pending, with the same slow retries.
 */
export type ImageProblem = 'pending' | 'expired' | 'error';
/** A probe result: the problem, and how long the server asked us to wait (Retry-After), if it said. */
export interface ImageFailure {
  problem: ImageProblem;
  retryAfterMs: number | null;
}

export async function classifyImageFailure(url: string, f: typeof fetch = fetch): Promise<ImageProblem> {
  return (await probeImageFailure(url, f)).problem;
}

export async function probeImageFailure(url: string, f: typeof fetch = fetch): Promise<ImageFailure> {
  let res: Response;
  try {
    res = await f(url, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    return { problem: 'error', retryAfterMs: null };
  }
  if (res.ok) {
    // It loads now (a rendition finished between the two requests).
    await res.body?.cancel().catch(() => undefined);
    return { problem: 'pending', retryAfterMs: null };
  }
  const retryAfterMs = retryAfter(res.headers.get('Retry-After'));
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (isPendingBody(res.status, body)) return { problem: 'pending', retryAfterMs };
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410)
    return { problem: 'expired', retryAfterMs: null };
  return { problem: 'error', retryAfterMs };
}

/** Retry-After in seconds (the only form the API sends), as milliseconds; null when absent or unusable. */
function retryAfter(header: string | null): number | null {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

/** The first wait honours the server's Retry-After, kept between 5 seconds and 2 minutes. */
export function firstPendingDelay(retryAfterMs: number | null): number | null {
  if (retryAfterMs === null) return null;
  return Math.min(120_000, Math.max(5_000, retryAfterMs));
}

function isPendingBody(status: number, body: Record<string, unknown> | null): boolean {
  // The API answers 503 {error:'pending'} with Retry-After (older builds used 425).
  if (status === 425) return true;
  const error = typeof body?.error === 'string' ? body.error : null;
  if (body?.unavailable === 'pending' || error === 'pending' || body?.pending === true) return true;
  // Storage full on the photographer's side and a rendition race are both "not yet", never the guest's fault.
  if (error === 'storage_full' || (status === 409 && error === 'conflict')) return true;
  return false;
}

/** Retry delays for a pending image: 5 s, 10 s, 20 s, 40 s, 80 s, then every 2 min, about 5 minutes in all. */
export const PENDING_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000];
export const PENDING_GIVE_UP_MS = 5 * 60_000;

/** The delay before the next try, or null to stop (with ±20% jitter so many tiles don't retry together). */
export function nextPendingDelay(
  attempt: number,
  elapsedMs: number,
  random: () => number = Math.random,
): number | null {
  if (elapsedMs >= PENDING_GIVE_UP_MS) return null;
  const base = PENDING_DELAYS_MS[Math.min(attempt, PENDING_DELAYS_MS.length - 1)] as number;
  const jittered = Math.round(base * (0.8 + random() * 0.4));
  return Math.min(jittered, PENDING_GIVE_UP_MS - elapsedMs);
}

/** At most this many failure probes run at once, so a page of failing tiles can't flood the API. */
const MAX_PROBES = 3;
let running = 0;
const waiting: (() => void)[] = [];
export async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PROBES) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** A single download, fetched rather than navigated to so a not-ready size never saves an error page. */
export type DownloadResult =
  | { kind: 'file'; blob: Blob; name: string }
  | { kind: 'pending'; retryAfterMs: number | null }
  | { kind: 'expired' }
  | { kind: 'error' };

/**
 * Fetches a signed download URL with the same flags the link would use (same-origin credentials, no
 * referrer). One GET is both the probe and the download: a HEAD first would make the server render and
 * count the photo twice. The file name comes from the server's Content-Disposition, never from the page.
 */
export async function fetchDownload(url: string, f: typeof fetch = fetch): Promise<DownloadResult> {
  let res: Response;
  try {
    res = await f(url, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    return { kind: 'error' };
  }
  if (res.ok) {
    try {
      const blob = await res.blob();
      return { kind: 'file', blob, name: filenameFromDisposition(res.headers.get('Content-Disposition')) };
    } catch {
      return { kind: 'error' };
    }
  }
  const retryAfterMs = retryAfter(res.headers.get('Retry-After'));
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (isPendingBody(res.status, body)) return { kind: 'pending', retryAfterMs };
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410)
    return { kind: 'expired' };
  return { kind: 'error' };
}

/** The server's file name (RFC 6266 filename*, then filename), reduced to a safe base name. */
export function filenameFromDisposition(header: string | null): string {
  let name = '';
  const star = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      name = decodeURIComponent(star.trim());
    } catch {
      name = '';
    }
  }
  if (!name) name = header?.match(/filename\s*=\s*"([^"]*)"/i)?.[1] ?? '';
  // No paths, no control characters: the browser sanitises too, but don't rely on it.
  name = name
    .replace(/[/\\]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 200) : 'photo.jpg';
}
