/**
 * /admin/api/v1/ads/* (docs/phase-8.md › Ads). Sponsored cards and the AdSense config for Free members.
 *
 *   GET    /ads                     ads
 *   POST   /ads/cards               ads
 *   PATCH  /ads/cards/:id           ads
 *   DELETE /ads/cards/:id           ads
 *   PUT    /ads/cards/:id/image     ads (PNG, JPEG or WEBP ≤ 5 MB; re-encoded to a 1200 × 628 JPEG in SHARED)
 *   PATCH  /ads/adsense             adsense (Owner). Anything but turning it off: passkey + Owners emailed.
 *
 * Card URLs are https only (adUrlSchema). Uploaded images are never served as sent: the Images binding
 * re-encodes them, which also strips metadata.
 */
import {
  AD_LIMITS,
  type AdminAdsResult,
  adminAdCardPatchSchema,
  adminAdCardSchema,
  adminAdsensePatchSchema,
} from '@zephyr/shared';
import type { MiddlewareHandler } from 'hono';
import { list } from '../env';
import { background, fail, logError, readBody } from '../http';
import { nonce, stores } from '../library/objects';
import { readExact } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import {
  type AdminRouter,
  adminWriteLimit,
  type Ctx,
  can,
  dbError,
  idParam,
  isDbError,
  needsReauth,
  type RequireStaff,
  reauth,
  serverError,
  staffId,
  tellOwners,
} from './admin-common';
import { resetAdsConfigCache } from './ads';
import { asStream, sniff } from './branding';

export const AD_IMAGE = { width: 1200, height: 628, maxSourceEdge: 12000, prefix: 'ads/' } as const;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The one admin write that isn't JSON. admin.ts uses this in place of the JSON guard for it. */
export const isAdImageUpload = (method: string, path: string) =>
  method === 'PUT' && /\/v1\/ads\/cards\/[^/]+\/image$/.test(path);

/** Allowed admin Origin and an image content type (the JSON guard's job for every other write). */
export const adImageGuard: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin || !list(c.env.ADMIN_ORIGINS).includes(origin)) return c.json(fail('forbidden'), 403);
  const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!UPLOAD_TYPES.has(type)) return c.json(fail('invalid'), 415);
  await next();
};

async function adsView(c: Ctx) {
  const out = await rpc<Omit<AdminAdsResult, 'ok'>>(c.env, 'admin_ads', { p_staff: staffId(c) });
  if (isDbError(out)) return dbError(c, out);
  return c.json({ ok: true, ...out } satisfies AdminAdsResult);
}

const dropShared = (c: Ctx, keys: (string | null | undefined)[]) => {
  const ks = keys.filter((k): k is string => typeof k === 'string' && k.startsWith(AD_IMAGE.prefix));
  if (!ks.length) return Promise.resolve();
  const env = c.env;
  const requestId = c.get('requestId');
  return background(c, async () => {
    try {
      await stores(env).shared.delete(ks);
    } catch (err) {
      logError(requestId, 'ad_image_drop', err);
    }
  });
};

export function registerAdminAdsRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/ads/*', requireStaff(), adminWriteLimit);

  router.get('/v1/ads', can('ads'), async (c) => {
    try {
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'admin_ads', err);
    }
  });

  router.post('/v1/ads/cards', can('ads'), async (c) => {
    const body = await readBody(c, adminAdCardSchema);
    if (!body) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<unknown>(c.env, 'admin_ad_card_save', {
        p_staff: staffId(c),
        p_id: null,
        p_card: body,
      });
      if (isDbError(out)) return dbError(c, out);
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'admin_ad_card_save', err);
    }
  });

  router.patch('/v1/ads/cards/:id', can('ads'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminAdCardPatchSchema);
    if (!body || Object.keys(body).length === 0) return c.json(fail('invalid'), 400);
    if (body.startsAt && body.endsAt && body.startsAt >= body.endsAt) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<unknown>(c.env, 'admin_ad_card_save', {
        p_staff: staffId(c),
        p_id: id,
        p_card: body,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null) return c.json(fail('not_found'), 404);
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'admin_ad_card_save', err);
    }
  });

  router.delete('/v1/ads/cards/:id', can('ads'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    try {
      const out = await rpc<{ imageKey: string | null } | null>(c.env, 'admin_ad_card_delete', {
        p_staff: staffId(c),
        p_id: id,
      });
      if (isDbError(out)) return dbError(c, out);
      if (!out) return c.json(fail('not_found'), 404);
      await dropShared(c, [out.imageKey]);
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'admin_ad_card_delete', err);
    }
  });

  router.put('/v1/ads/cards/:id/image', can('ads'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const raw = c.req.header('Content-Length');
    if (!raw || !/^\d{1,9}$/.test(raw)) return c.json(fail('invalid'), 411);
    const len = Number(raw);
    if (len > AD_LIMITS.imageBytes) return c.json(fail('too_large'), 413);
    if (len < 8) return c.json(fail('invalid'), 400);
    let key: string | null = null;
    let keep = false;
    try {
      const bytes = await readExact(c.req.raw.body, len);
      if (!bytes || !sniff(bytes)) return c.json(fail('invalid'), 415);
      let jpeg: Uint8Array;
      try {
        const info = await c.env.IMAGES.info(asStream(bytes));
        if (!('width' in info) || !UPLOAD_TYPES.has(info.format)) return c.json(fail('invalid'), 415);
        if (info.width > AD_IMAGE.maxSourceEdge || info.height > AD_IMAGE.maxSourceEdge) {
          return c.json(fail('invalid'), 400);
        }
        const out = await c.env.IMAGES.input(asStream(bytes))
          .transform({ width: AD_IMAGE.width, height: AD_IMAGE.height, fit: 'cover' })
          .output({ format: 'image/jpeg', quality: 85 });
        jpeg = new Uint8Array(await out.response().arrayBuffer());
      } catch (err) {
        logError(c.get('requestId'), 'ad_image_transform', err);
        return c.json(fail('invalid'), 415);
      }
      if (jpeg.byteLength < 1 || jpeg.byteLength > AD_LIMITS.imageBytes)
        return c.json(fail('too_large'), 413);
      key = `${AD_IMAGE.prefix}${id}/${nonce()}.jpg`;
      await stores(c.env).shared.put(key, jpeg, {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      try {
        const out = await rpc<{ version: number; oldKey: string | null } | null>(
          c.env,
          'admin_ad_image_set',
          {
            p_staff: staffId(c),
            p_id: id,
            p_key: key,
          },
        );
        if (isDbError(out)) return dbError(c, out);
        if (!out) return c.json(fail('not_found'), 404);
        keep = true;
        await dropShared(c, [out.oldKey]);
      } catch (err) {
        keep = true; // the database may have recorded it
        throw err;
      }
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'ad_image_put', err);
    } finally {
      if (key && !keep) await dropShared(c, [key]);
    }
  });

  router.patch('/v1/ads/adsense', can('adsense'), async (c) => {
    const body = await readBody(c, adminAdsensePatchSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { reason, ...patch } = body;
    const changed = Object.keys(patch);
    if (!changed.length) return c.json(fail('invalid'), 400);
    // Turning it off is the only change that lowers risk. Anything else (on, a new publisher id or slots, which
    // redirect where the ads and their revenue go) is high-risk.
    const offOnly = changed.length === 1 && patch.enabled === false;
    if (!offOnly && needsReauth(c)) return reauth(c);
    try {
      const out = await rpc<{ enabled: boolean; changed?: boolean } | null>(c.env, 'admin_adsense_set', {
        p_staff: staffId(c),
        p_patch: patch,
        p_reason: reason,
      });
      if (isDbError(out)) return dbError(c, out);
      // A no-op (already on, the same id and slots) writes nothing and emails no one.
      if (out?.changed === false) return await adsView(c);
      resetAdsConfigCache();
      if (!offOnly) await tellOwners(c, { kind: 'adsense', enabled: out?.enabled === true, changed }, reason);
      return await adsView(c);
    } catch (err) {
      return serverError(c, 'admin_adsense_set', err);
    }
  });
}
