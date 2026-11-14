/**
 * Sharing & branding settings (Studio), SHARE_API.branding and brandingAsset:
 *   GET/PUT        /api/v1/me/branding
 *   GET/PUT/DELETE /api/v1/me/branding/:kind     (logo | watermark image)
 * Uploaded images (PNG, JPEG or WEBP, at most 2 MB) are re-encoded with the Images binding to a PNG of at
 * most 512 px before they are stored, so nothing a member uploads is ever served as sent. Mounted before
 * /api/v1/me so these handlers answer first.
 */
import { brandingSchema } from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { list } from '../env';
import { background, fail, guardWrite, logError, rateLimited, readBody } from '../http';
import { actorOf, libraryContext, ownerOf, requireRole } from '../library/context';
import { nonce, stores } from '../library/objects';
import { expectedUser, readExact } from '../library/storage';
import { mediaHeaders } from '../share/media';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

export const brandingRoutes = new Hono<HonoEnv>();
type Ctx = Context<HonoEnv>;

export const BRANDING_LIMITS = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxEdge: 512,
  maxSourceEdge: 12000,
} as const;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const isAsset = (c: Ctx) => /\/(logo|watermark)$/.test(c.req.path);
const json = guardWrite((env) => list(env.APP_ORIGINS), 4 * 1024);
/** JSON guard for settings; asset PUTs need an allowed Origin and an image content type instead. */
const guard: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method !== 'PUT' || !isAsset(c)) return json(c, next);
  const origin = c.req.header('Origin');
  if (!origin || !list(c.env.APP_ORIGINS).includes(origin)) return c.json(fail('forbidden'), 403);
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!UPLOAD_TYPES.has(type)) return c.json(fail('invalid'), 415);
  await next();
};
// Phase 7: the open library's branding (a Studio team shares the owner's); galleries rights (Owner, Editor).
brandingRoutes.use('*', guard, requireMember, libraryContext, requireRole('galleries'));
brandingRoutes.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!(await c.env.SHARE_LIMITER.limit({ key: `share:${actorOf(c)}` })).success) return rateLimited(c, 60);
  return expectedUser(c, next);
});

brandingRoutes.get('/', async (c) => {
  try {
    return c.json({ ok: true, branding: await rpc(c.env, 'get_branding', { p_owner: ownerOf(c) }) });
  } catch (err) {
    logError(c.get('requestId'), 'branding_get', err);
    return c.json(fail('server'), 500);
  }
});

brandingRoutes.put('/', async (c) => {
  const body = await readBody(c, brandingSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<
      { branding: unknown } | { error: 'plan' | 'invalid' } | { error: 'in_use'; galleries: number }
    >(c.env, 'update_branding', {
      p_owner: ownerOf(c),
      p_patch: body,
    });
    if ('error' in res) {
      if (res.error === 'plan') return c.json(fail('plan_required'), 403);
      // Switching to a watermark kind with no image while live galleries show the watermark.
      if (res.error === 'in_use') return c.json(fail('asset_in_use', { galleries: res.galleries }), 409);
      return c.json(fail('invalid'), 400);
    }
    return c.json({ ok: true, branding: res.branding });
  } catch (err) {
    logError(c.get('requestId'), 'branding_put', err);
    return c.json(fail('server'), 500);
  }
});

const kindOf = (c: Ctx) => {
  const k = c.req.param('kind');
  return k === 'logo' || k === 'watermark' ? k : null;
};

/** The member's own asset, for the settings preview (never cached). */
brandingRoutes.get('/:kind', async (c) => {
  const kind = kindOf(c);
  if (!kind) return c.json(fail('not_found'), 404);
  try {
    const key = await rpc<string | null>(c.env, 'branding_asset_key', { p_owner: ownerOf(c), p_kind: kind });
    const obj = key ? await stores(c.env).shared.get(key) : null;
    if (!obj) return c.json(fail('not_found'), 404);
    const res = new Response(obj.body, { status: 200 });
    mediaHeaders(res.headers, 'image/png', String(obj.size));
    res.headers.set('Cache-Control', 'private, no-cache');
    return res;
  } catch (err) {
    logError(c.get('requestId'), 'branding_asset_get', err);
    return c.json(fail('server'), 500);
  }
});

const sniff = (b: Uint8Array): 'png' | 'jpeg' | 'webp' | null => {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  const ascii = (at: number, s: string) => [...s].every((ch, i) => b[at + i] === ch.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  return null;
};
const asStream = (b: Uint8Array) => new Response(b).body as ReadableStream<Uint8Array>;

brandingRoutes.put('/:kind', async (c) => {
  const kind = kindOf(c);
  if (!kind) return c.json(fail('not_found'), 404);
  const raw = c.req.header('Content-Length');
  if (!raw || !/^\d{1,9}$/.test(raw)) return c.json(fail('invalid'), 411);
  const len = Number(raw);
  if (len > BRANDING_LIMITS.maxUploadBytes) return c.json(fail('too_large'), 413);
  if (len < 8) return c.json(fail('invalid'), 400);
  const owner = ownerOf(c);
  try {
    const bytes = await readExact(c.req.raw.body, len);
    if (!bytes || !sniff(bytes)) return c.json(fail('invalid'), 415);
    let png: Uint8Array;
    try {
      const info = await c.env.IMAGES.info(asStream(bytes));
      if (!('width' in info) || !['image/png', 'image/jpeg', 'image/webp'].includes(info.format)) {
        return c.json(fail('invalid'), 415);
      }
      if (info.width > BRANDING_LIMITS.maxSourceEdge || info.height > BRANDING_LIMITS.maxSourceEdge) {
        return c.json(fail('invalid'), 400);
      }
      const out = await c.env.IMAGES.input(asStream(bytes))
        .transform({ width: BRANDING_LIMITS.maxEdge, height: BRANDING_LIMITS.maxEdge, fit: 'scale-down' })
        .output({ format: 'image/png' });
      png = new Uint8Array(await out.response().arrayBuffer());
    } catch (err) {
      logError(c.get('requestId'), 'branding_transform', err);
      return c.json(fail('invalid'), 415);
    }
    if (png.byteLength < 1 || png.byteLength > BRANDING_LIMITS.maxUploadBytes)
      return c.json(fail('too_large'), 413);
    const { shared } = stores(c.env);
    const key = `o/${owner}/b/${kind}-${nonce()}`;
    await shared.put(key, png, { contentType: 'image/png', cacheControl: 'public, max-age=86400' });
    let keep = false;
    try {
      const res = await rpc<{ status: 'ok' | 'storage_full' | 'plan' | 'invalid'; branding?: unknown }>(
        c.env,
        'record_branding_asset',
        { p_owner: owner, p_kind: kind, p_key: key, p_bytes: png.byteLength },
      );
      keep = res.status === 'ok';
      if (res.status === 'ok') return c.json({ ok: true, branding: res.branding });
      if (res.status === 'storage_full') return c.json(fail('storage_full'), 413);
      if (res.status === 'plan') return c.json(fail('plan_required'), 403);
      return c.json(fail('invalid'), 400);
    } catch (err) {
      keep = true; // the database may have recorded it; account purge empties o/<owner>/
      throw err;
    } finally {
      if (!keep) {
        const requestId = c.get('requestId');
        const env = c.env;
        await background(c, async () => {
          try {
            await stores(env).shared.delete([key]);
          } catch (err) {
            logError(requestId, 'branding_drop', err);
          }
        });
      }
    }
  } catch (err) {
    logError(c.get('requestId'), 'branding_asset_put', err);
    return c.json(fail('server'), 500);
  }
});

brandingRoutes.delete('/:kind', async (c) => {
  const kind = kindOf(c);
  if (!kind) return c.json(fail('not_found'), 404);
  try {
    const res = await rpc<{ branding: unknown } | { error: 'in_use'; galleries: number }>(
      c.env,
      'delete_branding_asset',
      { p_owner: ownerOf(c), p_kind: kind },
    );
    // A live gallery's watermark draws this image: removing it would leave those galleries unwatermarked.
    if ('error' in res) return c.json(fail('asset_in_use', { galleries: res.galleries }), 409);
    return c.json({ ok: true, branding: res.branding });
  } catch (err) {
    logError(c.get('requestId'), 'branding_asset_delete', err);
    return c.json(fail('server'), 500);
  }
});
