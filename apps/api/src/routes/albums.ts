import { type AlbumItem, albumCreateSchema, albumPatchSchema } from '@zephyr/shared';
import { Hono } from 'hono';
import { fail, logError, readBody } from '../http';
import { libraryContext, ownerOf, requireRole } from '../library/context';
import { LIBRARY_LIMITS, libraryGuard, UUID } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/** /api/v1/albums/*: the member's albums. Deleting an album never deletes its photos. */
export const albumRoutes = new Hono<HonoEnv>();
albumRoutes.use('*', libraryGuard(LIBRARY_LIMITS.jsonBodyBytes));
albumRoutes.use('*', requireMember, libraryContext);

type AlbumOrError = AlbumItem | { error: 'invalid' | 'limit' };
const isError = (r: AlbumOrError): r is { error: 'invalid' | 'limit' } => 'error' in r;

albumRoutes.get('/', async (c) => {
  try {
    const albums = await rpc<AlbumItem[]>(c.env, 'list_albums', { p_owner: ownerOf(c) });
    return c.json({ ok: true, albums });
  } catch (err) {
    logError(c.get('requestId'), 'albums_list', err);
    return c.json(fail('server'), 500);
  }
});

albumRoutes.post('/', requireRole('edit'), async (c) => {
  const body = await readBody(c, albumCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<AlbumOrError>(c.env, 'create_album', {
      p_owner: ownerOf(c),
      p_name: body.name,
      p_photo_ids: body.photoIds ?? null,
    });
    if (isError(res))
      return res.error === 'limit' ? c.json(fail('conflict'), 409) : c.json(fail('invalid'), 400);
    return c.json({ ok: true, album: res }, 201);
  } catch (err) {
    logError(c.get('requestId'), 'album_create', err);
    return c.json(fail('server'), 500);
  }
});

albumRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const album = await rpc<AlbumItem | null>(c.env, 'get_album', {
      p_owner: ownerOf(c),
      p_id: id,
    });
    if (!album) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, album });
  } catch (err) {
    logError(c.get('requestId'), 'album_get', err);
    return c.json(fail('server'), 500);
  }
});

albumRoutes.patch('/:id', requireRole('edit'), async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, albumPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<AlbumOrError | null>(c.env, 'patch_album', {
      p_owner: ownerOf(c),
      p_id: id,
      p_name: body.name ?? null,
      p_cover_set: 'coverPhotoId' in body,
      p_cover: body.coverPhotoId ?? null,
    });
    if (!res) return c.json(fail('not_found'), 404);
    if (isError(res)) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, album: res });
  } catch (err) {
    logError(c.get('requestId'), 'album_patch', err);
    return c.json(fail('server'), 500);
  }
});

albumRoutes.delete('/:id', requireRole('edit'), async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const ok = await rpc<boolean | null>(c.env, 'delete_album', {
      p_owner: ownerOf(c),
      p_id: id,
    });
    if (!ok) return c.json(fail('not_found'), 404);
    return c.body(null, 204);
  } catch (err) {
    logError(c.get('requestId'), 'album_delete', err);
    return c.json(fail('server'), 500);
  }
});
