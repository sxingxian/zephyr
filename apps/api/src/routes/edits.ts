import {
  type EditBulkResult,
  type EditRecipe,
  type EditSaveResult,
  editBulkSchema,
  editSaveSchema,
  isEmptyRecipe,
  mergeRecipe,
  type PhotoEdit,
  recipeJson,
  VARIANT_LIMITS,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { background, fail, logError, rateLimited, readBody } from '../http';
import { imageInfo } from '../library/files';
import { contentLength, deleteKeys, editKey, expectedUser, readExact, UUID } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

/**
 * The editor's photo routes (docs/phase-4.md, Saving edits and edited thumbnails), mounted inside
 * photoRoutes before its `/:id/:kind` media route, so the library guard and requireMember already ran:
 *   GET/PUT/DELETE /api/v1/photos/:id/edit
 *   PUT            /api/v1/photos/:id/edit/variants/:kind?v=<version>
 *   POST           /api/v1/photos/edits/bulk
 */
export const editRoutes = new Hono<HonoEnv>();

type Ctx = Context<HonoEnv>;
const ownerOf = (c: Ctx) => c.get('session').userId;

/** Bulk merges retried after a concurrent change before giving up on those photos. */
const BULK_ATTEMPTS = 3;

/** Per-member limit on edit writes (the EDIT_LIMITER binding: 600 a minute). */
const editWriteLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!(await c.env.EDIT_LIMITER.limit({ key: `edit:${ownerOf(c)}` })).success) return rateLimited(c, 60);
  await next();
};
const writesOnly: MiddlewareHandler<HonoEnv> = async (c, next) =>
  c.req.method === 'GET' || c.req.method === 'HEAD' ? next() : expectedUser(c, next);

/** Deletes R2 objects after the response (waitUntil); failures are left to the orphan sweep. */
async function dropLater(c: Ctx, keys: string[], where: string) {
  if (!keys.length) return;
  const requestId = c.get('requestId');
  await background(c, async () => {
    try {
      await deleteKeys(c.env.PHOTOS, keys);
    } catch (err) {
      logError(requestId, where, err);
    }
  });
}

// ---- single photo ----------------------------------------------------------------------------------------
editRoutes.use('/:id/edit', writesOnly, editWriteLimit);

editRoutes.get('/:id/edit', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const res = await rpc<{ edit: PhotoEdit | null } | null>(c.env, 'get_edit', {
      p_owner: ownerOf(c),
      p_photo: id,
    });
    if (!res) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, edit: res.edit });
  } catch (err) {
    logError(c.get('requestId'), 'edit_get', err);
    return c.json(fail('server'), 500);
  }
});

editRoutes.put('/:id/edit', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, editSaveSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<{ status: 'ok' | 'conflict' | 'invalid'; edit?: PhotoEdit | null } | null>(
      c.env,
      'save_edit',
      { p_owner: ownerOf(c), p_photo: id, p_recipe: body.recipe, p_base_version: body.baseVersion },
    );
    if (!res) return c.json(fail('not_found'), 404);
    if (res.status === 'conflict') return c.json({ ...fail('conflict'), edit: res.edit ?? null }, 409);
    if (res.status !== 'ok' || !res.edit) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, edit: res.edit } satisfies EditSaveResult);
  } catch (err) {
    logError(c.get('requestId'), 'edit_save', err);
    return c.json(fail('server'), 500);
  }
});

editRoutes.delete('/:id/edit', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const res = await rpc<{ keys: string[] } | null>(c.env, 'delete_edit', {
      p_owner: ownerOf(c),
      p_photo: id,
    });
    if (!res) return c.json(fail('not_found'), 404);
    await dropLater(c, res.keys, 'edit_revert_r2');
    return c.body(null, 204);
  } catch (err) {
    logError(c.get('requestId'), 'edit_delete', err);
    return c.json(fail('server'), 500);
  }
});

// ---- edited variants -------------------------------------------------------------------------------------
editRoutes.use('/:id/edit/variants/:kind', expectedUser);

editRoutes.put('/:id/edit/variants/:kind', async (c) => {
  const id = c.req.param('id');
  const kind = c.req.param('kind');
  if (!UUID.test(id) || (kind !== 'thumb' && kind !== 'preview')) return c.json(fail('not_found'), 404);
  const rawV = c.req.query('v') ?? '';
  if (!/^[1-9][0-9]{0,9}$/.test(rawV) || Number(rawV) > 2_147_483_647) return c.json(fail('invalid'), 400);
  const version = Number(rawV);
  const limits = VARIANT_LIMITS[kind];
  const owner = ownerOf(c);
  try {
    // Same per-member ceiling as upload parts and variants.
    if (!(await c.env.UPLOAD_LIMITER.limit({ key: `put:${owner}` })).success) return rateLimited(c, 60);
    const len = contentLength(c.req.header('Content-Length'));
    if (len === null) return c.json(fail('invalid'), 411);
    if (len > limits.maxBytes) return c.json(fail('too_large'), 413);
    if (len < 1) return c.json(fail('invalid'), 400);
    // Cheap pre-check so a stale render (the common case after quick edits) never touches R2.
    const current = await rpc<{ edit: PhotoEdit | null } | null>(c.env, 'get_edit', {
      p_owner: owner,
      p_photo: id,
    });
    if (!current) return c.json(fail('not_found'), 404);
    if (current.edit?.version !== version) return c.json(fail('conflict'), 410);
    const bytes = await readExact(c.req.raw.body, len);
    if (!bytes) return c.json(fail('invalid'), 400);
    const info = imageInfo(bytes);
    if (!info) return c.json(fail('invalid'), 415);
    if (info.width > limits.maxEdge || info.height > limits.maxEdge) return c.json(fail('invalid'), 400);

    // Each version has its own key; the database decides (under the storage lock) whether it counts.
    const key = editKey(owner, id, version, kind);
    await c.env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType: info.format === 'jpeg' ? 'image/jpeg' : 'image/webp' },
    });
    const head = await c.env.PHOTOS.head(key);
    if (!head) return c.json(fail('server'), 500);
    const res = await rpc<{
      status: 'ok' | 'gone' | 'storage_full' | 'invalid';
      previousKey?: string | null;
    }>(c.env, 'record_edit_variant', {
      p_owner: owner,
      p_photo: id,
      p_version: version,
      p_kind: kind,
      p_bytes: head.size,
    });
    if (res.status === 'ok') {
      if (res.previousKey) await dropLater(c, [res.previousKey], 'edit_variant_replace');
      return c.json({ ok: true });
    }
    // Not counted: this object must not stay. A version that's no longer current reuses nothing, so
    // deleting its key can't touch a live variant.
    await dropLater(c, [key], 'edit_variant_unstore');
    if (res.status === 'storage_full') return c.json(fail('storage_full'), 413);
    if (res.status === 'gone') return c.json(fail('conflict'), 410);
    return c.json(fail('invalid'), 400);
  } catch (err) {
    logError(c.get('requestId'), 'edit_variant', err);
    return c.json(fail('server'), 500);
  }
});

// ---- bulk ------------------------------------------------------------------------------------------------
interface BulkState {
  batchSize: number | null;
  items: { photoId: string; version: number | null; recipe: EditRecipe | null }[];
}
interface BulkApply {
  applied?: { photoId: string; edit: PhotoEdit | null }[];
  conflicts?: string[];
  keys?: string[];
  error?: string;
}

editRoutes.use('/edits/bulk', expectedUser, editWriteLimit);

/**
 * Paste edits, apply a recipe, or revert, for up to the plan's batch size. The merge is the shared
 * mergeRecipe, done here: read each photo's current edit, merge, then write back only where the edit is
 * still at the version that was read (a concurrent save is re-read and merged again).
 */
editRoutes.post('/edits/bulk', async (c) => {
  const body = await readBody(c, editBulkSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const owner = ownerOf(c);
  const ids = [...new Set(body.ids.map((i) => i.toLowerCase()))];
  try {
    const applied: { photoId: string; edit: PhotoEdit | null }[] = [];
    const drop: string[] = [];
    let pending = ids;
    for (let attempt = 0; attempt < BULK_ATTEMPTS && pending.length; attempt++) {
      const state = await rpc<BulkState>(c.env, 'bulk_edit_state', { p_owner: owner, p_ids: pending });
      if (attempt === 0 && (state.batchSize === null || ids.length > state.batchSize)) {
        return c.json(fail('too_large'), 413);
      }
      const items = state.items.flatMap((it) => {
        const has = it.version !== null;
        let next: EditRecipe | null;
        if (body.recipe === null) {
          next = null;
        } else {
          const merged = mergeRecipe(
            it.recipe,
            body.recipe,
            body.sections as Parameters<typeof mergeRecipe>[2],
          );
          next = isEmptyRecipe(merged) ? null : merged;
        }
        if (next === null && !has) return []; // nothing to revert
        if (next !== null && has && recipeJson(next) === recipeJson(it.recipe)) return []; // unchanged
        return [{ photoId: it.photoId, baseVersion: it.version, recipe: next }];
      });
      if (!items.length) break;
      const res = await rpc<BulkApply>(c.env, 'apply_bulk_edits', { p_owner: owner, p_items: items });
      if (res.error) return c.json(fail('invalid'), 400);
      applied.push(...(res.applied ?? []));
      drop.push(...(res.keys ?? []));
      pending = res.conflicts ?? [];
    }
    await dropLater(c, drop, 'edit_bulk_r2');
    return c.json({ ok: true, affected: applied.length, edits: applied } satisfies EditBulkResult);
  } catch (err) {
    logError(c.get('requestId'), 'edit_bulk', err);
    return c.json(fail('server'), 500);
  }
});
