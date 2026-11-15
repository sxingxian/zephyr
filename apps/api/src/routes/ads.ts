/**
 * Ads for Free members (docs/phase-8.md › Ads, MEMBER8_API):
 *   GET  /api/v1/ads                      session; cards live now plus the AdSense config, only when the effective
 *                                         plan has `ads` (ads_for_member) and the open library is the member's own
 *   POST /api/v1/ads/events               session; an impression or click, counted per card/day/placement only,
 *                                         at most one of each per member, card and day, and only for members
 *                                         who are shown ads (ad_event)
 *   GET  /api/v1/ads/cards/:id/image?v=   public, immutable (the URL carries the image version)
 *   GET  /api/v1/ads/config-public        public: { enabled, publisherId } for the app Worker (CSP, ads.txt),
 *                                         cached 60 s in the isolate
 * ADS_LIMITER: 120 a minute per member on the first two, and per client network on the two public ones (the app
 * Worker's own config fetch carries no client address and is bounded by the isolate cache). A team library never
 * shows ads.
 */
import { type AdPlacement, type AdsResult, adEventSchema, LIBRARY_HEADER, MEMBER8_API } from '@zephyr/shared';
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
const isPublic = (c: Ctx) => isImage(c) || isPublicConfig(c);
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
// The image and the public AdSense switch need no session; everything else needs a member.
adsRoutes.use('*', except(isPublic, json, requireMember, adsLimit));
adsRoutes.use('*', async (c, next) => (isPublic(c) ? publicLimit(c, next) : next()));

// ---------------------------------------------------------------- public config cache (per isolate)
export const ADS_CONFIG_TTL_MS = 60_000;
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
  const headers = { 'Cache-Control': 'public, max-age=60' };
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
  if (!ownLibrary(c)) return c.json(EMPTY);
  try {
    const out = await rpc<MemberAds | null>(c.env, 'ads_for_member', { p_user: c.get('session').userId });
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
    return c.json(EMPTY);
  }
});

adsRoutes.post('/events', async (c) => {
  const body = await readBody(c, adEventSchema);
  if (!body) return c.json(fail('invalid'), 400);
  // The database counts per card, day and placement only, and ignores cards that aren't live. The member id is
  // passed only to check they're shown ads; `p_seen` (a keyed hash of member, UTC day, card and kind) lets each
  // member count one impression and one click per card a day, without storing who. Team libraries never show
  // ads, so their events aren't counted.
  if (!ownLibrary(c)) return c.body(null, 204);
  try {
    const userId = c.get('session').userId;
    const day = new Date().toISOString().slice(0, 10);
    const seen = toPgBytea(
      await hmac(`ad:${userId}|${day}|${body.cardId.toLowerCase()}|${body.kind}`, c.env.IP_HASH_SECRET),
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
