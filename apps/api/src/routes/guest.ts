/**
 * Guest routes (no account; the gallery link token is the capability), docs/phase-5.md:
 *   GET    /api/v1/g/:token                       GuestGalleryInfo
 *   POST   /api/v1/g/:token/unlock                passcode → unlock cookie
 *   GET    /api/v1/g/:token/photos                GuestPhotoPage (after unlock)
 *   PUT    /api/v1/g/:token/favourites/:photoId   favourite · DELETE unfavourite
 *   POST   /api/v1/g/:token/favourites/send       send favourites to the owner
 *   POST   /api/v1/g/:token/report                report the gallery (link only, Turnstile)
 *   GET    /api/v1/g/:token/m/:photoId/:size      signed media: grid | view | web | full
 *   GET    /api/v1/g/:token/brand/logo            signed logo
 * Unknown tokens, ended galleries and anything not allowed get the same 404. Every response is
 * no-referrer; everything but media is no-store.
 */
import {
  GALLERY_TOKEN_RE,
  type GuestGalleryInfo,
  type GuestPhoto,
  type GuestPhotoPage,
  guestReportSchema,
  guestSendSchema,
  guestUnlockSchema,
  PASSCODE_LIMITS,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { sendEmail } from '../email/resend';
import { favouritesSentEmail, galleryPausedEmail, safetyReportEmail } from '../email/share-templates';
import { list } from '../env';
import {
  background,
  clientIp,
  clientNetwork,
  customerNetworkHash,
  fail,
  guardWrite,
  logError,
  networkHash,
  rateLimited,
  readBody,
} from '../http';
import { UUID } from '../library/storage';
import { deviceOf, placeOf } from '../share/device';
import { type GalleryState, galleryState, serveRendition, serveShared } from '../share/media';
import {
  GUEST_ID_COOKIE,
  guestIdHash,
  type MediaSize,
  mediaExpiry,
  mediaQuery,
  mediaSignatureOk,
  newGuestId,
  passcodeMatches,
  tokenHash,
  unlockCookie,
  unlockCookieName,
  unlocked,
  validGuestId,
} from '../share/signing';
import { rpc } from '../supabase';
import { TURNSTILE_ACTIONS, verifyTurnstile } from '../turnstile';
import type { HonoEnv } from '../types';

export const guestRoutes = new Hono<HonoEnv>();
type Ctx = Context<HonoEnv>;

const notFound = (c: Ctx) => c.json(fail('not_found'), 404);
const GUEST_PAGE = 60;

// Same-origin writes only (the guest page is on the app host), JSON bodies, small.
guestRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS), 4 * 1024),
);

/** Per-network limits: JSON calls (GUEST_LIMITER, ~60 a minute) and media (MEDIA_LIMITER). */
const limit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const media = /\/(m|brand)\//.test(c.req.path);
  const limiter = media ? c.env.MEDIA_LIMITER : c.env.GUEST_LIMITER;
  if (!(await limiter.limit({ key: `${media ? 'gm' : 'g'}:${clientNetwork(c)}` })).success)
    return rateLimited(c, 60);
  await next();
};
guestRoutes.use('/:token/*', limit);
guestRoutes.use('/:token', limit);

interface Resolved {
  state: GalleryState;
  hash: string;
  token: string;
}
/** The gallery behind the path's token, or null (malformed, unknown, or data gone). */
async function resolve(c: Ctx, fresh = false): Promise<Resolved | null> {
  const token = c.req.param('token') ?? '';
  if (!GALLERY_TOKEN_RE.test(token)) return null;
  const hash = await tokenHash(token);
  const state = await galleryState(c.env, hash, fresh);
  return state ? { state, hash, token } : null;
}
const isUnlocked = async (c: Ctx, s: GalleryState) =>
  !s.hasPasscode || (await unlocked(c.env, getCookie(c, unlockCookieName(s.id)), s.id, s.generation));

async function logEvent(
  c: Ctx,
  galleryId: string,
  kind: 'opened' | 'unlocked' | 'downloaded' | 'wrong_passcode',
  count = 1,
) {
  const requestId = c.get('requestId');
  const env = c.env;
  const place = placeOf(c);
  const device = deviceOf(c.req.header('User-Agent'));
  await background(c, async () => {
    try {
      await rpc(env, 'gallery_event', {
        p_gallery: galleryId,
        p_kind: kind,
        p_place: place,
        p_device: device,
        p_count: count,
      });
    } catch (err) {
      logError(requestId, 'gallery_event', err);
    }
  });
}

async function emailLater(c: Ctx, where: string, send: () => Promise<void>) {
  const requestId = c.get('requestId');
  await background(c, async () => {
    try {
      await send();
    } catch (err) {
      logError(requestId, where, err);
    }
  });
}

// ---- info -------------------------------------------------------------------------------------------------
interface InfoRow {
  id: string;
  generation: number;
  state: GuestGalleryInfo['state'];
  name: string;
  message: string | null;
  photoCount: number;
  expiresAt: string;
  downloads: GuestGalleryInfo['downloads'];
  favourites: boolean;
  brand: { studioName: string; accent: string | null; hasLogo: boolean };
  turnstile: boolean;
  pausedUntil: string | null;
}

/** GuestGalleryInfo from the database row: locked and ended pages show only what they need. */
export async function infoBody(
  c: Ctx,
  row: InfoRow,
  open: boolean,
  logoPath: ((q: string) => string) | null,
): Promise<GuestGalleryInfo> {
  const state = row.state === 'ended' ? 'ended' : open ? 'open' : row.state;
  const visible = state === 'open';
  const exp = mediaExpiry();
  const logoUrl =
    row.brand.hasLogo && logoPath && state !== 'ended'
      ? logoPath(await mediaQuery(c.env, row.id, 'logo', 'logo', row.generation, exp))
      : null;
  return {
    ok: true,
    state,
    // An ended link names neither the gallery nor its owner (the database blanks them too).
    name: state === 'ended' ? '' : row.name,
    brand:
      state === 'ended'
        ? { studioName: '', accent: null, logoUrl: null }
        : { studioName: row.brand.studioName, accent: row.brand.accent, logoUrl },
    photoCount: visible ? row.photoCount : 0,
    expiresAt: row.expiresAt,
    downloads: row.downloads,
    favourites: row.favourites,
    message: visible ? row.message : null,
    turnstile: row.turnstile,
    ...(row.pausedUntil && state === 'paused' ? { pausedUntil: row.pausedUntil } : {}),
  };
}

guestRoutes.get('/:token', async (c) => {
  try {
    const token = c.req.param('token');
    if (!GALLERY_TOKEN_RE.test(token)) return notFound(c);
    const row = await rpc<(InfoRow & { ownerId: string }) | null>(c.env, 'guest_gallery_info', {
      p_token_hash: await tokenHash(token),
      p_network: await networkHash(c),
    });
    if (!row) return notFound(c);
    const open =
      row.state === 'open' ||
      (row.state !== 'ended' &&
        (await unlocked(c.env, getCookie(c, unlockCookieName(row.id)), row.id, row.generation)));
    if (open && row.state !== 'ended') await logEvent(c, row.id, 'opened');
    return c.json(await infoBody(c, row, open, (q) => `/api/v1/g/${token}/brand/logo${q}`));
  } catch (err) {
    logError(c.get('requestId'), 'guest_info', err);
    return c.json(fail('server'), 500);
  }
});

// ---- unlock -----------------------------------------------------------------------------------------------
type Reserve =
  | {
      status: 'ok';
      attemptId: number;
      hmac: string;
      generation: number;
      pausedNow: boolean;
      networkAttempts: number;
      ownerEmail?: string | null;
      name?: string | null;
    }
  | { status: 'turnstile' }
  | { status: 'open' }
  | { status: 'ended' }
  | { status: 'limited'; retryAfter: number }
  | { status: 'paused'; pausedUntil: string };

guestRoutes.post('/:token/unlock', async (c) => {
  const body = await readBody(c, guestUnlockSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const r = await resolve(c, true);
    if (!r?.state.serving) return notFound(c);
    const { state } = r;
    // A token, when sent, must be valid for this form; one is required from the 3rd attempt (reserve says).
    let human = false;
    if (body.turnstileToken) {
      human = await verifyTurnstile(c.env, body.turnstileToken, clientIp(c), TURNSTILE_ACTIONS.galleryUnlock);
      if (!human) return c.json(fail('verification_failed'), 400);
    }
    const res = await rpc<Reserve | null>(c.env, 'gallery_unlock_reserve', {
      p_gallery: state.id,
      p_network: await networkHash(c),
      p_has_turnstile: human,
    });
    if (!res || res.status === 'ended') return notFound(c);
    if (res.status === 'open') return c.json({ ok: true });
    if (res.status === 'turnstile') return c.json(fail('verification_failed', { turnstile: true }), 400);
    if (res.status === 'limited') return rateLimited(c, res.retryAfter);
    if (res.status === 'paused') {
      c.header(
        'Retry-After',
        String(Math.max(1, Math.ceil((Date.parse(res.pausedUntil) - Date.now()) / 1000))),
      );
      return c.json(fail('gallery_paused', { pausedUntil: res.pausedUntil }), 423);
    }
    if (await passcodeMatches(c.env, state.id, res.generation, body.passcode, res.hmac)) {
      await rpc(c.env, 'gallery_unlock_succeeded', { p_attempt: res.attemptId });
      c.header('Set-Cookie', await unlockCookie(c.env, state.id, res.generation), { append: true });
      await logEvent(c, state.id, 'unlocked');
      return c.json({ ok: true });
    }
    await logEvent(c, state.id, 'wrong_passcode');
    if (res.pausedNow) {
      const env = c.env;
      const until = new Date(Date.now() + PASSCODE_LIMITS.windowMinutes * 60_000).toISOString();
      if (res.ownerEmail) {
        const to = res.ownerEmail;
        await emailLater(c, 'gallery_paused_email', () =>
          sendEmail(env, {
            to,
            ...galleryPausedEmail({
              galleryName: res.name ?? 'Your gallery',
              galleryId: state.id,
              pausedUntil: until,
              appUrl: env.APP_URL,
            }),
          }),
        );
      }
      c.header('Retry-After', String(PASSCODE_LIMITS.windowMinutes * 60));
      return c.json(fail('gallery_paused', { pausedUntil: until }), 423);
    }
    const remaining = Math.max(0, PASSCODE_LIMITS.perNetworkFailures - res.networkAttempts);
    return c.json(
      fail('wrong_passcode', {
        remaining,
        ...(res.networkAttempts >= PASSCODE_LIMITS.turnstileAfter ? { turnstile: true } : {}),
      }),
      401,
    );
  } catch (err) {
    logError(c.get('requestId'), 'guest_unlock', err);
    return c.json(fail('server'), 500);
  }
});

// ---- photos -----------------------------------------------------------------------------------------------
interface PhotoRow {
  id: string;
  width: number;
  height: number;
  full: 'n/a' | 'pending' | 'ready';
  favourite: boolean;
}
interface PhotosRow {
  items: PhotoRow[];
  nextCursor: string | null;
  selection: { count: number; sentAt: string | null; name: string | null } | null;
}

/** GuestPhotoPage with signed URLs. `base` is the media path prefix (guest token or owner preview). */
export async function photoPage(
  c: Ctx,
  galleryId: string,
  generation: number,
  rows: PhotosRow,
  o: { base: string; downloads: 'none' | 'web' | 'full'; favourites: boolean },
): Promise<GuestPhotoPage> {
  const exp = mediaExpiry();
  const url = async (id: string, size: MediaSize) =>
    `${o.base}/m/${id}/${size}${await mediaQuery(c.env, galleryId, id, size, generation, exp)}`;
  const items: GuestPhoto[] = [];
  for (const p of rows.items) {
    const item: GuestPhoto = {
      id: p.id,
      width: p.width,
      height: p.height,
      grid: await url(p.id, 'grid'),
      view: await url(p.id, 'view'),
    };
    if (o.downloads !== 'none') {
      item.download = {
        web: await url(p.id, 'web'),
        full: o.downloads === 'full' && p.full === 'ready' ? await url(p.id, 'full') : null,
      };
    }
    if (o.favourites) item.favourite = p.favourite;
    items.push(item);
  }
  return {
    ok: true,
    items,
    nextCursor: rows.nextCursor,
    ...(o.favourites && rows.selection ? { selection: rows.selection } : {}),
  };
}

export const cursorOf = (c: Ctx): number | null | false => {
  const raw = c.req.query('cursor');
  if (raw === undefined || raw === '') return null;
  return /^[0-9]{1,6}$/.test(raw) ? Number(raw) : false;
};

/** The effective downloads and favourites for this gallery (plan limits applied), from the info RPC. */
async function features(c: Ctx, hash: string) {
  return rpc<InfoRow | null>(c.env, 'guest_gallery_info', { p_token_hash: hash, p_network: null });
}

guestRoutes.get('/:token/photos', async (c) => {
  const cursor = cursorOf(c);
  if (cursor === false) return c.json(fail('invalid'), 400);
  try {
    const r = await resolve(c, true);
    if (!r?.state.serving) return notFound(c);
    if (!(await isUnlocked(c, r.state))) return c.json(fail('unauthenticated'), 401);
    const info = await features(c, r.hash);
    if (!info || info.state === 'ended') return notFound(c);
    const gid = getCookie(c, GUEST_ID_COOKIE);
    const rows = await rpc<PhotosRow | null>(c.env, 'guest_photos', {
      p_gallery: r.state.id,
      p_cursor: cursor,
      p_limit: GUEST_PAGE,
      p_guest: info.favourites && validGuestId(gid) ? await guestIdHash(c.env, r.state.id, gid) : null,
    });
    if (!rows) return notFound(c);
    return c.json(
      await photoPage(c, r.state.id, r.state.generation, rows, {
        base: `/api/v1/g/${r.token}`,
        downloads: info.downloads,
        favourites: info.favourites,
      }),
    );
  } catch (err) {
    logError(c.get('requestId'), 'guest_photos', err);
    return c.json(fail('server'), 500);
  }
});

// ---- favourites -------------------------------------------------------------------------------------------
async function setFavourite(c: Ctx, on: boolean) {
  const photoId = c.req.param('photoId') ?? '';
  if (!UUID.test(photoId)) return notFound(c);
  try {
    const r = await resolve(c, true);
    if (!r?.state.serving) return notFound(c);
    if (!(await isUnlocked(c, r.state))) return c.json(fail('unauthenticated'), 401);
    let gid = getCookie(c, GUEST_ID_COOKIE);
    if (!validGuestId(gid)) {
      if (!on) return c.body(null, 204);
      const fresh = newGuestId();
      gid = fresh.value;
      c.header('Set-Cookie', fresh.cookie, { append: true });
    }
    const res = await rpc<'ok' | 'off' | 'limit' | null>(c.env, 'guest_set_favourite', {
      p_gallery: r.state.id,
      p_guest: await guestIdHash(c.env, r.state.id, gid),
      p_photo: photoId,
      p_on: on,
      // The new-guest cap is per customer network (IPv6 /48): see customerNetworkHash.
      p_network: await customerNetworkHash(c),
    });
    if (res === null) return notFound(c);
    if (res === 'off') return c.json(fail('forbidden'), 403);
    if (res === 'limit') return c.json(fail('limit_reached'), 409);
    return c.body(null, 204);
  } catch (err) {
    logError(c.get('requestId'), 'guest_favourite', err);
    return c.json(fail('server'), 500);
  }
}
// `send` is a POST, so it never matches these.
guestRoutes.put('/:token/favourites/:photoId', (c) => setFavourite(c, true));
guestRoutes.delete('/:token/favourites/:photoId', (c) => setFavourite(c, false));

guestRoutes.post('/:token/favourites/send', async (c) => {
  const body = await readBody(c, guestSendSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const r = await resolve(c, true);
    if (!r?.state.serving) return notFound(c);
    if (!(await isUnlocked(c, r.state))) return c.json(fail('unauthenticated'), 401);
    const gid = getCookie(c, GUEST_ID_COOKIE);
    if (!validGuestId(gid)) return c.json(fail('invalid'), 400);
    const res = await rpc<
      | {
          status: 'ok';
          count: number;
          notify: boolean;
          ownerEmail?: string | null;
          galleryName?: string | null;
        }
      | { status: 'off' }
      | { status: 'empty' }
      | null
    >(c.env, 'guest_send_favourites', {
      p_gallery: r.state.id,
      p_guest: await guestIdHash(c.env, r.state.id, gid),
      p_name: body.name,
      p_note: body.note ?? null,
    });
    if (!res) return notFound(c);
    if (res.status === 'off') return c.json(fail('forbidden'), 403);
    if (res.status === 'empty') return c.json(fail('invalid'), 400);
    if (res.notify && res.ownerEmail) {
      const env = c.env;
      const to = res.ownerEmail;
      const galleryId = r.state.id;
      await emailLater(c, 'favourites_email', () =>
        sendEmail(env, {
          to,
          ...favouritesSentEmail({
            galleryName: res.galleryName ?? 'Your gallery',
            galleryId,
            guestName: body.name,
            count: res.count,
            note: body.note ?? null,
            appUrl: env.APP_URL,
          }),
        }),
      );
    }
    return c.json({ ok: true });
  } catch (err) {
    logError(c.get('requestId'), 'guest_send', err);
    return c.json(fail('server'), 500);
  }
});

// ---- report -----------------------------------------------------------------------------------------------
guestRoutes.post('/:token/report', async (c) => {
  const body = await readBody(c, guestReportSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const r = await resolve(c, true);
    if (!r) return notFound(c);
    if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c), TURNSTILE_ACTIONS.galleryReport))) {
      return c.json(fail('verification_failed'), 400);
    }
    const res = await rpc<
      | {
          status: 'ok';
          reportId: string;
          ownerId: string;
          /** Validated by the database: in this gallery, else null. */
          photoId: string | null;
          /** Email Safety now (at most once an hour per gallery). */
          alert: boolean;
          /** CSAM reports on this gallery since the last alert (this one included). */
          pendingCount: number;
        }
      | { status: 'limited' }
      | null
    >(c.env, 'guest_report', {
      p_gallery: r.state.id,
      p_photo: body.photoId ?? null,
      p_reason: body.reason,
      p_details: body.details ?? null,
      p_network: await customerNetworkHash(c),
    });
    if (!res) return notFound(c);
    if (res.status === 'limited') return rateLimited(c, 3600);
    // Every report is recorded; Safety is emailed at most once an hour per gallery, with the count since. Once
    // the email is sent the reports it covers are marked; the cron sweeps up any it didn't (due_safety_alerts).
    if (body.reason === 'csam' && res.alert && c.env.SAFETY_ALERT_EMAIL) {
      const env = c.env;
      const galleryId = r.state.id;
      await emailLater(c, 'safety_report_email', () =>
        sendEmail(env, {
          to: env.SAFETY_ALERT_EMAIL,
          ...safetyReportEmail({
            reportId: res.reportId,
            galleryId,
            ownerId: res.ownerId,
            photoId: res.photoId,
            count: res.pendingCount,
            at: new Date(),
          }),
          idempotencyKey: `report-${res.reportId}`,
        }).then(() => rpc(env, 'confirm_safety_alert', { p_report: res.reportId })),
      );
    }
    return c.json({ ok: true }, 202);
  } catch (err) {
    logError(c.get('requestId'), 'guest_report', err);
    return c.json(fail('server'), 500);
  }
});

// ---- media ------------------------------------------------------------------------------------------------
const SIZES = new Set(['grid', 'view', 'web', 'full']);

guestRoutes.get('/:token/m/:photoId/:size', async (c) => {
  const photoId = c.req.param('photoId');
  const size = c.req.param('size');
  if (!UUID.test(photoId) || !SIZES.has(size)) return notFound(c);
  try {
    const r = await resolve(c);
    if (!r?.state.serving) return notFound(c);
    const { state } = r;
    if (
      !(await mediaSignatureOk(
        c.env,
        state.id,
        photoId,
        size as MediaSize,
        state.generation,
        c.req.query('e'),
        c.req.query('s'),
      ))
    ) {
      return notFound(c);
    }
    const download = size === 'web' || size === 'full';
    return serveRendition(
      c,
      state.id,
      photoId,
      size === 'web' ? 'view' : (size as 'grid' | 'view' | 'full'),
      {
        download,
        tokenHashPg: r.hash,
        onServed: download ? () => logEvent(c, state.id, 'downloaded') : undefined,
      },
    );
  } catch (err) {
    logError(c.get('requestId'), 'guest_media', err);
    return c.json(fail('server'), 500);
  }
});

guestRoutes.get('/:token/brand/logo', async (c) => {
  try {
    const r = await resolve(c);
    if (!r?.state.serving) return notFound(c);
    const { state } = r;
    if (
      !(await mediaSignatureOk(
        c.env,
        state.id,
        'logo',
        'logo',
        state.generation,
        c.req.query('e'),
        c.req.query('s'),
      ))
    ) {
      return notFound(c);
    }
    const key = await rpc<string | null>(c.env, 'guest_logo', { p_gallery: state.id });
    if (!key) return notFound(c);
    return serveShared(c, key, 'image/png');
  } catch (err) {
    logError(c.get('requestId'), 'guest_logo', err);
    return c.json(fail('server'), 500);
  }
});
