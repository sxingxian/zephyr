/**
 * Guest images (docs/phase-5.md, Guest images): the 60-second gallery-state lookup, lazy renditions made
 * with the Images binding and stored in zephyr-shared, serving through the media host, and the safety hold
 * when Cloudflare blocks a rendition.
 */
import { RENDITIONS, type RenditionSize } from '@zephyr/shared';
import type { Context } from 'hono';
import { sendEmail } from '../email/resend';
import { safetyMatchEmail } from '../email/share-templates';
import type { Env } from '../env';
import { background, fail, logError } from '../http';
import { contentDisposition } from '../library/files';
import { fetchCached, nonce, stores } from '../library/objects';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

type Ctx = Context<HonoEnv>;

// ---- gallery state --------------------------------------------------------------------------------------
export interface GalleryState {
  id: string;
  ownerId: string;
  generation: number;
  hasPasscode: boolean;
  /** Not revoked or expired, and the owner can share. */
  serving: boolean;
  paused: boolean;
  expiresAt: string;
}
const STATE_SECONDS = 60;
const stateKey = (hashHex: string) => `https://zephyr-state.invalid/gallery/${hashHex.replace(/^\\x/, '')}`;
const cache = (): Cache | null =>
  typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;

/**
 * The gallery behind a token hash, cached for 60 seconds in this location (so a revoke or a new passcode
 * reaches media URLs already handed out within a minute). Unknown tokens are cached too (as null).
 * `fresh` skips the cache (unlock, writes).
 */
export async function galleryState(env: Env, hashPg: string, fresh = false): Promise<GalleryState | null> {
  const store = cache();
  const key = stateKey(hashPg);
  if (store && !fresh) {
    const hit = await store.match(key).catch(() => undefined);
    if (hit) return (await hit.json()) as GalleryState | null;
  }
  const state = await rpc<GalleryState | null>(env, 'guest_gallery_state', { p_token_hash: hashPg });
  if (store) {
    await store
      .put(
        key,
        new Response(JSON.stringify(state), { headers: { 'Cache-Control': `max-age=${STATE_SECONDS}` } }),
      )
      .catch(() => undefined);
  }
  return state;
}
export async function forgetState(hashPg: string): Promise<void> {
  await cache()
    ?.delete(stateKey(hashPg))
    .catch(() => undefined);
}

// ---- renditions -----------------------------------------------------------------------------------------
interface MediaPlan {
  ownerId: string;
  filename: string;
  width: number | null;
  height: number | null;
  rendition: { key: string } | null;
  unavailable?: 'pending' | 'not_allowed';
  source: { key: string; editVersion: number };
  watermark: {
    key: string;
    version: number;
    position: 'bottom-right' | 'bottom-left' | 'centre' | 'tiled';
    opacity: number;
  } | null;
  wmVersion: number;
}

/** Media responses: private browser cache, sandboxed, never sniffed. */
export function mediaHeaders(h: Headers, contentType: string, length: string | null) {
  h.set('Content-Type', contentType);
  if (length) h.set('Content-Length', length);
  h.set('Cache-Control', 'private, max-age=3600');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
}

class Unavailable extends Error {
  constructor(
    readonly status: 404 | 409 | 502 | 503,
    readonly code: 'not_found' | 'conflict' | 'server' | 'storage_full',
  ) {
    super(code);
  }
}

/** Long edge of the rendition the binding will make (for sizing the watermark). */
function outLongEdge(m: MediaPlan, size: RenditionSize): number {
  const src = Math.max(m.width ?? 0, m.height ?? 0) || (size === 'full' ? 4000 : 2048);
  const cap = RENDITIONS[size].longEdge;
  return cap ? Math.min(cap, src) : src;
}

function drawOptions(wm: NonNullable<MediaPlan['watermark']>, longEdge: number): ImageDrawOptions {
  const margin = Math.max(8, Math.round(longEdge * 0.03));
  const opacity = Math.min(0.9, Math.max(0.1, wm.opacity / 100));
  switch (wm.position) {
    case 'bottom-left':
      return { opacity, bottom: margin, left: margin };
    case 'centre':
      return { opacity };
    case 'tiled':
      return { opacity, repeat: true };
    default:
      return { opacity, bottom: margin, right: margin };
  }
}

/** Makes a rendition from the source (re-encoded; metadata stripped by the binding), stores and records it. */
async function makeRendition(
  c: Ctx,
  galleryId: string,
  photoId: string,
  size: RenditionSize,
  m: MediaPlan,
): Promise<string> {
  const { photos, shared } = stores(c.env);
  const src = await photos.get(m.source.key);
  if (!src) throw new Unavailable(404, 'not_found');
  const long = outLongEdge(m, size);
  let bytes: Uint8Array;
  try {
    let t = c.env.IMAGES.input(src.body);
    const cap = RENDITIONS[size].longEdge;
    if (cap) t = t.transform({ width: cap, height: cap, fit: 'scale-down' });
    if (m.watermark) {
      const wm = await shared.get(m.watermark.key);
      if (wm) {
        const w = Math.max(48, Math.round(long * (m.watermark.position === 'tiled' ? 0.16 : 0.22)));
        t = t.draw(
          c.env.IMAGES.input(wm.body).transform({ width: w, height: w, fit: 'scale-down' }),
          drawOptions(m.watermark, long),
        );
      }
    }
    const out = await t.output({ format: 'image/jpeg', quality: RENDITIONS[size].quality });
    bytes = new Uint8Array(await out.response().arrayBuffer());
  } catch (err) {
    logError(c.get('requestId'), 'rendition_transform', err);
    throw new Unavailable(502, 'server');
  }
  if (bytes.byteLength < 1) throw new Unavailable(502, 'server');

  const key = `o/${m.ownerId}/g/${galleryId}/${photoId}/${size}-${nonce()}`;
  await shared.put(key, bytes, { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' });
  let keep = false;
  try {
    // If this call throws, the database may have committed: the object stays (the gallery's prefix is
    // emptied when it's deleted). Otherwise anything not recorded is deleted below.
    const rec = await rpc<{ status: 'ok' | 'exists' | 'gone' | 'storage_full' | 'invalid'; key?: string }>(
      c.env,
      'record_rendition',
      {
        p_gallery: galleryId,
        p_photo: photoId,
        p_size: size,
        p_key: key,
        p_bytes: bytes.byteLength,
        p_edit_version: m.source.editVersion,
        p_wm_version: m.wmVersion,
      },
    );
    keep = rec.status === 'ok';
    if (rec.status === 'ok') return key;
    if (rec.status === 'exists' && rec.key) return rec.key;
    if (rec.status === 'storage_full') throw new Unavailable(503, 'storage_full');
    if (rec.status === 'gone') throw new Unavailable(409, 'conflict');
    throw new Unavailable(502, 'server');
  } catch (err) {
    if (err instanceof Unavailable) throw err;
    keep = true;
    throw err;
  } finally {
    if (!keep) await dropShared(c, [key]);
  }
}

async function dropShared(c: Ctx, keys: string[]) {
  const requestId = c.get('requestId');
  const env = c.env;
  await background(c, async () => {
    try {
      await stores(env).shared.delete(keys);
    } catch (err) {
      logError(requestId, 'shared_drop', err);
    }
  });
}

/**
 * Cloudflare blocked a rendition (a CSAM Scanning Tool match): hold the photo, suspend the account's sharing,
 * tell the safety team (ids only). The guest sees a plain 404.
 */
async function safetyHold(c: Ctx, galleryId: string, photoId: string, tokenHashPg: string | null) {
  try {
    const r = await rpc<{ ownerId: string; alreadyHeld: boolean } | null>(c.env, 'apply_safety_hold', {
      p_gallery: galleryId,
      p_photo: photoId,
    });
    if (tokenHashPg) await forgetState(tokenHashPg);
    if (r && !r.alreadyHeld && c.env.SAFETY_ALERT_EMAIL) {
      const requestId = c.get('requestId');
      const env = c.env;
      await background(c, async () => {
        try {
          await sendEmail(env, {
            to: env.SAFETY_ALERT_EMAIL,
            ...safetyMatchEmail({ photoId, galleryId, ownerId: r.ownerId, at: new Date() }),
            idempotencyKey: `safety-${photoId}`,
          });
        } catch (err) {
          logError(requestId, 'safety_email', err);
        }
      });
    }
  } catch (err) {
    logError(c.get('requestId'), 'safety_hold', err);
  }
}

export interface ServeOptions {
  /** web and full downloads: served as an attachment. */
  download?: boolean;
  /** For the state cache to forget a held gallery. */
  tokenHashPg?: string | null;
  /** Called once the bytes are on their way (download events). */
  onServed?: () => Promise<void>;
}

/** Serves one guest image of one photo, making the rendition first if needed. */
export async function serveRendition(
  c: Ctx,
  galleryId: string,
  photoId: string,
  size: RenditionSize,
  o: ServeOptions = {},
): Promise<Response> {
  try {
    const m = await rpc<MediaPlan | null>(c.env, 'guest_media', {
      p_gallery: galleryId,
      p_photo: photoId,
      p_size: size,
    });
    if (!m || m.unavailable) return c.json(fail('not_found'), 404);
    const key = m.rendition?.key ?? (await makeRendition(c, galleryId, photoId, size, m));
    const res = await fetchCached(c.env, key);
    if (res.status === 451) {
      await res.body?.cancel().catch(() => undefined);
      await safetyHold(c, galleryId, photoId, o.tokenHashPg ?? null);
      return c.json(fail('not_found'), 404);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      logError(c.get('requestId'), 'media_host', new Error(`status ${res.status}`));
      return c.json(fail('server'), 502);
    }
    const out = new Response(res.body, { status: 200 });
    mediaHeaders(out.headers, 'image/jpeg', res.headers.get('Content-Length'));
    if (o.download) {
      const base = m.filename.replace(/\.[^.]{1,8}$/, '').slice(0, 120) || 'photo';
      out.headers.set(
        'Content-Disposition',
        contentDisposition(`${base}${size === 'full' ? '' : '-web'}.jpg`),
      );
    }
    if (o.onServed) await o.onServed();
    return out;
  } catch (err) {
    if (err instanceof Unavailable) return c.json(fail(err.code), err.status);
    logError(c.get('requestId'), 'media', err);
    return c.json(fail('server'), 500);
  }
}

/** Serves a branding logo from zephyr-shared through the media host. */
export async function serveShared(c: Ctx, key: string, contentType: string): Promise<Response> {
  const res = await fetchCached(c.env, key);
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 404) logError(c.get('requestId'), 'media_host', new Error(`status ${res.status}`));
    return c.json(fail('not_found'), 404);
  }
  const out = new Response(res.body, { status: 200 });
  mediaHeaders(out.headers, contentType, res.headers.get('Content-Length'));
  return out;
}
