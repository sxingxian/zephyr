/**
 * Ads for Free members (docs/phase-8.md › Ads, MEMBER8_API):
 *   GET  /api/v1/ads                      session; cards live now plus the AdSense config, only when the effective
 *                                         plan has `ads` (ads_for_member) and the open library is the member's own
 *   POST /api/v1/ads/events               session; an impression or click, counted per card/day/placement only,
 *                                         at most one of each per member, card and day, and only for members
 *                                         who are shown ads (ad_event)
 *   POST /api/v1/ads/reset                no session, same-origin only: Clear-Site-Data "cache", "storage" and the
 *                                         AdSense cookie cleared (before the app reloads off Google's script)
 *   GET  /api/v1/ads/cards/:id/image?v=   public, immutable (the URL carries the image version)
 *   GET  /api/v1/ads/config-public        public: { enabled, publisherId } for the app Worker (CSP, ads.txt),
 *                                         cached 15 s in the isolate (the Worker caches it 60 s more)
 * GET /ads also sets the AdSense cookie (ADS_DOC_COOKIE) when AdSense is returned and clears it otherwise: the app
 * Worker widens the CSP only for documents whose request carries it.
 * ADS_LIMITER: 120 a minute per member on the first two, and per client network on the public ones (the app
 * Worker's own config fetch carries no client address and is bounded by the isolate cache). A team library never
 * shows ads.
 */
import {
  ADS_DOC_COOKIE,
  ADS_DOC_COOKIE_MAX_AGE,
  type AdPlacement,
  type AdsResult,
  adEventSchema,
  LIBRARY_HEADER,
  MEMBER8_API,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { except } from 'hono/combine';
import { hmac, toPgBytea } from '../crypto';
import { list } from '../env';
import { clientIp, clientNetwork, fail, guardWrite, logError, rateLimited, readBody } from '../http';
import { stores } from '../library/objects';
import { mediaHeaders } from '../share/media';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

export const adsRoutes = new Hono<HonoEnv>();
type Ctx = Context<HonoEnv>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY: AdsResult = { ok: true, cards: [], adsense: null };
/** GET /api/v1/ads/config-public (the app Worker's CSP variant and ads.txt). */
export interface AdsPublicConfig {
  ok: true;
  enabled: boolean;
  publisherId: string | null;
}

interface MemberAds {
  cards: {
    id: string;
    advertiser: string;
    headline: string;
    body: string;
    url: string;
    imageVersion: number | null;
    placements: AdPlacement[];
    weight: number;
  }[];
  adsense: AdsResult['adsense'];
}

/** The open library is the member's own (no header, or the header names them). */
const ownLibrary = (c: Ctx) => {
  const h = c.req.header(LIBRARY_HEADER);
  return !h || h.toLowerCase() === c.get('session').userId;
};

const isImage = (c: Ctx) => c.req.method === 'GET' && /\/cards\/[^/]+\/image$/.test(c.req.path);
const isPublicConfig = (c: Ctx) => c.req.method === 'GET' && c.req.path.endsWith('/ads/config-public');
const isReset = (c: Ctx) => c.req.method === 'POST' && c.req.path.endsWith('/ads/reset');
const isPublic = (c: Ctx) => isImage(c) || isPublicConfig(c) || isReset(c);
const PUBLISHER_ID = /^ca-pub-\d{16}$/;
const json = guardWrite((env) => list(env.APP_ORIGINS), 1024);
const adsLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!(await c.env.ADS_LIMITER.limit({ key: `ads:${c.get('session').userId}` })).success)
    return rateLimited(c, 60);
  await next();
};
/** Public endpoints: per client network. Requests with no client address come from the app Worker itself. */
const publicLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (clientIp(c) && !(await c.env.ADS_LIMITER.limit({ key: `adspub:${clientNetwork(c)}` })).success)
    return rateLimited(c, 60);
  await next();
};
// The image, the public AdSense switch and the reset need no session; everything else needs a member.
adsRoutes.use('*', except(isPublic, json, requireMember, adsLimit));
adsRoutes.use('*', async (c, next) => (isPublic(c) ? publicLimit(c, next) : next()));

// ---------------------------------------------------------------- AdSense cookie
/** The cookie the app Worker looks for before it widens a document's CSP (HttpOnly: page script can't read it). */
export function adsDocCookie(on: boolean): string {
  return `${ADS_DOC_COOKIE}=${on ? '1' : ''}; Path=/; Max-Age=${on ? ADS_DOC_COOKIE_MAX_AGE : 0}; HttpOnly; Secure; SameSite=Strict`;
}
const sendAdsCookie = (c: Ctx, on: boolean) => c.header('Set-Cookie', adsDocCookie(on), { append: true });

/**
 * Before the app reloads off Google's AdSense script (the member it was loaded for is gone, changed or lost ads):
 * drop everything the script could have written to this origin (Cache Storage, local and session storage,
 * IndexedDB, the service worker) and the AdSense cookie. Same-origin only (the write guard), so another site
 * can't wipe a member's storage; no session needed, since it runs after one ended too.
 */
adsRoutes.post('/reset', json, async (c) => {
  c.header('Clear-Site-Data', '"cache", "storage"');
  sendAdsCookie(c, false);
  return c.body(null, 204);
});

// ---------------------------------------------------------------- public config cache (per isolate)
/** Short, so turning AdSense off reaches the app Worker's 60 s cache quickly (≤ 75 s in all for new pages). */
export const ADS_CONFIG_TTL_MS = 15_000;
const ADS_CONFIG_FAIL_TTL_MS = 10_000;
let configCache: { at: number; ttl: number; value: AdsPublicConfig; ok: boolean } | null = null;
/** Forget the cached public config (after an AdSense change in this isolate, and in tests). */
export function resetAdsConfigCache(): void {
  configCache = null;
}

/**
 * For the app Worker (service binding): whether to serve the AdSense CSP variant and ads.txt. Public data only:
 * on only when AdSense is enabled and a valid publisher id is set. Fails closed (off) if the database can't answer.
 */
adsRoutes.get('/config-public', async (c) => {
  const headers = { 'Cache-Control': 'public, max-age=15' };
  const now = Date.now();
  if (configCache && now - configCache.at < configCache.ttl)
    return c.json(configCache.value, 200, configCache.ok ? headers : { 'Cache-Control': 'no-store' });
  try {
    const cfg = await rpc<{ enabled?: unknown; publisherId?: unknown } | null>(c.env, 'adsense_public', {});
    const id =
      typeof cfg?.publisherId === 'string' && PUBLISHER_ID.test(cfg.publisherId) ? cfg.publisherId : null;
    const enabled = cfg?.enabled === true && id !== null;
    const value: AdsPublicConfig = { ok: true, enabled, publisherId: enabled ? id : null };
    configCache = { at: now, ttl: ADS_CONFIG_TTL_MS, value, ok: true };
    return c.json(value, 200, headers);
  } catch (err) {
    logError(c.get('requestId'), 'adsense_public', err);
    const value: AdsPublicConfig = { ok: true, enabled: false, publisherId: null };
    configCache = { at: now, ttl: ADS_CONFIG_FAIL_TTL_MS, value, ok: false };
    return c.json(value, 200, { 'Cache-Control': 'no-store' });
  }
});

adsRoutes.get('/', async (c) => {
  // The AdSense cookie follows the answer: set only when AdSense is returned, cleared otherwise.
  if (!ownLibrary(c)) {
    sendAdsCookie(c, false);
    return c.json(EMPTY);
  }
  try {
    const out = await rpc<MemberAds | null>(c.env, 'ads_for_member', { p_user: c.get('session').userId });
    sendAdsCookie(c, Boolean(out?.adsense));
    if (!out) return c.json(EMPTY);
    return c.json({
      ok: true,
      cards: (out.cards ?? []).map(({ imageVersion, ...card }) => ({
        ...card,
        imageUrl: imageVersion ? MEMBER8_API.adImage(card.id, imageVersion) : null,
      })),
      adsense: out.adsense ?? null,
    } satisfies AdsResult);
  } catch (err) {
    logError(c.get('requestId'), 'ads_for_member', err);
    sendAdsCookie(c, false);
    return c.json(EMPTY);
  }
});

adsRoutes.post('/events', async (c) => {
  const body = await readBody(c, adEventSchema);
  if (!body) return c.json(fail('invalid'), 400);
  // The database counts per card, day and placement only, and ignores cards that aren't live. The member id is
  // passed only to check they're shown ads; `p_seen` (a keyed hash of member, UTC day, card and kind) lets each
  // member count one impression and one click per card a day without storing the member id. It's pseudonymous,
  // not anonymous: whoever holds AD_DEDUP_SECRET and the database could recompute it for a given member, so its
  // rows are deleted after two days and never joined to the stats. Team libraries never show ads, so their
  // events aren't counted.
  if (!ownLibrary(c)) return c.body(null, 204);
  try {
    const userId = c.get('session').userId;
    const day = new Date().toISOString().slice(0, 10);
    const seen = toPgBytea(
      await hmac(`ad:${userId}|${day}|${body.cardId.toLowerCase()}|${body.kind}`, c.env.AD_DEDUP_SECRET),
    );
    await rpc(c.env, 'ad_event', {
      p_user: userId,
      p_seen: seen,
      p_card: body.cardId,
      p_kind: body.kind,
      p_placement: body.placement,
    });
  } catch (err) {
    logError(c.get('requestId'), 'ad_event', err);
  }
  return c.body(null, 204);
});

adsRoutes.get('/cards/:id/image', async (c) => {
  const id = (c.req.param('id') ?? '').toLowerCase();
  const v = c.req.query('v') ?? '';
  if (!UUID.test(id) || !/^[1-9]\d{0,8}$/.test(v)) return c.json(fail('not_found'), 404);
  try {
    const key = await rpc<string | null>(c.env, 'ad_image_key', { p_card: id, p_version: Number(v) });
    if (typeof key !== 'string' || !key.startsWith('ads/')) return c.json(fail('not_found'), 404);
    const obj = await stores(c.env).shared.get(key);
    if (!obj) return c.json(fail('not_found'), 404);
    const h = new Headers();
    mediaHeaders(h, 'image/jpeg', String(obj.size));
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(obj.body, 200, Object.fromEntries(h));
  } catch (err) {
    logError(c.get('requestId'), 'ad_image', err);
    return c.json(fail('server'), 500);
  }
});
