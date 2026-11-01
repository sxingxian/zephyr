import {
  type GuestGalleryInfo,
  type GuestPhotoPage,
  type GuestReportBody,
  type GuestSendBody,
  type GuestUnlockBody,
  SHARE_API,
  TURNSTILE_ACTIONS,
} from '@zephyr/shared/client';
import type { GuestRoute } from './route';

/** Turnstile actions for the passcode form and the report form; the API checks them on every token. */
export const GUEST_UNLOCK_ACTION = TURNSTILE_ACTIONS.galleryUnlock;
export const GUEST_REPORT_ACTION = TURNSTILE_ACTIONS.galleryReport;

/** A failed call: the HTTP status, the contract's error code and whatever else the body carried. */
export class GuestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> | null,
    readonly retryAfter: number | null,
  ) {
    super(code);
    this.name = 'GuestApiError';
  }
}

type Source = Exclude<GuestRoute, { kind: 'bad' }>;

async function call<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers:
        method === 'GET'
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(init.body ?? {}),
    });
  } catch {
    throw new GuestApiError(0, 'network', null, null);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) return body as T;
  const code = typeof body?.error === 'string' ? body.error : String(res.status);
  const header = Number(res.headers.get('retry-after'));
  const retry =
    Number.isFinite(header) && header > 0
      ? header
      : typeof body?.retryAfter === 'number'
        ? body.retryAfter
        : null;
  throw new GuestApiError(res.status, code, body, retry);
}

/**
 * The owner's preview reads the same shapes through member routes (session cookie, no passcode). Image URLs
 * always come from the responses, so no media path is built here.
 */
export function getInfo(src: Source): Promise<GuestGalleryInfo> {
  return call(src.kind === 'token' ? SHARE_API.guest(src.token) : SHARE_API.galleryPreview(src.galleryId));
}
export function getPhotos(src: Source, cursor: string | null): Promise<GuestPhotoPage> {
  const base =
    src.kind === 'token' ? SHARE_API.guestPhotos(src.token) : SHARE_API.galleryPreviewPhotos(src.galleryId);
  return call(cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base);
}
export function unlock(token: string, body: GuestUnlockBody): Promise<{ ok: true }> {
  return call(SHARE_API.guestUnlock(token), { method: 'POST', body });
}
export function setFavourite(token: string, photoId: string, on: boolean): Promise<void> {
  return call(SHARE_API.guestFavourite(token, photoId), { method: on ? 'PUT' : 'DELETE' });
}
export function sendFavourites(token: string, body: GuestSendBody): Promise<{ ok: true }> {
  return call(SHARE_API.guestSend(token), { method: 'POST', body });
}
/** Report a gallery (or one photo in it). Works before unlocking: the link is enough. */
export function reportGallery(token: string, body: GuestReportBody): Promise<{ ok: true }> {
  return call(SHARE_API.guestReport(token), { method: 'POST', body });
}
