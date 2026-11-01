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

export async function classifyImageFailure(url: string, f: typeof fetch = fetch): Promise<ImageProblem> {
  let res: Response;
  try {
    res = await f(url, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    return 'error';
  }
  if (res.ok) {
    // It loads now (a rendition finished between the two requests).
    await res.body?.cancel().catch(() => undefined);
    return 'pending';
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (isPendingBody(res.status, body)) return 'pending';
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) return 'expired';
  return 'error';
}

function isPendingBody(status: number, body: Record<string, unknown> | null): boolean {
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
