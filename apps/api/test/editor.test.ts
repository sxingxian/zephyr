import {
  EDIT_API,
  type EditRecipe,
  LIBRARY_API,
  MAX_RECIPE_BYTES,
  MAX_SAVED_RECIPES,
  VARIANT_LIMITS,
} from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import migration from '../../../supabase/migrations/20261029100000_editor.sql?raw';
import { app } from '../src/app';
import { runCleanup } from '../src/jobs';
import {
  APP,
  call,
  editLimiter,
  env,
  initKeys,
  installFetch,
  type Jar,
  jar,
  must,
  r2,
  read,
  resetWorld,
  sbToken,
  type User,
  uploadLimiter,
  world,
} from './helpers';
import {
  db,
  deleteUserCascade,
  editKeyOf,
  libraryRpc,
  noDrift,
  type Photo,
  prefix,
  profile,
  resetDb,
  seedPhoto,
} from './library-db';

const MEI: User = { id: '20000000-0000-0000-0000-000000000001', email: 'mei@example.com', passkeys: 1 };
const WEI: User = { id: '20000000-0000-0000-0000-000000000002', email: 'wei@example.com', passkeys: 1 };

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  resetDb();
  world.users.push({ ...WEI });
  Object.assign(world.rpc, libraryRpc());
  world.onUserDeleted = deleteUserCascade;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- fixtures -----------------------------------------------------------------------------------------
async function signedIn(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}
function jpegVariant(w: number, h: number, size = 2000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03], 20);
  return b;
}
async function put(path: string, bytes: Uint8Array, j: Jar, headers: Record<string, string> = {}) {
  return app.request(
    `${APP}${path}`,
    {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '203.0.113.7',
        'Content-Type': 'image/jpeg',
        Origin: APP,
        Cookie: [...j.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'Content-Length': String(bytes.byteLength),
        ...headers,
      },
      body: bytes,
    },
    env,
  );
}
/** A ready photo with its original variants in R2. */
async function stored(owner: string, over: Partial<Photo> = {}) {
  const p = seedPhoto(owner, { size: 100, thumb: 40, preview: 60, ...over });
  await r2.put(`${prefix(owner, p.id)}thumb`, jpegVariant(10, 10, 40), {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  await r2.put(`${prefix(owner, p.id)}preview`, jpegVariant(20, 20, 60), {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  return p;
}
const NONCE = 'a'.repeat(32);
/** Edited-variant keys end in a per-request nonce: look them up by their version/kind prefix. */
const editObjects = (pfx: string) => [...r2.objects.keys()].filter((k) => k.startsWith(pfx));
const hasKey = (pfx: string) => editObjects(pfx).length > 0;
const warm: EditRecipe = { v: 1, light: { exposure: 0.4 }, color: { temperature: 20 } };
const save = (
  j: Jar,
  id: string,
  recipe: unknown,
  baseVersion: number | null,
  headers?: Record<string, string>,
) => call(EDIT_API.photoEdit(id), { jar: j, method: 'PUT', body: { recipe, baseVersion }, headers });
/** Saves `recipe` and uploads both edited variants for that version. */
async function renderedEdit(j: Jar, id: string, recipe: EditRecipe = warm, base: number | null = null) {
  const edit = (await read(await save(j, id, recipe, base))).edit;
  expect(
    (await put(EDIT_API.photoEditVariant(id, 'thumb', edit.version), jpegVariant(512, 384, 3000), j)).status,
  ).toBe(200);
  expect(
    (await put(EDIT_API.photoEditVariant(id, 'preview', edit.version), jpegVariant(2048, 1536, 9000), j))
      .status,
  ).toBe(200);
  return edit.version as number;
}

// ---- saving -------------------------------------------------------------------------------------------
describe('saving an edit', () => {
  it('saves a normalised recipe, then needs the current version to save again', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    expect(await read(await call(EDIT_API.photoEdit(p.id), { jar: j }))).toEqual({ ok: true, edit: null });

    const first = await save(
      j,
      p.id,
      { v: 1, light: { exposure: 0.333, contrast: 0 }, crop: { quarterTurns: 0, flipH: false } },
      null,
    );
    expect(first.status).toBe(200);
    const body = await read(first);
    expect(body.edit).toMatchObject({
      photoId: p.id,
      version: 1,
      rendered: false,
      recipe: { v: 1, light: { exposure: 0.33 } },
    });

    const stale = await save(j, p.id, warm, null);
    expect(stale.status).toBe(409);
    expect(await read(stale)).toMatchObject({ ok: false, error: 'conflict', edit: { version: 1 } });
    expect((await read(await save(j, p.id, warm, 1))).edit.version).toBe(2);
    expect(must(db.edits.get(p.id)).recipe).toEqual(warm);
  });

  it('rejects malformed recipes', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    for (const recipe of [
      { v: 2 },
      { v: 1, light: { exposure: 'x' } },
      { v: 1, script: '<x>' },
      { v: 1, light: { evil: 1 } },
    ]) {
      expect((await save(j, p.id, recipe, null)).status).toBe(400);
    }
    expect(db.edits.size).toBe(0);
  });

  it('edits only ready photos of the signed-in member', async () => {
    const mei = await signedIn(MEI);
    const wei = await signedIn(WEI);
    const p = await stored(MEI.id);
    const t = await stored(MEI.id, {
      status: 'trashed',
      trashedAt: new Date().toISOString(),
      purgeAfter: new Date().toISOString(),
    });
    expect((await save(wei, p.id, warm, null)).status).toBe(404);
    expect((await call(EDIT_API.photoEdit(p.id), { jar: wei })).status).toBe(404);
    expect((await call(EDIT_API.photoEdit(p.id), { jar: wei, method: 'DELETE' })).status).toBe(404);
    expect((await save(mei, t.id, warm, null)).status).toBe(404);
    expect((await save(mei, 'not-a-uuid', warm, null)).status).toBe(404);
    expect(db.edits.size).toBe(0);
    expect(db.owners.every((o) => o === MEI.id || o === WEI.id)).toBe(true);
  });

  it('needs a session, an allowed Origin and JSON', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    expect(
      (await call(EDIT_API.photoEdit(p.id), { method: 'PUT', body: { recipe: warm, baseVersion: null } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(EDIT_API.photoEdit(p.id), {
          jar: j,
          method: 'PUT',
          body: { recipe: warm, baseVersion: null },
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    const asBytes = await put(
      EDIT_API.photoEdit(p.id),
      new TextEncoder().encode(JSON.stringify({ recipe: warm, baseVersion: null })),
      j,
    );
    expect(asBytes.status).toBe(415);
  });

  it('is rate-limited per member and refuses a changed session (shared devices)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const changed = await save(j, p.id, warm, null, { 'X-Zephyr-Expected-User': WEI.id });
    expect(changed.status).toBe(409);
    expect(await read(changed)).toEqual({ ok: false, error: 'session_changed' });
    editLimiter.ok = false;
    expect((await save(j, p.id, warm, null)).status).toBe(429);
    expect(editLimiter.keys).toContain(`edit:${MEI.id}`);
    expect(db.edits.size).toBe(0);
  });

  it('accounts pending deletion can’t edit', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    profile(MEI.id).deletionDue = new Date(Date.now() + 86400_000).toISOString();
    const res = await save(j, p.id, warm, null);
    expect(res.status).toBe(403);
    expect((await read(res)).error).toBe('account_pending_deletion');
  });
});

// ---- edited variants ----------------------------------------------------------------------------------
describe('edited variants', () => {
  it('stores each version under its own key, counts it, and serves it (or the original on request)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'thumb'))).toBe(true);
    expect(must(db.edits.get(p.id))).toMatchObject({ thumbBytes: 3000, previewBytes: 9000 });
    // The preview's header size is recorded (galleries use its aspect); the thumb's isn't sent.
    expect(must(db.edits.get(p.id))).toMatchObject({ previewWidth: 2048, previewHeight: 1536 });
    const recorded = world.calls.filter((c) => c.url.endsWith('/rpc/record_edit_variant'));
    expect(
      recorded.map((c) => [
        (c.body as Record<string, unknown>).p_kind,
        (c.body as Record<string, unknown>).p_width,
      ]),
    ).toEqual([
      ['thumb', undefined],
      ['preview', 2048],
    ]);
    expect(noDrift(MEI.id)).toBe(true);
    expect((await read(await call(EDIT_API.photoEdit(p.id), { jar: j }))).edit.rendered).toBe(true);

    const edited = await call(LIBRARY_API.photoFile(p.id, 'thumb'), { jar: j });
    expect(edited.status).toBe(200);
    expect((await edited.arrayBuffer()).byteLength).toBe(3000);
    expect(edited.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(edited.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    const tag = must(edited.headers.get('ETag'));
    expect(tag).toMatch(new RegExp(`-e${v}"$`));
    const again = await call(LIBRARY_API.photoFile(p.id, 'thumb'), {
      jar: j,
      headers: { 'If-None-Match': tag },
    });
    expect(again.status).toBe(304);
    expect(
      (await call(LIBRARY_API.photoFile(p.id, 'thumb'), { headers: { 'If-None-Match': tag } })).status,
    ).toBe(401);

    const original = await call(`${LIBRARY_API.photoFile(p.id, 'thumb')}?original=1`, { jar: j });
    expect((await original.arrayBuffer()).byteLength).toBe(40);
    expect(original.headers.get('ETag')).not.toBe(tag);

    // A new save: the grid shows the original until the new version is rendered, then the old key goes.
    const v2 = (await read(await save(j, p.id, { v: 1, light: { exposure: 1 } }, v))).edit.version;
    expect(
      (await (await call(LIBRARY_API.photoFile(p.id, 'thumb'), { jar: j })).arrayBuffer()).byteLength,
    ).toBe(40);
    expect(
      (await put(EDIT_API.photoEditVariant(p.id, 'thumb', v2), jpegVariant(512, 384, 2500), j)).status,
    ).toBe(200);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'thumb'))).toBe(false);
    expect(hasKey(editKeyOf(MEI.id, p.id, v2, 'thumb'))).toBe(true);
    expect(
      (await (await call(LIBRARY_API.photoFile(p.id, 'thumb'), { jar: j })).arrayBuffer()).byteLength,
    ).toBe(2500);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('a variant for a version that is no longer current is refused and never stored', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v1 = (await read(await save(j, p.id, warm, null))).edit.version;
    await save(j, p.id, { v: 1, light: { exposure: 2 } }, v1);
    const res = await put(EDIT_API.photoEditVariant(p.id, 'thumb', v1), jpegVariant(512, 384), j);
    expect(res.status).toBe(410);
    expect([...r2.objects.keys()].some((k) => k.includes('/edit-'))).toBe(false);
  });

  it('a late variant that loses the race with a new save is deleted (410)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v1 = (await read(await save(j, p.id, warm, null))).edit.version;
    // The edit moves on between the pre-check and the record (another tab saved meanwhile).
    const realHead = r2.head.bind(r2);
    vi.spyOn(r2, 'head').mockImplementationOnce(async (key: string) => {
      const e = must(db.edits.get(p.id));
      e.version += 1;
      must(db.photos.get(p.id)).editVersion = e.version;
      return realHead(key);
    });
    const res = await put(EDIT_API.photoEditVariant(p.id, 'preview', v1), jpegVariant(2048, 1536, 8000), j);
    expect(res.status).toBe(410);
    expect(hasKey(editKeyOf(MEI.id, p.id, v1, 'preview'))).toBe(false);
    expect(must(db.edits.get(p.id)).previewBytes).toBe(0);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('checks the image: type, byte cap, pixel size, Content-Length', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = (await read(await save(j, p.id, warm, null))).edit.version;
    const path = (k: 'thumb' | 'preview') => EDIT_API.photoEditVariant(p.id, k, v);
    expect((await put(path('thumb'), new TextEncoder().encode('<svg onload=alert(1)>'), j)).status).toBe(415);
    expect((await put(path('thumb'), jpegVariant(1024, 768), j)).status).toBe(400);
    expect((await put(path('thumb'), jpegVariant(100, 100, 400_000), j)).status).toBe(413);
    expect((await put(path('thumb'), jpegVariant(100, 100), j, { 'Content-Length': '1' })).status).toBe(400);
    expect(
      (
        await put(
          `${EDIT_API.photoEditVariant(p.id, 'thumb', v).split('?')[0]}?v=abc`,
          jpegVariant(10, 10),
          j,
        )
      ).status,
    ).toBe(400);
    expect(
      (await put(EDIT_API.photoEditVariant(p.id, 'original' as 'thumb', v), jpegVariant(10, 10), j)).status,
    ).toBe(404);
    expect([...r2.objects.keys()].some((k) => k.includes('/edit-'))).toBe(false);
  });

  it('storage_full: the edit stays saved, the variant isn’t kept', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = (await read(await save(j, p.id, warm, null))).edit.version;
    profile(MEI.id).storage += 5 * 1024 ** 3 - profile(MEI.id).storage - 100;
    const res = await put(EDIT_API.photoEditVariant(p.id, 'preview', v), jpegVariant(2048, 1536, 9000), j);
    expect(res.status).toBe(413);
    expect((await read(res)).error).toBe('storage_full');
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'preview'))).toBe(false);
    expect(db.edits.get(p.id)?.version).toBe(v);
  });

  it('variant PUTs use the upload limiter and the expected-user check', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = (await read(await save(j, p.id, warm, null))).edit.version;
    expect(
      (
        await put(EDIT_API.photoEditVariant(p.id, 'thumb', v), jpegVariant(10, 10), j, {
          'X-Zephyr-Expected-User': WEI.id,
        })
      ).status,
    ).toBe(409);
    uploadLimiter.ok = false;
    expect((await put(EDIT_API.photoEditVariant(p.id, 'thumb', v), jpegVariant(10, 10), j)).status).toBe(429);
    expect(uploadLimiter.keys).toContain(`put:${MEI.id}`);
  });

  it('another member can’t write variants for your photo', async () => {
    const mei = await signedIn(MEI);
    const wei = await signedIn(WEI);
    const p = await stored(MEI.id);
    const v = (await read(await save(mei, p.id, warm, null))).edit.version;
    expect((await put(EDIT_API.photoEditVariant(p.id, 'thumb', v), jpegVariant(10, 10), wei)).status).toBe(
      404,
    );
    expect([...r2.objects.keys()].some((k) => k.startsWith(`u/${WEI.id}/`) || k.includes('/edit-'))).toBe(
      false,
    );
  });
});

// ---- revert, list, detail -----------------------------------------------------------------------------
describe('revert and library views', () => {
  it('revert deletes the edit and its variants and frees their bytes', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    expect((await call(EDIT_API.photoEdit(p.id), { jar: j, method: 'DELETE' })).status).toBe(204);
    expect(db.edits.has(p.id)).toBe(false);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'thumb'))).toBe(false);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'preview'))).toBe(false);
    expect(noDrift(MEI.id)).toBe(true);
    // A render that was in flight for the reverted version can't come back.
    expect((await put(EDIT_API.photoEditVariant(p.id, 'thumb', v), jpegVariant(10, 10), j)).status).toBe(410);
    expect((await call(EDIT_API.photoEdit(p.id), { jar: j, method: 'DELETE' })).status).toBe(204);
  });

  it('the list says which photos are edited; the edited view and detail carry them', async () => {
    const j = await signedIn(MEI);
    const a = await stored(MEI.id);
    const b = await stored(MEI.id);
    await renderedEdit(j, a.id);
    const items = (await read(await call(`${LIBRARY_API.photos}?view=library`, { jar: j }))).items;
    expect(items.find((x: { id: string }) => x.id === a.id).edit).toEqual({ version: 1, rendered: true });
    expect(items.find((x: { id: string }) => x.id === b.id).edit).toBeNull();
    const edited = (await read(await call(`${LIBRARY_API.photos}?view=edited`, { jar: j }))).items;
    expect(edited.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await read(await call(LIBRARY_API.photo(a.id), { jar: j }))).photo.recipe).toEqual(warm);
  });
});

// ---- bulk ---------------------------------------------------------------------------------------------
describe('bulk paste, apply and revert', () => {
  const bulk = (j: Jar, body: unknown, headers?: Record<string, string>) =>
    call(EDIT_API.editsBulk, { jar: j, body, headers });

  it('merges the ticked sections into each photo and returns the new edits', async () => {
    const j = await signedIn(MEI);
    const a = await stored(MEI.id);
    const b = await stored(MEI.id);
    await save(j, a.id, { v: 1, light: { exposure: 1 }, crop: { angle: 3 } }, null);
    const res = await bulk(j, {
      ids: [a.id, b.id, a.id],
      recipe: { v: 1, light: { contrast: 10 }, color: { tint: 5 }, crop: { angle: -2 } },
      sections: ['light', 'color'],
    });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.affected).toBe(2);
    expect(must(db.edits.get(a.id)).recipe).toEqual({
      v: 1,
      light: { contrast: 10 },
      color: { tint: 5 },
      crop: { angle: 3 },
    });
    expect(must(db.edits.get(b.id)).recipe).toEqual({ v: 1, light: { contrast: 10 }, color: { tint: 5 } });
    expect(body.edits.map((e: { photoId: string }) => e.photoId).sort()).toEqual([a.id, b.id].sort());
  });

  it('skips unchanged photos and other members’ photos', async () => {
    const mei = await signedIn(MEI);
    const a = await stored(MEI.id);
    const w = await stored(WEI.id);
    await save(mei, a.id, warm, null);
    const res = await read(
      await bulk(mei, { ids: [a.id, w.id], recipe: warm, sections: ['light', 'color'] }),
    );
    expect(res.affected).toBe(0);
    expect(db.edits.has(w.id)).toBe(false);
    expect(must(db.edits.get(a.id)).version).toBe(1);
  });

  it('revert (recipe null) removes edits and their variants', async () => {
    const j = await signedIn(MEI);
    const a = await stored(MEI.id);
    const b = await stored(MEI.id);
    const v = await renderedEdit(j, a.id);
    const res = await read(await bulk(j, { ids: [a.id, b.id], recipe: null, sections: [] }));
    expect(res).toMatchObject({ ok: true, affected: 1, edits: [{ photoId: a.id, edit: null }] });
    expect(hasKey(editKeyOf(MEI.id, a.id, v, 'thumb'))).toBe(false);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('a photo saved meanwhile is re-read and merged again, never overwritten from a stale read', async () => {
    const j = await signedIn(MEI);
    const a = await stored(MEI.id);
    await save(j, a.id, { v: 1, effects: { vignette: -10 } }, null);
    const rpc = world.rpc.apply_bulk_edits as (x: Record<string, unknown>) => unknown;
    let raced = false;
    world.rpc.apply_bulk_edits = (x) => {
      if (!raced) {
        raced = true; // another tab saves between the read and the write
        const e = must(db.edits.get(a.id));
        Object.assign(e, {
          recipe: { v: 1, effects: { vignette: -10 }, detail: { sharpening: 30 } },
          version: e.version + 1,
        });
      }
      return rpc(x);
    };
    const res = await read(
      await bulk(j, { ids: [a.id], recipe: { v: 1, light: { exposure: 0.5 } }, sections: ['light'] }),
    );
    expect(res.affected).toBe(1);
    expect(must(db.edits.get(a.id)).recipe).toEqual({
      v: 1,
      light: { exposure: 0.5 },
      effects: { vignette: -10 },
      detail: { sharpening: 30 },
    });
  });

  it('is capped by the plan’s batch size', async () => {
    const j = await signedIn(MEI);
    const ids = Array.from({ length: 26 }, () => crypto.randomUUID());
    const res = await bulk(j, { ids, recipe: warm, sections: ['light'] });
    expect(res.status).toBe(413);
    expect((await read(res)).error).toBe('too_large');
    expect((await bulk(j, { ids: ids.slice(0, 25), recipe: warm, sections: ['light'] })).status).toBe(200);
    expect((await bulk(j, { ids: [ids[0]], recipe: warm, sections: [] })).status).toBe(400);
    expect(
      (
        await bulk(
          j,
          { ids: [ids[0]], recipe: warm, sections: ['light'] },
          { 'X-Zephyr-Expected-User': WEI.id },
        )
      ).status,
    ).toBe(409);
  });
});

// ---- recipes ------------------------------------------------------------------------------------------
describe('saved recipes', () => {
  it('create, list, rename, replace and delete; never a crop; per member', async () => {
    const mei = await signedIn(MEI);
    const wei = await signedIn(WEI);
    const created = await call(EDIT_API.recipes, {
      jar: mei,
      body: { name: '  Soft\u0007 film ', recipe: { v: 1, color: { saturation: -10 }, crop: { angle: 4 } } },
    });
    expect(created.status).toBe(201);
    const r = (await read(created)).recipe;
    expect(r).toMatchObject({ name: 'Soft film', recipe: { v: 1, color: { saturation: -10 } } });
    expect((await read(await call(EDIT_API.recipes, { jar: mei }))).recipes).toHaveLength(1);
    expect((await read(await call(EDIT_API.recipes, { jar: wei }))).recipes).toEqual([]);
    expect(
      (await call(EDIT_API.recipe(r.id), { jar: wei, method: 'PATCH', body: { name: 'Mine' } })).status,
    ).toBe(404);
    expect((await call(EDIT_API.recipe(r.id), { jar: wei, method: 'DELETE' })).status).toBe(404);
    const renamed = await call(EDIT_API.recipe(r.id), {
      jar: mei,
      method: 'PATCH',
      body: { name: 'Softer' },
    });
    expect((await read(renamed)).recipe.name).toBe('Softer');
    expect((await call(EDIT_API.recipe(r.id), { jar: mei, method: 'PATCH', body: {} })).status).toBe(400);
    expect((await call(EDIT_API.recipe(r.id), { jar: mei, method: 'DELETE' })).status).toBe(204);
    expect(db.recipes.size).toBe(0);
  });

  it('rejects bad names and recipes, and stops at 200', async () => {
    const j = await signedIn(MEI);
    expect((await call(EDIT_API.recipes, { jar: j, body: { name: '', recipe: { v: 1 } } })).status).toBe(400);
    expect(
      (await call(EDIT_API.recipes, { jar: j, body: { name: 'x'.repeat(61), recipe: { v: 1 } } })).status,
    ).toBe(400);
    expect(
      (await call(EDIT_API.recipes, { jar: j, body: { name: 'x', recipe: { v: 1, evil: 1 } } })).status,
    ).toBe(400);
    for (let i = 0; i < 200; i++) {
      db.recipes.set(`r${i}`, {
        id: `r${i}`,
        owner: MEI.id,
        name: 'r',
        recipe: { v: 1 },
        createdAt: '',
        updatedAt: '',
      });
    }
    const full = await call(EDIT_API.recipes, { jar: j, body: { name: 'one more', recipe: { v: 1 } } });
    expect(full.status).toBe(409);
    expect((await read(full)).error).toBe('quota_exceeded');
  });

  it('writes are rate-limited; reads are not', async () => {
    const j = await signedIn(MEI);
    editLimiter.ok = false;
    expect((await call(EDIT_API.recipes, { jar: j })).status).toBe(200);
    expect((await call(EDIT_API.recipes, { jar: j, body: { name: 'x', recipe: { v: 1 } } })).status).toBe(
      429,
    );
  });
});

// ---- clean-up -----------------------------------------------------------------------------------------
describe('clean-up knows about edited variants', () => {
  it('purging a photo deletes its edited variants and their bytes', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    expect(
      (await call(LIBRARY_API.photosBulk, { jar: j, body: { ids: [p.id], action: 'trash' } })).status,
    ).toBe(200);
    expect(
      (await call(LIBRARY_API.photosBulk, { jar: j, body: { ids: [p.id], action: 'delete_forever' } }))
        .status,
    ).toBe(200);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'thumb'))).toBe(false);
    expect(db.photos.has(p.id)).toBe(false);
    expect(db.edits.has(p.id)).toBe(false);
    expect(profile(MEI.id).storage).toBe(0);
  });

  it('the sweep deletes unrecorded edit versions after an hour, keeps recorded and fresh ones', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const stale = editKeyOf(MEI.id, p.id, v + 5, 'thumb') + NONCE;
    const fresh = editKeyOf(MEI.id, p.id, v + 6, 'preview') + NONCE;
    const ghost = editKeyOf(MEI.id, crypto.randomUUID(), 1, 'thumb') + NONCE;
    await r2.put(stale, 'x');
    await r2.put(fresh, 'x');
    await r2.put(ghost, 'x');
    r2.backdate(stale, 2 * 3600_000);
    r2.backdate(must(must(db.edits.get(p.id)).thumbKey), 2 * 3600_000);
    const counts = await runCleanup(env);
    expect(counts.orphansDeleted).toBe(2);
    expect(r2.objects.has(stale)).toBe(false);
    expect(r2.objects.has(ghost)).toBe(false);
    expect(r2.objects.has(fresh)).toBe(true);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'thumb'))).toBe(true);
    expect(hasKey(editKeyOf(MEI.id, p.id, v, 'preview'))).toBe(true);
  });
});

describe('clean-up knows about masks (phase 6)', () => {
  it('the sweep deletes masks no row records after an hour, keeps recorded and fresh ones', async () => {
    const p = await stored(MEI.id);
    const m = (n: number) => `u/${MEI.id}/p/${p.id}/m/6${n}000000-0000-4000-8000-000000000000.png`;
    const kept = m(1);
    const stale = m(2);
    const fresh = m(3);
    db.maskKeys.set(p.id, [kept]);
    for (const k of [kept, stale, fresh]) await r2.put(k, 'x');
    r2.backdate(kept, 2 * 3600_000);
    r2.backdate(stale, 2 * 3600_000);
    const counts = await runCleanup(env);
    expect(counts.orphansDeleted).toBe(1);
    expect(r2.objects.has(stale)).toBe(false);
    expect(r2.objects.has(kept)).toBe(true);
    expect(r2.objects.has(fresh)).toBe(true);
  });
});

describe('editor constants match the migration', () => {
  it('recipe size cap and variant caps', () => {
    expect(migration).toContain(`octet_length(recipe::text) <= ${MAX_RECIPE_BYTES}`);
    expect(migration).toContain(`thumb_bytes between 0 and ${VARIANT_LIMITS.thumb.maxBytes}`);
    expect(migration).toContain(`preview_bytes between 0 and ${VARIANT_LIMITS.preview.maxBytes}`);
    expect(migration).toContain(`>= ${MAX_SAVED_RECIPES} then`);
  });
});

// ---- review fixes: canonical ids, one key per PUT, bulk skips -----------------------------------------
describe('ids must be canonical (lower case)', () => {
  it('upper-case ids get 404 on every photo route and write nothing', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id, { id: 'abcdef00-1111-4222-8333-444455556666' });
    const v = await renderedEdit(j, p.id);
    const before = [...r2.objects.keys()].sort();
    const up = p.id.toUpperCase();
    expect(up).not.toBe(p.id);
    expect(
      (await put(EDIT_API.photoEditVariant(up, 'preview', v), jpegVariant(2048, 1536, 9000), j)).status,
    ).toBe(404);
    expect((await call(LIBRARY_API.photoFile(up, 'preview'), { jar: j })).status).toBe(404);
    expect((await call(EDIT_API.photoEdit(up), { jar: j })).status).toBe(404);
    expect((await call(LIBRARY_API.photo(up), { jar: j })).status).toBe(404);
    expect([...r2.objects.keys()].sort()).toEqual(before);
    expect(noDrift(MEI.id)).toBe(true);
  });
  it('the sweep deletes keys whose ids are spelled in another case, whatever their age', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    await renderedEdit(j, p.id);
    // (MEI's id is all digits, so spell the ids with letters explicitly.)
    const upper = `u/${MEI.id}/p/ABCDEF01-0000-4000-8000-00000000000A/edit-1-preview-${NONCE}`;
    const upperOwner = `u/ABCDEF02-0000-4000-8000-00000000000B/p/${p.id}/thumb`;
    await r2.put(upper, 'x');
    await r2.put(upperOwner, 'x');
    const live = [...r2.objects.keys()].filter((k) => k !== upper && k !== upperOwner);
    const counts = await runCleanup(env);
    expect(counts.orphansDeleted).toBe(2);
    expect(r2.objects.has(upper)).toBe(false);
    expect(r2.objects.has(upperOwner)).toBe(false);
    for (const k of live) expect(r2.objects.has(k)).toBe(true);
  });
});

describe('every variant PUT writes its own key', () => {
  it('a repeat PUT for a recorded version is a no-op 200: nothing written, the live variant untouched (P1)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const liveKey = must(must(db.edits.get(p.id)).previewKey);
    const liveBytes = must(r2.objects.get(liveKey)).bytes.byteLength;
    // Even with storage nearly full, a duplicate must not be reported as storage_full nor delete anything.
    profile(MEI.id).storage = 5 * 1024 ** 3 - 10;
    const objects = r2.objects.size;
    const res = await put(
      EDIT_API.photoEditVariant(p.id, 'preview', v),
      jpegVariant(2048, 1536, 1_500_000),
      j,
    );
    expect(res.status).toBe(200);
    expect(r2.objects.size).toBe(objects);
    expect(must(r2.objects.get(liveKey)).bytes.byteLength).toBe(liveBytes);
    expect(r2.deleted).not.toContain(liveKey);
    expect(must(db.edits.get(p.id)).previewBytes).toBe(9000);
  });
  it('a duplicate recorded between the check and the record deletes only its own object', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const edit = (await read(await save(j, p.id, warm, null))).edit;
    // Two PUTs for the same version race: the first one records while the second is still uploading.
    const record = world.rpc.record_edit_variant as (a: Record<string, unknown>) => unknown;
    let first: string | null = null;
    world.rpc.record_edit_variant = (a) => {
      if (!first) {
        first = String(a.p_key);
        return record(a);
      }
      return record(a);
    };
    expect(
      (await put(EDIT_API.photoEditVariant(p.id, 'thumb', edit.version), jpegVariant(512, 384, 3000), j))
        .status,
    ).toBe(200);
    // Second PUT: make the pre-check say "current" (as if it ran before the first recorded).
    const check = world.rpc.edit_variant_check as (a: Record<string, unknown>) => unknown;
    world.rpc.edit_variant_check = () => ({ status: 'current' });
    const res = await put(
      EDIT_API.photoEditVariant(p.id, 'thumb', edit.version),
      jpegVariant(512, 384, 2000),
      j,
    );
    world.rpc.edit_variant_check = check;
    expect(res.status).toBe(200);
    const thumbs = editObjects(editKeyOf(MEI.id, p.id, edit.version, 'thumb'));
    expect(thumbs).toEqual([must(first)]);
    expect(must(db.edits.get(p.id))).toMatchObject({ thumbKey: first, thumbBytes: 3000 });
    expect(noDrift(MEI.id)).toBe(true);
  });
  it('a PUT racing a trash deletes only its own object, never the trashed photo’s variant (P2)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const liveKey = must(must(db.edits.get(p.id)).previewKey);
    const v2 = (await read(await save(j, p.id, { v: 1, light: { exposure: 2 } }, v))).edit.version;
    const record = world.rpc.record_edit_variant as (a: Record<string, unknown>) => unknown;
    world.rpc.record_edit_variant = (a) => {
      must(db.photos.get(p.id)).status = 'trashed'; // the trash lands between the write and the record
      return record(a);
    };
    const res = await put(EDIT_API.photoEditVariant(p.id, 'preview', v2), jpegVariant(2048, 1536, 9000), j);
    expect(res.status).toBe(410);
    expect(r2.objects.has(liveKey)).toBe(true);
    expect(editObjects(editKeyOf(MEI.id, p.id, v2, 'preview'))).toEqual([]);
  });
  it('a write that fails before its record leaves the counted variant and its size as they were (P4)', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const v2 = (await read(await save(j, p.id, { v: 1, light: { exposure: 2 } }, v))).edit.version;
    const liveKey = must(must(db.edits.get(p.id)).previewKey);
    world.rpc.record_edit_variant = () => {
      throw new Error('rpc down');
    };
    const res = await put(
      EDIT_API.photoEditVariant(p.id, 'preview', v2),
      jpegVariant(2048, 1536, 1_500_000),
      j,
    );
    expect(res.status).toBe(500);
    // The live object is the one that's counted, byte for byte. This request's object is left for the
    // orphan sweep: the record call failed, so the database might have committed it.
    expect(must(r2.objects.get(liveKey)).bytes.byteLength).toBe(must(db.edits.get(p.id)).previewBytes);
    expect(editObjects(editKeyOf(MEI.id, p.id, v2, 'preview'))).toHaveLength(1);
  });
  it('a record that commits but then fails in transit keeps the object the database recorded', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const v2 = (await read(await save(j, p.id, { v: 1, light: { exposure: 2 } }, v))).edit.version;
    const record = world.rpc.record_edit_variant as (a: Record<string, unknown>) => unknown;
    world.rpc.record_edit_variant = (a) => {
      record(a); // committed…
      throw new Error('timeout'); // …but the reply never arrived
    };
    const res = await put(EDIT_API.photoEditVariant(p.id, 'preview', v2), jpegVariant(2048, 1536, 9000), j);
    expect(res.status).toBe(500);
    const recorded = must(must(db.edits.get(p.id)).previewKey);
    expect(recorded.includes(`edit-${v2}-preview-`)).toBe(true);
    expect(r2.objects.has(recorded)).toBe(true);
  });
  it('the database refuses a key that isn’t this photo’s, version’s and kind’s', () => {
    const rec = libraryRpc().record_edit_variant as (a: Record<string, unknown>) => { status: string };
    const p = seedPhoto(MEI.id);
    db.edits.set(p.id, {
      photoId: p.id,
      owner: MEI.id,
      recipe: { v: 1, light: { exposure: 1 } },
      version: 1,
      thumbVersion: null,
      thumbKey: null,
      thumbBytes: 0,
      previewVersion: null,
      previewKey: null,
      previewBytes: 0,
      updatedAt: new Date().toISOString(),
    });
    const base = { p_owner: MEI.id, p_photo: p.id, p_version: 1, p_kind: 'thumb', p_bytes: 10 };
    expect(rec({ ...base, p_key: `${prefix(MEI.id, p.id)}thumb` }).status).toBe('invalid');
    expect(rec({ ...base, p_key: `${editKeyOf(MEI.id, p.id, 2, 'thumb')}${NONCE}` }).status).toBe('invalid');
    expect(
      rec({ ...base, p_key: `${editKeyOf(MEI.id, p.id, 1, 'thumb')}${NONCE.toUpperCase()}` }).status,
    ).toBe('invalid');
    expect(rec({ ...base, p_key: `${editKeyOf(MEI.id, p.id, 1, 'thumb')}${NONCE}` }).status).toBe('ok');
  });
  it('the sweep keeps the recorded key and deletes an old unrecorded one of the same version', async () => {
    const j = await signedIn(MEI);
    const p = await stored(MEI.id);
    const v = await renderedEdit(j, p.id);
    const recorded = must(must(db.edits.get(p.id)).thumbKey);
    const loser = `${editKeyOf(MEI.id, p.id, v, 'thumb')}${'b'.repeat(32)}`;
    await r2.put(loser, 'x');
    r2.backdate(loser, 2 * 3600_000);
    r2.backdate(recorded, 2 * 3600_000);
    await runCleanup(env);
    expect(r2.objects.has(loser)).toBe(false);
    expect(r2.objects.has(recorded)).toBe(true);
  });
});

describe('bulk reports photos it had to skip', () => {
  it('photos still changing after every attempt come back in skipped', async () => {
    const j = await signedIn(MEI);
    const a = await stored(MEI.id);
    const b = await stored(MEI.id);
    world.rpc.apply_bulk_edits = (args) => {
      const items = args.p_items as { photoId: string }[];
      return { applied: [], conflicts: items.map((i) => i.photoId) };
    };
    const res = await call(EDIT_API.editsBulk, {
      jar: j,
      method: 'POST',
      body: { ids: [a.id, b.id], recipe: warm, sections: ['light', 'color'] },
    });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.affected).toBe(0);
    expect([...body.skipped].sort()).toEqual([a.id, b.id].sort());
  });
});
