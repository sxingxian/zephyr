import {
  type BulkResult,
  bulkSchema,
  FILE_TYPES,
  type FileTypeId,
  type Page,
  type PhotoDetail,
  type PhotoItem,
  photoListQuerySchema,
  photoPatchSchema,
} from '@zephyr/shared';
import { type Context, Hono } from 'hono';
import { fail, logError, readBody } from '../http';
import { contentDisposition, downloadName, parseRange } from '../library/files';
import { LIBRARY_LIMITS, libraryGuard, type PurgeItem, photoKey, purgeNow, UUID } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { editRoutes } from './edits';
import { requireMember } from './session-helpers';

/** /api/v1/photos/*: the member's library, photo details and files. */
export const photoRoutes = new Hono<HonoEnv>();
photoRoutes.use('*', libraryGuard(LIBRARY_LIMITS.jsonBodyBytes));
photoRoutes.use('*', requireMember);

type Ctx = Context<HonoEnv>;
const ownerOf = (c: Ctx) => c.get('session').userId;

photoRoutes.get('/', async (c) => {
  const parsed = photoListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json(fail('invalid'), 400);
  const q = parsed.data;
  try {
    const page = await rpc<{ items: PhotoItem[]; nextCursor: string | null } | null>(c.env, 'list_photos', {
      p_owner: ownerOf(c),
      p_view: q.view ?? 'library',
      p_album: q.albumId ?? null,
      p_q: q.q ?? null,
      p_from: q.from ?? null,
      p_to: q.to ?? null,
      p_sort: q.sort ?? 'taken',
      p_cursor: q.cursor ?? null,
      p_limit: q.limit ?? 60,
      p_scene: q.scene ?? null,
      p_person: q.person ?? null,
    });
    if (!page) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, items: page.items, nextCursor: page.nextCursor } satisfies Page<PhotoItem>);
  } catch (err) {
    logError(c.get('requestId'), 'photos_list', err);
    return c.json(fail('server'), 500);
  }
});

photoRoutes.post('/bulk', async (c) => {
  const body = await readBody(c, bulkSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<{ affected?: number; purge?: PurgeItem[]; error?: string } | null>(
      c.env,
      'bulk_photos',
      {
        p_owner: ownerOf(c),
        p_ids: body.ids,
        p_action: body.action,
        p_album: body.albumId ?? null,
      },
    );
    if (!res) return c.json(fail('not_found'), 404);
    if (res.error || res.affected === undefined) return c.json(fail('invalid'), 400);
    if (res.purge?.length) {
      try {
        await purgeNow(c.env, res.purge);
      } catch (err) {
        // The rows stay 'purging' (hidden, still counted); the clean-up job retries.
        logError(c.get('requestId'), 'photos_purge', err);
      }
    }
    return c.json({ ok: true, affected: res.affected } satisfies BulkResult);
  } catch (err) {
    logError(c.get('requestId'), 'photos_bulk', err);
    return c.json(fail('server'), 500);
  }
});

photoRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const photo = await rpc<PhotoDetail | null>(c.env, 'get_photo', { p_owner: ownerOf(c), p_id: id });
    if (!photo) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, photo });
  } catch (err) {
    logError(c.get('requestId'), 'photo_get', err);
    return c.json(fail('server'), 500);
  }
});

photoRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, photoPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const photo = await rpc<(PhotoItem & { error?: never }) | { error: string } | null>(
      c.env,
      'patch_photo',
      {
        p_owner: ownerOf(c),
        p_id: id,
        p_favourite: body.favourite ?? null,
        p_filename: body.filename ?? null,
      },
    );
    if (!photo) return c.json(fail('not_found'), 404);
    if ('error' in photo && photo.error) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, photo });
  } catch (err) {
    logError(c.get('requestId'), 'photo_patch', err);
    return c.json(fail('server'), 500);
  }
});

// Phase 4: …/:id/edit, …/:id/edit/variants/:kind and …/edits/bulk. Mounted before the media route below
// so `/:id/edit` isn't read as a file kind; the guard and requireMember above apply to them too.
photoRoutes.route('/', editRoutes);

interface PhotoFile {
  fileType: FileTypeId;
  filename: string;
  sizeBytes: number;
  hasThumb: boolean;
  hasPreview: boolean;
  /** The current edit version (phase 4), and the recorded object of each kind rendered from it. */
  editVersion?: number | null;
  editThumbKey?: string | null;
  editPreviewKey?: string | null;
}

/** If-None-Match lists this tag (or `*`). */
function matchesTag(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim().replace(/^W\//, '');
    return v === '*' || v === tag;
  });
}

/** Headers every image response carries: the type is ours, never sniffed, never rendered as a page. */
function mediaHeaders(contentType: string): Headers {
  return new Headers({
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

/**
 * Phase 6: a background mask (8-bit greyscale PNG). The key comes from the database, for the owner's own
 * photo only. Mask ids are never reused, so the response can be cached privately for good.
 */
photoRoutes.get('/:id/masks/:mask', async (c) => {
  const id = c.req.param('id');
  const mask = c.req.param('mask');
  if (!UUID.test(id) || !UUID.test(mask)) return c.json(fail('not_found'), 404);
  try {
    const key = await rpc<string | null>(c.env, 'ai_mask_key', {
      p_owner: ownerOf(c),
      p_photo: id,
      p_mask: mask,
    });
    if (!key) return c.json(fail('not_found'), 404);
    const obj = await c.env.PHOTOS.get(key);
    if (!obj || !('body' in obj)) return c.json(fail('not_found'), 404);
    const h = mediaHeaders('image/png');
    h.set('Cache-Control', 'private, max-age=31536000, immutable');
    h.set('Content-Length', String(obj.size));
    return new Response(c.req.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
  } catch (err) {
    logError(c.get('requestId'), 'photo_mask', err);
    return c.json(fail('server'), 500);
  }
});

photoRoutes.get('/:id/:kind', async (c) => {
  const id = c.req.param('id');
  const kind = c.req.param('kind');
  if (!UUID.test(id) || (kind !== 'thumb' && kind !== 'preview' && kind !== 'original')) {
    return c.json(fail('not_found'), 404);
  }
  try {
    const owner = ownerOf(c);
    const file = await rpc<PhotoFile | null>(c.env, 'photo_file', { p_owner: owner, p_id: id });
    if (!file) return c.json(fail('not_found'), 404);
    const key = photoKey(owner, id, kind);

    if (kind !== 'original') {
      // The edited variant when it was rendered from the current edit, unless ?original=1 (compare views).
      // The key comes from the database, never from the request.
      const editK =
        c.req.query('original') === '1' ? null : kind === 'thumb' ? file.editThumbKey : file.editPreviewKey;
      const editV = file.editVersion;
      let source: { key: string; tag: (etag: string) => string } | null = null;
      let meta = editK && editV ? await c.env.PHOTOS.head(editK) : null;
      if (editK && editV && meta) {
        source = { key: editK, tag: (e) => `"${e}-e${editV}"` };
      } else if (kind === 'thumb' ? file.hasThumb : file.hasPreview) {
        meta = await c.env.PHOTOS.head(key);
        if (meta) source = { key, tag: (e) => `"${e}"` };
      }
      if (!source || !meta) return c.json(fail('not_found'), 404);
      // Variants are only ever stored as JPEG or WEBP by the upload and edit routes.
      const h = mediaHeaders(meta.httpMetadata?.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/webp');
      // Stored but revalidated every time: the 304 still passes the session and owner checks, and
      // sign-out clears the cache (Clear-Site-Data), so nothing is readable once signed out. The tag
      // names the edit version, so an edited and an original variant never share one.
      h.set('Cache-Control', 'private, no-cache');
      const tag = source.tag(meta.etag);
      h.set('ETag', tag);
      if (matchesTag(c.req.header('If-None-Match'), tag))
        return new Response(null, { status: 304, headers: h });
      const obj = await c.env.PHOTOS.get(source.key);
      if (!obj || !('body' in obj)) return c.json(fail('not_found'), 404);
      if (obj.etag !== meta.etag) h.set('ETag', source.tag(obj.etag));
      h.set('Content-Length', String(obj.size));
      return new Response(c.req.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
    }

    // Originals: always a download, never cached, with single-range support for large files.
    const size = file.sizeBytes;
    const h = mediaHeaders(FILE_TYPES[file.fileType].mime);
    h.set('Cache-Control', 'no-store');
    h.set('Accept-Ranges', 'bytes');
    h.set('Content-Disposition', contentDisposition(downloadName(file.filename, file.fileType)));
    const range = parseRange(c.req.header('Range'), size);
    if (range === null) {
      h.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers: h });
    }
    const obj = await c.env.PHOTOS.get(key, range ? { range } : {});
    if (!obj || !('body' in obj)) return c.json(fail('not_found'), 404);
    if (range) {
      h.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
      h.set('Content-Length', String(range.length));
      return new Response(c.req.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
    }
    h.set('Content-Length', String(obj.size));
    return new Response(c.req.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
  } catch (err) {
    logError(c.get('requestId'), 'photo_file', err);
    return c.json(fail('server'), 500);
  }
});
