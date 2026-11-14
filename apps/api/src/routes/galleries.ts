/**
 * Member gallery routes (docs/phase-5.md, Members), SHARE_API:
 *   GET/POST              /api/v1/galleries
 *   GET/PATCH/DELETE      /api/v1/galleries/:id                (DELETE revokes, for good)
 *   GET/POST              /api/v1/galleries/:id/photos
 *   POST/DELETE           /api/v1/galleries/:id/passcode
 *   GET                   /api/v1/galleries/:id/link
 *   GET                   /api/v1/galleries/:id/favourites
 *   GET                   /api/v1/galleries/:id/activity
 *   GET                   /api/v1/galleries/:id/renders        (render queue)
 *   PUT                   /api/v1/galleries/:id/renders/:photoId?v=   (full-size JPEG from the device)
 *   GET                   /api/v1/galleries/:id/preview(/photos)  and  /preview/m/:photoId/:size
 * Every route needs a member session and only ever passes the open library's owner (libraryContext). Writes need
 * the expected user (shared devices) and count against SHARE_LIMITER.
 */
import {
  type GalleryCreated,
  type GalleryDetail,
  type GallerySummary,
  GUEST_PATH,
  galleryCreateSchema,
  galleryPatchSchema,
  galleryPhotosSchema,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { toPgBytea } from '../crypto';
import { background, fail, logError, rateLimited, readBody } from '../http';
import { actorOf, libraryContext, ownerOf, requireRole, requireWritable } from '../library/context';
import { imageInfo } from '../library/files';
import { nonce, stores } from '../library/objects';
import {
  BodyLengthError,
  contentLength,
  exactLength,
  expectedUser,
  libraryGuard,
  peek,
  UUID,
} from '../library/storage';
import { serveRendition } from '../share/media';
import {
  decryptLink,
  encryptLink,
  mediaSignatureOk,
  newGalleryToken,
  newPasscode,
  passcodeHmac,
} from '../share/signing';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { cursorOf, infoBody, photoPage } from './guest';
import { requireMember } from './session-helpers';

export const galleryRoutes = new Hono<HonoEnv>();
type Ctx = Context<HonoEnv>;
const notFound = (c: Ctx) => c.json(fail('not_found'), 404);
const isRead = (c: Ctx) => c.req.method === 'GET' || c.req.method === 'HEAD';

/** Full-size renders: the largest JPEG a device may upload. */
const MAX_RENDER_BYTES = 64 * 1024 * 1024;
const MAX_RENDER_EDGE = 20000;

galleryRoutes.use('*', libraryGuard(128 * 1024), requireMember);
// Phase 7: the open library's galleries. Owners and Editors only (ROLE_CAN galleries): a Viewer can't see
// share links, guests' activity or favourites, which would let them share or profile clients.
galleryRoutes.use('*', libraryContext, requireRole('galleries'));
galleryRoutes.use('*', async (c, next) => (isRead(c) ? next() : expectedUser(c, next)));
const shareLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!(await c.env.SHARE_LIMITER.limit({ key: `share:${actorOf(c)}` })).success) return rateLimited(c, 60);
  await next();
};
galleryRoutes.use('*', async (c, next) =>
  isRead(c) && !c.req.path.endsWith('/link') ? next() : shareLimit(c, next),
);

/** UUID check for every `:id` route. */
galleryRoutes.use('/:id/*', async (c, next) => (UUID.test(c.req.param('id') ?? '') ? next() : notFound(c)));
galleryRoutes.use('/:id', async (c, next) => (UUID.test(c.req.param('id') ?? '') ? next() : notFound(c)));

type GalleryError =
  | 'suspended'
  | 'limit'
  | 'plan'
  | 'expiry'
  | 'no_photos'
  | 'invalid'
  | 'ended'
  | 'too_many';
function galleryError(c: Ctx, e: GalleryError) {
  switch (e) {
    case 'suspended':
      return c.json(fail('sharing_suspended'), 403);
    case 'limit':
      return c.json(fail('quota_exceeded'), 409);
    case 'plan':
      return c.json(fail('plan_required'), 403);
    case 'ended':
      return c.json(fail('conflict'), 409);
    case 'too_many':
      return c.json(fail('too_large'), 413);
    default:
      return c.json(fail('invalid'), 400);
  }
}
const guestUrl = (c: Ctx, token: string) => `${c.env.APP_URL.replace(/\/$/, '')}${GUEST_PATH(token)}`;

// ---- list and create --------------------------------------------------------------------------------------
galleryRoutes.get('/', async (c) => {
  try {
    const galleries = await rpc<GallerySummary[]>(c.env, 'list_galleries', { p_owner: ownerOf(c) });
    return c.json({ ok: true, galleries });
  } catch (err) {
    logError(c.get('requestId'), 'galleries_list', err);
    return c.json(fail('server'), 500);
  }
});

// No new galleries while the library is read-only (live ones stay up until they expire).
galleryRoutes.post('/', requireWritable, async (c) => {
  const body = await readBody(c, galleryCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const id = crypto.randomUUID();
    const { token, hash } = await newGalleryToken();
    const link = await encryptLink(c.env, id, token);
    const passcode = body.passcode ? newPasscode() : null;
    const res = await rpc<{ gallery: GalleryDetail } | { error: GalleryError }>(c.env, 'create_gallery', {
      p_owner: ownerOf(c),
      p_id: id,
      p_token_hash: hash,
      p_link_hint: token.slice(0, 8),
      p_link_ciphertext: link.ciphertext,
      p_link_iv: link.iv,
      p_passcode_hmac: passcode ? toPgBytea(await passcodeHmac(c.env, id, 1, passcode)) : null,
      p_name: body.name,
      p_message: body.message ?? null,
      p_photo_ids: body.photoIds,
      p_expires_on: body.expiresOn,
      p_downloads: body.downloads,
      p_extras: body.extras,
    });
    if ('error' in res) return galleryError(c, res.error);
    return c.json(
      { ok: true, gallery: res.gallery, url: guestUrl(c, token), passcode } satisfies GalleryCreated,
      201,
    );
  } catch (err) {
    logError(c.get('requestId'), 'gallery_create', err);
    return c.json(fail('server'), 500);
  }
});

// ---- one gallery ------------------------------------------------------------------------------------------
galleryRoutes.get('/:id', async (c) => {
  try {
    const gallery = await rpc<GalleryDetail | null>(c.env, 'get_gallery', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
    });
    return gallery ? c.json({ ok: true, gallery }) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_get', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.patch('/:id', async (c) => {
  const body = await readBody(c, galleryPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  // No extensions while read-only: any new expiry date is refused (shortening can wait until it's back under).
  if (body.expiresOn !== undefined && c.get('library').state === 'read_only') {
    return c.json(fail('library_read_only'), 403);
  }
  try {
    const res = await rpc<{ gallery: GalleryDetail } | { error: GalleryError } | null>(
      c.env,
      'patch_gallery',
      {
        p_owner: ownerOf(c),
        p_id: c.req.param('id'),
        p_patch: body,
      },
    );
    if (!res) return notFound(c);
    if ('error' in res) return galleryError(c, res.error);
    return c.json({ ok: true, gallery: res.gallery });
  } catch (err) {
    logError(c.get('requestId'), 'gallery_patch', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.delete('/:id', async (c) => {
  try {
    const ok = await rpc<boolean | null>(c.env, 'revoke_gallery', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
    });
    return ok ? c.body(null, 204) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_revoke', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.get('/:id/link', async (c) => {
  const id = c.req.param('id');
  try {
    const row = await rpc<{ ciphertext: string; iv: string } | null>(c.env, 'gallery_link', {
      p_owner: ownerOf(c),
      p_id: id,
    });
    if (!row) return notFound(c);
    const token = await decryptLink(c.env, id, row.ciphertext, row.iv);
    if (!token) {
      logError(c.get('requestId'), 'gallery_link_decrypt', new Error('undecryptable'));
      return c.json(fail('server'), 500);
    }
    return c.json({ ok: true, url: guestUrl(c, token) });
  } catch (err) {
    logError(c.get('requestId'), 'gallery_link', err);
    return c.json(fail('server'), 500);
  }
});

// ---- photos -----------------------------------------------------------------------------------------------
galleryRoutes.get('/:id/photos', async (c) => {
  const cursor = cursorOf(c);
  if (cursor === false) return c.json(fail('invalid'), 400);
  try {
    const page = await rpc<{ items: unknown[]; nextCursor: string | null } | null>(
      c.env,
      'list_gallery_photos',
      {
        p_owner: ownerOf(c),
        p_id: c.req.param('id'),
        p_cursor: cursor,
        p_limit: 100,
      },
    );
    return page ? c.json({ ok: true, ...page }) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_photos', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.post('/:id/photos', async (c) => {
  const body = await readBody(c, galleryPhotosSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<{ count: number } | { error: GalleryError } | null>(
      c.env,
      'update_gallery_photos',
      {
        p_owner: ownerOf(c),
        p_id: c.req.param('id'),
        p_add: body.add ?? null,
        p_remove: body.remove ?? null,
      },
    );
    if (!res) return notFound(c);
    if ('error' in res) return galleryError(c, res.error);
    return c.json({ ok: true, count: res.count });
  } catch (err) {
    logError(c.get('requestId'), 'gallery_photos_update', err);
    return c.json(fail('server'), 500);
  }
});

// ---- passcode ---------------------------------------------------------------------------------------------
/** Sets a new passcode (or none), moving to the next generation; retried if another change won the race. */
async function changePasscode(c: Ctx, on: boolean): Promise<Response> {
  const owner = ownerOf(c);
  const id = c.req.param('id') ?? '';
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await rpc<{ generation: number; ended: boolean } | null>(
        c.env,
        'gallery_passcode_state',
        {
          p_owner: owner,
          p_id: id,
        },
      );
      if (!state) return notFound(c);
      const generation = state.generation + 1;
      const code = on ? newPasscode() : null;
      const res = await rpc<'ok' | 'conflict' | 'ended' | null>(c.env, 'set_gallery_passcode', {
        p_owner: owner,
        p_id: id,
        p_generation: generation,
        p_hmac: code ? toPgBytea(await passcodeHmac(c.env, id, generation, code)) : null,
      });
      if (res === null) return notFound(c);
      if (res === 'ended') return c.json(fail('conflict'), 409);
      if (res === 'ok') return code ? c.json({ ok: true, passcode: code }) : c.body(null, 204);
    }
    return c.json(fail('conflict'), 409);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_passcode', err);
    return c.json(fail('server'), 500);
  }
}
galleryRoutes.post('/:id/passcode', (c) => changePasscode(c, true));
galleryRoutes.delete('/:id/passcode', (c) => changePasscode(c, false));

// ---- favourites and activity ------------------------------------------------------------------------------
galleryRoutes.get('/:id/favourites', async (c) => {
  try {
    const guests = await rpc<unknown[] | null>(c.env, 'gallery_favourites', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
    });
    return guests ? c.json({ ok: true, guests }) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_favourites', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.get('/:id/activity', async (c) => {
  const raw = c.req.query('cursor');
  if (raw !== undefined && raw !== '' && !/^[0-9]{1,18}$/.test(raw)) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<Record<string, unknown> | null>(c.env, 'gallery_activity', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
      p_before: raw ? raw : null,
      p_limit: 50,
    });
    return res ? c.json({ ok: true, ...res }) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_activity', err);
    return c.json(fail('server'), 500);
  }
});

// ---- full-size renders ------------------------------------------------------------------------------------
galleryRoutes.get('/:id/renders', async (c) => {
  try {
    const pending = await rpc<unknown[] | null>(c.env, 'gallery_render_queue', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
    });
    return pending ? c.json({ ok: true, pending }) : notFound(c);
  } catch (err) {
    logError(c.get('requestId'), 'gallery_render_queue', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.put('/:id/renders/:photoId', async (c) => {
  const id = c.req.param('id');
  const photoId = c.req.param('photoId');
  if (!UUID.test(photoId)) return notFound(c);
  const rawV = c.req.query('v') ?? '';
  if (!/^(0|[1-9][0-9]{0,9})$/.test(rawV) || Number(rawV) > 2_147_483_647)
    return c.json(fail('invalid'), 400);
  const version = Number(rawV);
  if ((c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'image/jpeg') {
    return c.json(fail('invalid'), 415);
  }
  const owner = ownerOf(c);
  const len = contentLength(c.req.header('Content-Length'));
  if (len === null) return c.json(fail('invalid'), 411);
  if (len > MAX_RENDER_BYTES) return c.json(fail('too_large'), 413);
  if (len < 1 || !c.req.raw.body) return c.json(fail('invalid'), 400);
  try {
    // Checked before anything is written: stale renders and repeats never touch storage.
    const check = await rpc<{ status: 'current' | 'exists' | 'stale' | 'not_needed' } | null>(
      c.env,
      'gallery_render_check',
      {
        p_owner: owner,
        p_gallery: id,
        p_photo: photoId,
        p_version: version,
      },
    );
    if (!check) return notFound(c);
    if (check.status === 'exists') return c.json({ ok: true });
    if (check.status !== 'current') return c.json(fail('conflict'), 410);

    const { head, rest } = await peek(c.req.raw.body, Math.min(len, 65536));
    const info = imageInfo(head);
    if (info?.format !== 'jpeg') {
      await rest.cancel().catch(() => undefined);
      return c.json(fail('invalid'), 415);
    }
    if (info.width > MAX_RENDER_EDGE || info.height > MAX_RENDER_EDGE) {
      await rest.cancel().catch(() => undefined);
      return c.json(fail('invalid'), 400);
    }
    const { photos } = stores(c.env);
    // This request's own key; the database decides (under the storage lock) whether it counts.
    const key = `u/${owner}/g/${id}/${photoId}/full-${version}-${nonce()}`;
    const limited = exactLength(rest, len);
    let recorded = false;
    let outcomeUnknown = false;
    try {
      await photos.put(key, limited.stream, { contentType: 'image/jpeg', length: len });
      if (limited.state.error) return c.json(fail('invalid'), 400);
      const stored = await photos.head(key);
      if (!stored || stored.size !== len) return c.json(fail('invalid'), 400);
      outcomeUnknown = true;
      const res = await rpc<{ status: 'ok' | 'exists' | 'gone' | 'storage_full' | 'invalid' }>(
        c.env,
        'record_gallery_render',
        {
          p_owner: owner,
          p_gallery: id,
          p_photo: photoId,
          p_version: version,
          p_key: key,
          p_bytes: stored.size,
        },
      );
      outcomeUnknown = false;
      recorded = res.status === 'ok';
      if (res.status === 'ok' || res.status === 'exists') return c.json({ ok: true });
      if (res.status === 'storage_full') return c.json(fail('storage_full'), 413);
      if (res.status === 'gone') return c.json(fail('conflict'), 410);
      return c.json(fail('invalid'), 400);
    } catch (err) {
      if (err instanceof BodyLengthError || limited.state.error) return c.json(fail('invalid'), 400);
      throw err;
    } finally {
      // If the record call failed midway the database may have committed: the object stays (the gallery's
      // prefix is emptied when its data is deleted). Otherwise an unrecorded object goes now.
      if (!recorded && !outcomeUnknown) {
        const requestId = c.get('requestId');
        const env = c.env;
        await background(c, async () => {
          try {
            await stores(env).photos.delete([key]);
          } catch (err) {
            logError(requestId, 'render_drop', err);
          }
        });
      }
    }
  } catch (err) {
    logError(c.get('requestId'), 'gallery_render', err);
    return c.json(fail('server'), 500);
  }
});

// ---- owner preview ----------------------------------------------------------------------------------------
// What guests see, without a passcode, without events, favourites or downloads.
galleryRoutes.get('/:id/preview', async (c) => {
  try {
    const row = await rpc<Parameters<typeof infoBody>[1] | null>(c.env, 'gallery_preview_info', {
      p_owner: ownerOf(c),
      p_id: c.req.param('id'),
    });
    if (!row) return notFound(c);
    return c.json(await infoBody(c, { ...row, turnstile: false }, true, () => '/api/v1/me/branding/logo'));
  } catch (err) {
    logError(c.get('requestId'), 'gallery_preview', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.get('/:id/preview/photos', async (c) => {
  const cursor = cursorOf(c);
  if (cursor === false) return c.json(fail('invalid'), 400);
  const id = c.req.param('id');
  try {
    const row = await rpc<{ generation: number; state: string } | null>(c.env, 'gallery_preview_info', {
      p_owner: ownerOf(c),
      p_id: id,
    });
    if (!row || row.state === 'ended') return notFound(c);
    const rows = await rpc<Parameters<typeof photoPage>[3] | null>(c.env, 'guest_photos', {
      p_gallery: id,
      p_cursor: cursor,
      p_limit: 60,
      p_guest: null,
    });
    if (!rows) return notFound(c);
    return c.json(
      await photoPage(c, id, row.generation, rows, {
        base: `/api/v1/galleries/${id}/preview`,
        downloads: 'none',
        favourites: false,
      }),
    );
  } catch (err) {
    logError(c.get('requestId'), 'gallery_preview_photos', err);
    return c.json(fail('server'), 500);
  }
});

galleryRoutes.get('/:id/preview/m/:photoId/:size', async (c) => {
  const id = c.req.param('id');
  const photoId = c.req.param('photoId');
  const size = c.req.param('size');
  if (!UUID.test(photoId) || (size !== 'grid' && size !== 'view')) return notFound(c);
  try {
    const state = await rpc<{ generation: number; ended: boolean } | null>(c.env, 'gallery_passcode_state', {
      p_owner: ownerOf(c),
      p_id: id,
    });
    if (!state || state.ended) return notFound(c);
    if (
      !(await mediaSignatureOk(
        c.env,
        id,
        photoId,
        size,
        state.generation,
        c.req.query('e'),
        c.req.query('s'),
      ))
    ) {
      return notFound(c);
    }
    // The owner's preview: never stored by the browser, so it can't outlive the session.
    return serveRendition(c, id, photoId, size, { noStore: true });
  } catch (err) {
    logError(c.get('requestId'), 'gallery_preview_media', err);
    return c.json(fail('server'), 500);
  }
});
