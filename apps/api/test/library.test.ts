import { FILE_TYPES, LIBRARY_API, UPLOAD_PART_SIZE, VARIANT_LIMITS } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import migration from '../../../supabase/migrations/20261028200000_library.sql?raw';
import { app } from '../src/app';
import worker from '../src/index';
import { runCleanup } from '../src/jobs';
import {
  APP,
  call,
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
async function signedIn(u: User, authAgo = 0): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email, authAgo }));
  return j;
}

/** A JPEG-looking file: SOI + APP0, then filler. */
function jpegFile(size: number, seed = 1): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return b;
}
/** A real JPEG header with a frame of w×h, padded to `size`. */
function jpegVariant(w: number, h: number, size = 2000): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03], 20);
  return b;
}
/** A WEBP (VP8X) header of w×h, padded to `size`. */
function webpVariant(w: number, h: number, size = 4000): Uint8Array {
  const b = new Uint8Array(size);
  const ascii = (s: string, at: number) =>
    b.set(
      [...s].map((c) => c.charCodeAt(0)),
      at,
    );
  ascii('RIFF', 0);
  ascii('WEBP', 8);
  ascii('VP8X', 12);
  b.set([10, 0, 0, 0], 16);
  const w1 = w - 1;
  const h1 = h - 1;
  b.set([w1 & 0xff, (w1 >> 8) & 0xff, (w1 >> 16) & 0xff, h1 & 0xff, (h1 >> 8) & 0xff, (h1 >> 16) & 0xff], 24);
  return b;
}
async function sha(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

interface PutOpts {
  jar: Jar;
  length?: string | null;
  type?: string;
  origin?: string | null;
}
async function put(path: string, bytes: Uint8Array, o: PutOpts): Promise<Response> {
  const h: Record<string, string> = {
    'CF-Connecting-IP': '203.0.113.7',
    'Content-Type': o.type ?? 'application/octet-stream',
    Cookie: [...o.jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  if (o.origin !== null) h.Origin = o.origin ?? APP;
  if (o.length !== null) h['Content-Length'] = o.length ?? String(bytes.byteLength);
  return app.request(`${APP}${path}`, { method: 'PUT', headers: h, body: bytes }, env);
}

async function createUpload(j: Jar, name: string, bytes: Uint8Array) {
  const res = await call(LIBRARY_API.uploads, {
    jar: j,
    body: { files: [{ name, size: bytes.byteLength, sha256: await sha(bytes) }] },
  });
  expect(res.status).toBe(200);
  return (await read(res)).results[0];
}

/** Uploads every part of `bytes`, both variants, and completes. Returns the completion response. */
async function uploadWhole(j: Jar, uploadId: string, bytes: Uint8Array, partCount: number) {
  for (let n = 1; n <= partCount; n++) {
    const part = bytes.subarray((n - 1) * UPLOAD_PART_SIZE, n * UPLOAD_PART_SIZE);
    const res = await put(LIBRARY_API.uploadPart(uploadId, n), part, { jar: j });
    expect(res.status).toBe(200);
  }
  expect(
    (await put(LIBRARY_API.uploadVariant(uploadId, 'thumb'), jpegVariant(512, 384), { jar: j })).status,
  ).toBe(200);
  expect(
    (await put(LIBRARY_API.uploadVariant(uploadId, 'preview'), webpVariant(2048, 1536), { jar: j })).status,
  ).toBe(200);
  return call(LIBRARY_API.uploadComplete(uploadId), {
    jar: j,
    body: {
      metadata: { width: 6000, height: 4000, takenAt: '2026-06-01T10:00:00+08:00', cameraModel: 'X-T5' },
    },
  });
}

/** A ready photo with all three objects in R2. */
async function storedPhoto(owner: string, over: Partial<Photo> = {}) {
  const thumb = webpVariant(10, 10, 40);
  const preview = jpegVariant(20, 20, 60);
  const p = seedPhoto(owner, { size: 100, thumb: thumb.byteLength, preview: preview.byteLength, ...over });
  const original = jpegFile(p.size);
  await r2.put(`${prefix(owner, p.id)}original`, original, { httpMetadata: { contentType: 'image/jpeg' } });
  await r2.put(`${prefix(owner, p.id)}thumb`, thumb, { httpMetadata: { contentType: 'image/webp' } });
  await r2.put(`${prefix(owner, p.id)}preview`, preview, { httpMetadata: { contentType: 'image/jpeg' } });
  return { photo: p, original };
}

/** Byte equality without vitest's element-by-element diff (too slow for 16 MiB). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const objectsUnder = (owner: string) => [...r2.objects.keys()].filter((k) => k.startsWith(`u/${owner}/`));

// ---- uploads ------------------------------------------------------------------------------------------
describe('uploads', () => {
  it('uploads a two-part file, its variants and metadata, then serves it back', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 1000);
    const d = await createUpload(j, 'IMG_0420.JPG', bytes);
    expect(d).toMatchObject({ status: 'ready', partSize: UPLOAD_PART_SIZE, partCount: 2, fileType: 'jpeg' });
    expect(d.r2Key).toBeUndefined();

    const res = await uploadWhole(j, d.uploadId, bytes, 2);
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.photo).toMatchObject({
      id: d.photoId,
      filename: 'IMG_0420.JPG',
      hasThumb: true,
      hasPreview: true,
    });

    const stored = must(r2.objects.get(`${prefix(MEI.id, d.photoId)}original`));
    expect(sameBytes(stored.bytes, bytes)).toBe(true);
    expect(stored.contentType).toBe('image/jpeg');
    expect(r2.multiparts.size).toBe(0);
    expect(noDrift(MEI.id)).toBe(true);
    expect(must(db.profiles.get(MEI.id)).reserved).toBe(0);

    const dl = await call(LIBRARY_API.photoFile(d.photoId, 'original'), { jar: j });
    expect(dl.status).toBe(200);
    expect(sameBytes(new Uint8Array(await dl.arrayBuffer()), bytes)).toBe(true);
  });

  it('reports upload status for resuming', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 10);
    const d = await createUpload(j, 'a.jpg', bytes);
    await put(LIBRARY_API.uploadPart(d.uploadId, 2), bytes.subarray(UPLOAD_PART_SIZE), { jar: j });
    await put(LIBRARY_API.uploadVariant(d.uploadId, 'thumb'), jpegVariant(100, 100), { jar: j });
    const res = await call(LIBRARY_API.upload(d.uploadId), { jar: j });
    expect(await read(res)).toMatchObject({ ok: true, partsDone: [2], variantsDone: ['thumb'] });
  });

  it('requires Content-Length to match the part exactly', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 1000);
    const d = await createUpload(j, 'a.jpg', bytes);
    const part1 = bytes.subarray(0, UPLOAD_PART_SIZE);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), part1, { jar: j, length: null })).status).toBe(
      411,
    );
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), part1, { jar: j, length: '1000' })).status).toBe(
      400,
    );
    // The last part is the remainder, not a full part.
    const last = await put(LIBRARY_API.uploadPart(d.uploadId, 2), part1, { jar: j });
    expect(last.status).toBe(413);
    // A declared length that the body doesn't deliver.
    const short = await put(
      LIBRARY_API.uploadPart(d.uploadId, 2),
      bytes.subarray(UPLOAD_PART_SIZE, UPLOAD_PART_SIZE + 10),
      {
        jar: j,
        length: '1000',
      },
    );
    expect(short.status).toBe(400);
    expect(Object.keys(must(db.uploads.get(d.uploadId)).parts)).toEqual([]);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 3), part1, { jar: j })).status).toBe(400);
  });

  it('cuts off a part whose body is longer than declared (413)', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(2000);
    const d = await createUpload(j, 'a.jpg', bytes);
    const res = await put(LIBRARY_API.uploadPart(d.uploadId, 1), jpegFile(5000), { jar: j, length: '2000' });
    expect(res.status).toBe(413);
    expect(await read(res)).toEqual({ ok: false, error: 'too_large' });
    expect(Object.keys(must(db.uploads.get(d.uploadId)).parts)).toEqual([]);
  });

  it('rejects and aborts a file whose bytes are not its type (HTML named .jpg)', async () => {
    const j = await signedIn(MEI);
    const html = new TextEncoder().encode('<!doctype html><script>alert(document.cookie)</script>');
    const d = await createUpload(j, 'cute-cat.jpg', html);
    const res = await put(LIBRARY_API.uploadPart(d.uploadId, 1), html, { jar: j });
    expect(res.status).toBe(415);
    expect(db.uploads.has(d.uploadId)).toBe(false);
    expect(db.photos.has(d.photoId)).toBe(false);
    expect(must(db.profiles.get(MEI.id)).reserved).toBe(0);
    expect(r2.objects.size).toBe(0);
    expect(r2.multiparts.size).toBe(0);
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j })).status).toBe(404);
  });

  it('checks a CR2 signature (TIFF header plus CR)', async () => {
    db.profiles.set(MEI.id, { plan: 'pro', storage: 0, reserved: 0, deletionDue: null });
    const j = await signedIn(MEI);
    const raw = new Uint8Array(64);
    raw.set([0x49, 0x49, 0x2a, 0x00, 0x10, 0, 0, 0, 0x43, 0x52], 0);
    const ok = await createUpload(j, 'IMG_1.CR2', raw);
    expect((await put(LIBRARY_API.uploadPart(ok.uploadId, 1), raw, { jar: j })).status).toBe(200);
    const tiffOnly = new Uint8Array(64);
    tiffOnly.set([0x49, 0x49, 0x2a, 0x00], 0);
    const bad = await createUpload(j, 'IMG_2.CR2', tiffOnly);
    expect((await put(LIBRARY_API.uploadPart(bad.uploadId, 1), tiffOnly, { jar: j })).status).toBe(415);
  });

  it('checks variants: size cap, image header and dimensions', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(1000));
    const thumb = LIBRARY_API.uploadVariant(d.uploadId, 'thumb');
    expect((await put(thumb, jpegVariant(512, 512, 300 * 1024 + 1), { jar: j })).status).toBe(413);
    expect((await put(thumb, jpegVariant(513, 300), { jar: j })).status).toBe(400);
    expect((await put(thumb, webpVariant(300, 600), { jar: j })).status).toBe(400);
    expect((await put(thumb, new TextEncoder().encode('<svg onload=alert(1)>'), { jar: j })).status).toBe(
      415,
    );
    expect((await put(thumb, jpegVariant(512, 384), { jar: j, length: '10' })).status).toBe(400);
    expect(
      (await put(LIBRARY_API.uploadVariant(d.uploadId, 'preview'), webpVariant(2049, 100), { jar: j }))
        .status,
    ).toBe(400);
    expect(r2.objects.size).toBe(0);
    const ok = await put(thumb, webpVariant(512, 288), { jar: j, type: 'image/webp' });
    expect(ok.status).toBe(200);
    expect(must(r2.objects.get(`staging/${MEI.id}/${d.photoId}/thumb`)).contentType).toBe('image/webp');
    expect(r2.objects.has(`${prefix(MEI.id, d.photoId)}thumb`)).toBe(false);
    expect(must(db.uploads.get(d.uploadId)).variants.thumb).toBe(4000);
  });

  it('discards an upload whose stored size differs from the declared size', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(3000);
    const d = await createUpload(j, 'a.jpg', bytes);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), bytes, { jar: j })).status).toBe(200);
    // Something went wrong between the part and the completion: R2 holds fewer bytes than declared.
    const mp = must([...r2.multiparts.values()][0]);
    const p1 = must(mp.parts.get(1));
    p1.bytes = p1.bytes.subarray(0, 2000);
    const res = await call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    expect(res.status).toBe(400);
    expect(r2.objects.has(`${prefix(MEI.id, d.photoId)}original`)).toBe(false);
    expect(db.photos.has(d.photoId)).toBe(false);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('refuses to complete before every part is in (409)', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 5);
    const d = await createUpload(j, 'a.jpg', bytes);
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), bytes.subarray(0, UPLOAD_PART_SIZE), { jar: j });
    const res = await call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    expect(res.status).toBe(409);
  });

  it('rejects invalid metadata', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(100));
    const res = await call(LIBRARY_API.uploadComplete(d.uploadId), {
      jar: j,
      body: { metadata: { iso: -5, takenAt: 'yesterday' } },
    });
    expect(res.status).toBe(400);
  });

  it('aborts an upload: R2 multipart, variants and reservation', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 5);
    const d = await createUpload(j, 'a.jpg', bytes);
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), bytes.subarray(0, UPLOAD_PART_SIZE), { jar: j });
    await put(LIBRARY_API.uploadVariant(d.uploadId, 'thumb'), jpegVariant(10, 10), { jar: j });
    const res = await call(LIBRARY_API.upload(d.uploadId), { jar: j, method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(r2.multiparts.size).toBe(0);
    expect(r2.aborted).toHaveLength(1);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(must(db.profiles.get(MEI.id)).reserved).toBe(0);
  });

  it('applies the plan: file types and maximum size', async () => {
    const j = await signedIn(MEI);
    const res = await call(LIBRARY_API.uploads, {
      jar: j,
      body: {
        files: [
          { name: 'IMG_1.CR2', size: 1000, sha256: 'a'.repeat(64) },
          { name: 'notes.html', size: 1000, sha256: 'b'.repeat(64) },
          { name: 'noext', size: 1000, sha256: 'c'.repeat(64) },
          { name: 'huge.png', size: 51 * 1024 * 1024, sha256: 'd'.repeat(64) },
          { name: 'C:\\Users\\mei\\fine.webp', size: 1000, sha256: 'e'.repeat(64) },
        ],
      },
    });
    const { results } = await read(res);
    expect(results.slice(0, 4)).toEqual([
      { status: 'rejected', reason: 'type' },
      { status: 'rejected', reason: 'type' },
      { status: 'rejected', reason: 'type' },
      { status: 'rejected', reason: 'too_large' },
    ]);
    expect(results[4].status).toBe('ready');
    expect(must(db.photos.get(results[4].photoId)).filename).toBe('fine.webp');
  });

  it('skips duplicates of photos already in the library, and of files earlier in the batch', async () => {
    const j = await signedIn(MEI);
    const existing = seedPhoto(MEI.id, { sha: 'f'.repeat(64), size: 5000 });
    const res = await call(LIBRARY_API.uploads, {
      jar: j,
      body: {
        files: [
          { name: 'again.jpg', size: 5000, sha256: 'f'.repeat(64) },
          { name: 'new.jpg', size: 10, sha256: '1'.repeat(64) },
          { name: 'new copy.jpg', size: 10, sha256: '1'.repeat(64) },
        ],
      },
    });
    const { results } = await read(res);
    expect(results[0]).toEqual({ status: 'duplicate', photoId: existing.id });
    expect(results[2]).toEqual({ status: 'duplicate', photoId: results[1].photoId });
  });

  it('a copy finishing second is folded into the first (duplicate on completion)', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(500);
    const a = await createUpload(j, 'a.jpg', bytes);
    const b = await createUpload(j, 'a again.jpg', bytes);
    expect(b.status).toBe('ready'); // the first isn't finished yet
    expect((await uploadWhole(j, a.uploadId, bytes, 1)).status).toBe(200);
    const res = await uploadWhole(j, b.uploadId, bytes, 1);
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ ok: true, duplicate: true, photo: { id: a.photoId } });
    expect(objectsUnder(MEI.id).filter((k) => k.includes(b.photoId))).toEqual([]);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('answers 410 upload_expired for an expired upload', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(100));
    must(db.uploads.get(d.uploadId)).expiresAt = Date.now() - 1000;
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j })).status).toBe(410);
    const res = await put(LIBRARY_API.uploadPart(d.uploadId, 1), jpegFile(100), { jar: j });
    expect(res.status).toBe(410);
    expect(await read(res)).toEqual({ ok: false, error: 'upload_expired' });
  });

  it('guards binary PUTs: Origin, content type, sign-in and the per-member limit', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(100));
    const path = LIBRARY_API.uploadPart(d.uploadId, 1);
    expect((await put(path, jpegFile(100), { jar: j, origin: null })).status).toBe(403);
    expect((await put(path, jpegFile(100), { jar: j, origin: 'https://evil.example' })).status).toBe(403);
    expect((await put(path, jpegFile(100), { jar: j, type: 'text/html' })).status).toBe(415);
    expect((await put(path, jpegFile(100), { jar: jar() })).status).toBe(401);
    uploadLimiter.ok = false;
    expect((await put(path, jpegFile(100), { jar: j })).status).toBe(429);
    expect(uploadLimiter.keys.at(-1)).toBe(`put:${MEI.id}`);
  });

  it('rate-limits upload creation per member and caps the JSON body', async () => {
    const j = await signedIn(MEI);
    world.rpc.rate_limit_hit = (a) => a.p_kind !== 'upload_create';
    const res = await call(LIBRARY_API.uploads, {
      jar: j,
      body: { files: [{ name: 'a.jpg', size: 1, sha256: 'a'.repeat(64) }] },
    });
    expect(res.status).toBe(429);
    const big = await call(LIBRARY_API.uploads, { jar: j, body: { files: [], pad: 'x'.repeat(300 * 1024) } });
    expect(big.status).toBe(413);
  });
});

// ---- cross-owner isolation ------------------------------------------------------------------------------
describe('one member cannot reach another member’s library', () => {
  it('every upload, photo, media and album route answers 404 to another member', async () => {
    const mei = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 3);
    const up = await createUpload(mei, 'mine.jpg', bytes);
    const { photo } = await storedPhoto(MEI.id);
    const album = await read(
      await call(LIBRARY_API.albums, { jar: mei, body: { name: 'Mine', photoIds: [photo.id] } }),
    );
    const objectsBefore = [...r2.objects.keys()].sort();

    const wei = await signedIn(WEI);
    db.owners.length = 0;
    const attempts: [string, Promise<Response>][] = [
      ['upload status', call(LIBRARY_API.upload(up.uploadId), { jar: wei })],
      ['upload abort', call(LIBRARY_API.upload(up.uploadId), { jar: wei, method: 'DELETE' })],
      [
        'upload part',
        put(LIBRARY_API.uploadPart(up.uploadId, 1), bytes.subarray(0, UPLOAD_PART_SIZE), { jar: wei }),
      ],
      [
        'upload variant',
        put(LIBRARY_API.uploadVariant(up.uploadId, 'thumb'), jpegVariant(10, 10), { jar: wei }),
      ],
      [
        'upload complete',
        call(LIBRARY_API.uploadComplete(up.uploadId), { jar: wei, body: { metadata: {} } }),
      ],
      ['photo', call(LIBRARY_API.photo(photo.id), { jar: wei })],
      [
        'photo patch',
        call(LIBRARY_API.photo(photo.id), { jar: wei, method: 'PATCH', body: { favourite: true } }),
      ],
      ['thumb', call(LIBRARY_API.photoFile(photo.id, 'thumb'), { jar: wei })],
      ['preview', call(LIBRARY_API.photoFile(photo.id, 'preview'), { jar: wei })],
      ['original', call(LIBRARY_API.photoFile(photo.id, 'original'), { jar: wei })],
      ['album', call(LIBRARY_API.album(album.album.id), { jar: wei })],
      [
        'album patch',
        call(LIBRARY_API.album(album.album.id), { jar: wei, method: 'PATCH', body: { name: 'Taken' } }),
      ],
      ['album delete', call(LIBRARY_API.album(album.album.id), { jar: wei, method: 'DELETE' })],
      ['list by album', call(`${LIBRARY_API.photos}?albumId=${album.album.id}`, { jar: wei })],
      [
        'bulk album',
        call(LIBRARY_API.photosBulk, {
          jar: wei,
          body: { ids: [photo.id], action: 'add_to_album', albumId: album.album.id },
        }),
      ],
    ];
    for (const [what, p] of attempts) {
      const res = await p;
      expect(res.status, what).toBe(404);
    }
    for (const action of ['trash', 'favourite', 'delete_forever']) {
      const res = await call(LIBRARY_API.photosBulk, { jar: wei, body: { ids: [photo.id], action } });
      expect(await read(res)).toEqual({ ok: true, affected: 0 });
    }
    const list = await read(await call(LIBRARY_API.photos, { jar: wei }));
    expect(list.items).toEqual([]);

    // Nothing of Mei's changed, and every query was made as Wei.
    expect([...r2.objects.keys()].sort()).toEqual(objectsBefore);
    expect(r2.deleted).toEqual([]);
    expect(must(db.photos.get(photo.id))).toMatchObject({ status: 'ready', favourite: false });
    expect(must(db.albums.get(album.album.id)).name).toBe('Mine');
    expect(db.uploads.has(up.uploadId)).toBe(true);
    expect(new Set(db.owners)).toEqual(new Set([WEI.id]));
  });
});

// ---- photos and media ----------------------------------------------------------------------------------
describe('photos and media', () => {
  it('serves variants with fixed type, sandbox CSP, revalidated private caching and ETag/304', async () => {
    const j = await signedIn(MEI);
    const { photo } = await storedPhoto(MEI.id);
    const res = await call(LIBRARY_API.photoFile(photo.id, 'thumb'), { jar: j });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    const etag = must(res.headers.get('ETag'));
    const again = await call(LIBRARY_API.photoFile(photo.id, 'thumb'), {
      jar: j,
      headers: { 'If-None-Match': etag },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    const preview = await call(LIBRARY_API.photoFile(photo.id, 'preview'), { jar: j });
    expect(preview.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('downloads originals: attachment, RFC 5987 name, no-store, ranges', async () => {
    const j = await signedIn(MEI);
    const { photo, original } = await storedPhoto(MEI.id, { filename: 'Été à Paris', size: 100 });
    const res = await call(LIBRARY_API.photoFile(photo.id, 'original'), { jar: j });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="_t_ _ Paris.jpg"; filename*=UTF-8''%C3%89t%C3%A9%20%C3%A0%20Paris.jpg`,
    );
    const part = await call(LIBRARY_API.photoFile(photo.id, 'original'), {
      jar: j,
      headers: { Range: 'bytes=10-19' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(original.subarray(10, 20));
    const tail = await call(LIBRARY_API.photoFile(photo.id, 'original'), {
      jar: j,
      headers: { Range: 'bytes=-5' },
    });
    expect(tail.headers.get('Content-Range')).toBe('bytes 95-99/100');
    const bad = await call(LIBRARY_API.photoFile(photo.id, 'original'), {
      jar: j,
      headers: { Range: 'bytes=500-' },
    });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('Content-Range')).toBe('bytes */100');
  });

  it('keeps the file type’s extension on downloads of renamed photos', async () => {
    const j = await signedIn(MEI);
    const { photo } = await storedPhoto(MEI.id, { filename: 'invoice.html' });
    const res = await call(LIBRARY_API.photoFile(photo.id, 'original'), { jar: j });
    expect(res.headers.get('Content-Disposition')).toContain(`filename*=UTF-8''invoice.html.jpg`);
  });

  it('404s variants that were never uploaded and unknown kinds', async () => {
    const j = await signedIn(MEI);
    const p = seedPhoto(MEI.id, { thumb: 0 });
    expect((await call(LIBRARY_API.photoFile(p.id, 'thumb'), { jar: j })).status).toBe(404);
    expect((await call(`/api/v1/photos/${p.id}/raw`, { jar: j })).status).toBe(404);
    expect((await call('/api/v1/photos/not-a-uuid', { jar: j })).status).toBe(404);
  });

  it('lists, shows, patches and favourites photos', async () => {
    const j = await signedIn(MEI);
    const p = seedPhoto(MEI.id, { filename: 'Lake.jpg' });
    seedPhoto(MEI.id, { filename: 'Other.jpg' });
    const list = await read(await call(`${LIBRARY_API.photos}?q=lake&limit=10`, { jar: j }));
    expect(list).toMatchObject({ ok: true, nextCursor: null });
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect((await call(`${LIBRARY_API.photos}?limit=500`, { jar: j })).status).toBe(400);
    expect((await call(`${LIBRARY_API.photos}?view=everything`, { jar: j })).status).toBe(400);
    const detail = await read(await call(LIBRARY_API.photo(p.id), { jar: j }));
    expect(detail.photo).toMatchObject({ id: p.id, albums: [], metadata: {} });
    const patched = await read(
      await call(LIBRARY_API.photo(p.id), {
        jar: j,
        method: 'PATCH',
        body: { favourite: true, filename: '../../Sunrise.jpg' },
      }),
    );
    expect(patched.photo).toMatchObject({ favourite: true, filename: 'Sunrise.jpg' });
    expect((await call(LIBRARY_API.photo(p.id), { jar: j, method: 'PATCH', body: {} })).status).toBe(400);
  });
});

// ---- albums -----------------------------------------------------------------------------------------
describe('albums', () => {
  it('creates, renames, sets a cover and deletes (photos stay)', async () => {
    const j = await signedIn(MEI);
    const p = seedPhoto(MEI.id);
    const created = await call(LIBRARY_API.albums, { jar: j, body: { name: 'Hokkaido', photoIds: [p.id] } });
    expect(created.status).toBe(201);
    const { album } = await read(created);
    expect(album).toMatchObject({ name: 'Hokkaido', photoCount: 1, coverPhotoIds: [p.id] });
    const other = seedPhoto(MEI.id);
    const badCover = await call(LIBRARY_API.album(album.id), {
      jar: j,
      method: 'PATCH',
      body: { coverPhotoId: other.id },
    });
    expect(badCover.status).toBe(400);
    const renamed = await read(
      await call(LIBRARY_API.album(album.id), { jar: j, method: 'PATCH', body: { name: 'Sapporo' } }),
    );
    expect(renamed.album.name).toBe('Sapporo');
    expect((await read(await call(LIBRARY_API.albums, { jar: j }))).albums).toHaveLength(1);
    expect((await call(LIBRARY_API.album(album.id), { jar: j, method: 'DELETE' })).status).toBe(204);
    expect(db.photos.has(p.id)).toBe(true);
    expect((await call(LIBRARY_API.albums, { jar: j, body: { name: '   ' } })).status).toBe(400);
  });
});

// ---- trash and clean-up jobs -------------------------------------------------------------------------
describe('trash and clean-up', () => {
  it('trash → the purge job deletes the R2 objects, then the row, and usage drops', async () => {
    const j = await signedIn(MEI);
    const { photo } = await storedPhoto(MEI.id);
    const keep = await storedPhoto(MEI.id);
    const bulk = await call(LIBRARY_API.photosBulk, { jar: j, body: { ids: [photo.id], action: 'trash' } });
    expect(await read(bulk)).toEqual({ ok: true, affected: 1 });
    const trash = await read(await call(`${LIBRARY_API.photos}?view=trash`, { jar: j }));
    expect(trash.items[0]).toMatchObject({ id: photo.id, purgeAt: expect.any(String) });
    // Not due yet: nothing happens.
    await runCleanup(env);
    expect(objectsUnder(MEI.id)).toHaveLength(6);

    must(db.photos.get(photo.id)).purgeAfter = new Date(Date.now() - 1000).toISOString();
    const counts = await runCleanup(env);
    expect(counts).toMatchObject({ photosPurged: 1, objectsDeleted: 5 });
    expect(objectsUnder(MEI.id).sort()).toEqual(
      ['original', 'preview', 'thumb'].map((k) => `${prefix(MEI.id, keep.photo.id)}${k}`),
    );
    expect(db.photos.has(photo.id)).toBe(false);
    expect(must(db.profiles.get(MEI.id)).storage).toBe(
      keep.photo.size + keep.photo.thumb + keep.photo.preview,
    );
    expect(noDrift(MEI.id)).toBe(true);
    const audit = world.calls.filter((c) => c.url.endsWith('/rpc/record_cleanup'));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.body).toEqual({
      p_details: {
        uploadsAborted: 0,
        photosPurged: 1,
        accountsPurged: 0,
        objectsDeleted: 5,
        orphansDeleted: 0,
        variantsPublished: 0,
        variantsLost: 0,
        rateLimitRows: 0,
        galleryRenditionsPurged: 0,
        galleriesDeleted: 0,
        shareObjectsDeleted: 0,
        expiryReminders: 0,
        safetyAlerts: 0,
      },
    });
  });

  it('delete forever and empty Trash remove objects at once; an R2 failure leaves it to the job', async () => {
    const j = await signedIn(MEI);
    const a = await storedPhoto(MEI.id);
    const b = await storedPhoto(MEI.id);
    const c = await storedPhoto(MEI.id);
    await call(LIBRARY_API.photosBulk, {
      jar: j,
      body: { ids: [a.photo.id, b.photo.id, c.photo.id], action: 'trash' },
    });
    const res = await call(LIBRARY_API.photosBulk, {
      jar: j,
      body: { ids: [a.photo.id], action: 'delete_forever' },
    });
    expect(await read(res)).toEqual({ ok: true, affected: 1 });
    expect(db.photos.has(a.photo.id)).toBe(false);
    expect(objectsUnder(MEI.id).some((k) => k.includes(a.photo.id))).toBe(false);

    r2.failDeletes = true;
    const empty = await call(LIBRARY_API.trashEmpty, { jar: j, body: {} });
    expect(await read(empty)).toEqual({ ok: true, deleted: 2 });
    expect(must(db.photos.get(b.photo.id)).status).toBe('purging');
    expect(noDrift(MEI.id)).toBe(true);
    r2.failDeletes = false;
    await runCleanup(env);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(db.photos.size).toBe(0);
    expect(must(db.profiles.get(MEI.id)).storage).toBe(0);
  });

  it('the job aborts expired uploads, deletes their objects and releases the reservation', async () => {
    const j = await signedIn(MEI);
    const bytes = jpegFile(UPLOAD_PART_SIZE + 9);
    const d = await createUpload(j, 'a.jpg', bytes);
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), bytes.subarray(0, UPLOAD_PART_SIZE), { jar: j });
    await put(LIBRARY_API.uploadVariant(d.uploadId, 'preview'), webpVariant(100, 100), { jar: j });
    must(db.uploads.get(d.uploadId)).expiresAt = Date.now() - 1;
    const counts = await runCleanup(env);
    expect(counts.uploadsAborted).toBe(1);
    expect(r2.multiparts.size).toBe(0);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(must(db.profiles.get(MEI.id)).reserved).toBe(0);
    expect(db.photos.has(d.photoId)).toBe(false);
  });

  it('the Worker’s scheduled handler runs the clean-up', async () => {
    const { photo } = await storedPhoto(MEI.id, { status: 'purging', trashedAt: new Date().toISOString() });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => undefined,
    };
    worker.scheduled(
      {
        cron: '*/15 * * * *',
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as unknown as ScheduledController,
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect(db.photos.has(photo.id)).toBe(false);
  });
});

// ---- usage and account deletion ------------------------------------------------------------------------
describe('usage and account deletion', () => {
  it('reports usage with the plan’s upload rules', async () => {
    const j = await signedIn(MEI);
    seedPhoto(MEI.id, { size: 1000, thumb: 0, preview: 0 });
    const res = await read(await call(LIBRARY_API.usage, { jar: j }));
    expect(res).toEqual({
      ok: true,
      usedBytes: 1000,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      trashBytes: 0,
      photoCount: 1,
      plan: 'free',
      fileTypes: ['jpeg', 'png', 'webp'],
      maxFileBytes: 50 * 1024 ** 2,
      batchSize: 25,
    });
  });

  it('needs a recent sign-in and the typed confirmation', async () => {
    const stale = await signedIn(MEI, 11 * 60);
    expect((await call(LIBRARY_API.deleteAccount, { jar: stale, body: { confirm: 'DELETE' } })).status).toBe(
      403,
    );
    const j = await signedIn(MEI);
    expect((await call(LIBRARY_API.deleteAccount, { jar: j, body: { confirm: 'delete' } })).status).toBe(400);
    expect(must(db.profiles.get(MEI.id)).deletionDue).toBeNull();
  });

  it('schedules deletion, signs out everywhere, emails, gates the app, and restores', async () => {
    const j = await signedIn(MEI);
    const token = must(j.cookies.get('__Host-zs-at'));
    const res = await call(LIBRARY_API.deleteAccount, { jar: j, body: { confirm: 'DELETE' } });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Date.parse(body.purgeAt)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect(world.globalLogouts).toEqual([token]);
    expect(j.cookies.size).toBe(0);
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0]?.to).toBe('mei@example.com');
    expect(world.emails[0]?.subject).toBe('Your Zephyr account is scheduled for deletion');

    // Signing in again: only the session and restore routes work.
    const again = await signedIn(MEI);
    for (const [path, method] of [
      [LIBRARY_API.photos, 'GET'],
      [LIBRARY_API.usage, 'GET'],
      [LIBRARY_API.albums, 'GET'],
      ['/api/v1/me/passkeys', 'GET'],
    ] as const) {
      const r = await call(path, { jar: again, method });
      expect(r.status, path).toBe(403);
      expect(await read(r)).toEqual({ ok: false, error: 'account_pending_deletion' });
    }
    const up = await call(LIBRARY_API.uploads, {
      jar: again,
      body: { files: [{ name: 'a.jpg', size: 1, sha256: 'a'.repeat(64) }] },
    });
    expect(up.status).toBe(403);
    const session = await read(await call('/api/v1/auth/session', { jar: again }));
    expect(session.user.pendingDeletion).toEqual({ purgeAt: body.purgeAt });

    const restored = await call(LIBRARY_API.restoreAccount, { jar: again, body: {} });
    expect(restored.status).toBe(200);
    expect((await read(restored)).user.pendingDeletion).toBeUndefined();
    expect((await call(LIBRARY_API.photos, { jar: again })).status).toBe(200);
    expect((await call(LIBRARY_API.restoreAccount, { jar: again, body: {} })).status).toBe(409);
  });

  it('the purge job deletes every object under the account’s prefix, then the Auth user', async () => {
    const mine = await storedPhoto(MEI.id);
    const theirs = await storedPhoto(WEI.id);
    // More objects than one delete call takes, plus a stray key and an open multipart upload.
    for (let i = 0; i < 1500; i++) await r2.put(`u/${MEI.id}/p/stray-${i}/original`, 'x');
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'big.jpg', jpegFile(UPLOAD_PART_SIZE + 1));
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), jpegFile(UPLOAD_PART_SIZE), { jar: j });
    expect(r2.multiparts.size).toBe(1);

    must(db.profiles.get(MEI.id)).deletionDue = new Date(Date.now() - 1000).toISOString();
    const counts = await runCleanup(env);
    expect(counts.accountsPurged).toBe(1);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(Math.max(...r2.deleteBatches)).toBeLessThanOrEqual(1000);
    expect(r2.multiparts.size).toBe(0);
    expect(
      world.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/auth/v1/admin/users/${MEI.id}`)),
    ).toBe(true);
    expect(world.users.some((u) => u.id === MEI.id)).toBe(false);
    expect(db.photos.has(mine.photo.id)).toBe(false);
    // Another member is untouched.
    expect(objectsUnder(WEI.id)).toHaveLength(3);
    expect(db.photos.has(theirs.photo.id)).toBe(true);
    // A second run finds nothing to do.
    expect((await runCleanup(env)).accountsPurged).toBe(0);
  });

  it('a very large account is purged over several runs before the user is deleted', async () => {
    for (let i = 0; i < 10_500; i++)
      r2.objects.set(`u/${MEI.id}/p/x-${i}/original`, { bytes: new Uint8Array(1), etag: 'e' });
    profile(MEI.id).deletionDue = new Date(Date.now() - 1000).toISOString();
    const first = await runCleanup(env);
    expect(first.accountsPurged).toBe(0);
    expect(world.users.some((u) => u.id === MEI.id)).toBe(true);
    const second = await runCleanup(env);
    expect(second.accountsPurged).toBe(1);
    expect(objectsUnder(MEI.id)).toEqual([]);
  });
});

// ---- contract and database agree ---------------------------------------------------------------------
describe('library constants match the migration', () => {
  const sql = migration;
  it('part size, variant caps and file types', () => {
    expect(sql).toContain(`c_part constant integer := ${UPLOAD_PART_SIZE};`);
    expect(sql).toContain(`thumb_bytes between 0 and ${VARIANT_LIMITS.thumb.maxBytes}`);
    expect(sql).toContain(`preview_bytes between 0 and ${VARIANT_LIMITS.preview.maxBytes}`);
    const types = Object.keys(FILE_TYPES)
      .map((t) => `'${t}'`)
      .join(', ');
    expect(sql).toContain(`file_type in (${types})`);
  });
});

// ---- security review fixes ----------------------------------------------------------------------------
/** A PUT whose body sends 10 bytes, then waits for release() before the rest. */
function slowPut(path: string, bytes: Uint8Array, j: Jar) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      ctrl.enqueue(bytes.subarray(0, 10));
      await gate;
      ctrl.enqueue(bytes.subarray(10));
      ctrl.close();
    },
  });
  const res = app.request(
    `${APP}${path}`,
    {
      method: 'PUT',
      duplex: 'half',
      headers: {
        'CF-Connecting-IP': '203.0.113.7',
        'Content-Type': 'image/jpeg',
        Origin: APP,
        Cookie: [...j.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'Content-Length': String(bytes.byteLength),
      },
      body,
    } as RequestInit,
    env,
  );
  return { res, release };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('variants can’t outlive or overwrite their upload (HIGH-1)', () => {
  it('a variant PUT racing DELETE leaves no object behind', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(100));
    const slow = slowPut(
      LIBRARY_API.uploadVariant(d.uploadId, 'preview'),
      jpegVariant(2048, 1536, 1_500_000),
      j,
    );
    await tick();
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j, method: 'DELETE' })).status).toBe(204);
    slow.release();
    expect((await slow.res).status).toBe(410);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('a variant PUT racing complete can’t replace the finished photo’s variant', async () => {
    const j = await signedIn(MEI);
    const file = jpegFile(100);
    const d = await createUpload(j, 'b.jpg', file);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), file, { jar: j })).status).toBe(200);
    const small = jpegVariant(10, 10, 100);
    expect((await put(LIBRARY_API.uploadVariant(d.uploadId, 'preview'), small, { jar: j })).status).toBe(200);
    const slow = slowPut(
      LIBRARY_API.uploadVariant(d.uploadId, 'preview'),
      jpegVariant(2048, 1536, 1_500_000),
      j,
    );
    await tick();
    expect(
      (await call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } })).status,
    ).toBe(200);
    slow.release();
    expect((await slow.res).status).toBe(410);
    expect(must(db.photos.get(d.photoId)).preview).toBe(100);
    const served = await call(LIBRARY_API.photoFile(d.photoId, 'preview'), { jar: j });
    expect((await served.arrayBuffer()).byteLength).toBe(100);
    expect(objectsUnder(MEI.id).sort()).toEqual(
      [`${prefix(MEI.id, d.photoId)}original`, `${prefix(MEI.id, d.photoId)}preview`].sort(),
    );
  });

  it('counts the variant sizes measured in R2, not the recorded ones', async () => {
    const j = await signedIn(MEI);
    const file = jpegFile(100);
    const d = await createUpload(j, 'c.jpg', file);
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), file, { jar: j });
    await put(LIBRARY_API.uploadVariant(d.uploadId, 'thumb'), jpegVariant(100, 100, 5000), { jar: j });
    must(db.uploads.get(d.uploadId)).variants = { thumb: 1, preview: 1 };
    const res = await call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    expect((await read(res)).photo).toMatchObject({ hasThumb: true, hasPreview: false });
    expect(must(db.photos.get(d.photoId))).toMatchObject({ thumb: 5000, preview: 0 });
    expect(must(r2.objects.get(`${prefix(MEI.id, d.photoId)}thumb`)).bytes.byteLength).toBe(5000);
    expect(r2.objects.has(`staging/${MEI.id}/${d.photoId}/thumb`)).toBe(false);
  });

  it('a variant PUT after completion is refused and touches nothing', async () => {
    const j = await signedIn(MEI);
    const file = jpegFile(100);
    const d = await createUpload(j, 'd.jpg', file);
    expect((await uploadWhole(j, d.uploadId, file, 1)).status).toBe(200);
    const before = must(r2.objects.get(`${prefix(MEI.id, d.photoId)}thumb`)).etag;
    const res = await put(LIBRARY_API.uploadVariant(d.uploadId, 'thumb'), jpegVariant(512, 512, 300_000), {
      jar: j,
    });
    expect(res.status).toBe(404);
    expect(must(r2.objects.get(`${prefix(MEI.id, d.photoId)}thumb`)).etag).toBe(before);
  });

  it('the orphan sweep deletes unaccounted objects a page at a time, sparing in-flight uploads', async () => {
    const j = await signedIn(MEI);
    const kept = await storedPhoto(MEI.id);
    // A stale staged copy of a finished photo: not swept (the staging/ lifecycle rule handles it).
    await r2.put(`staging/${MEI.id}/${kept.photo.id}/thumb`, 'x');
    // Old-style or unknown shapes under u/ are left alone too.
    await r2.put(`${prefix(MEI.id, kept.photo.id)}staging-thumb`, 'x');
    const inflight = await createUpload(j, 'e.jpg', jpegFile(100));
    await put(LIBRARY_API.uploadVariant(inflight.uploadId, 'thumb'), jpegVariant(10, 10), { jar: j });
    const ghost = crypto.randomUUID();
    for (let i = 0; i < 1200; i++) await r2.put(`${prefix(MEI.id, crypto.randomUUID())}original`, 'x');
    await r2.put(`${prefix(MEI.id, ghost)}preview`, 'x');
    await r2.put(`${prefix(WEI.id, kept.photo.id)}original`, 'x'); // a real photo id under the wrong owner
    await r2.put('u/not-a-library-key', 'x');

    const first = await runCleanup(env);
    expect(first.orphansDeleted).toBeGreaterThan(0);
    expect(db.jobState.get('orphan_sweep_cursor')).toBeTruthy();
    const second = await runCleanup(env);
    expect(first.orphansDeleted + second.orphansDeleted).toBe(1202);
    expect(db.jobState.get('orphan_sweep_cursor')).toBeNull();
    expect([...r2.objects.keys()].sort()).toEqual(
      [
        ...['original', 'thumb', 'preview', 'staging-thumb'].map(
          (k) => `${prefix(MEI.id, kept.photo.id)}${k}`,
        ),
        `staging/${MEI.id}/${kept.photo.id}/thumb`,
        `staging/${MEI.id}/${inflight.photoId}/thumb`,
        'u/not-a-library-key',
      ].sort(),
    );
    expect(world.calls.filter((c) => c.url.endsWith('/rpc/record_cleanup')).at(-1)?.body).toMatchObject({
      p_details: { orphansDeleted: second.orphansDeleted },
    });
  });
});

describe('cached images and sign-out (MEDIUM-2)', () => {
  it('sign-out and account deletion clear the browser cache', async () => {
    const j = await signedIn(MEI);
    const out = await call('/api/v1/auth/sign-out', { jar: j, body: {} });
    expect(out.status).toBe(204);
    expect(out.headers.get('Clear-Site-Data')).toBe('"cache"');
    const k = await signedIn(MEI);
    const del = await call(LIBRARY_API.deleteAccount, { jar: k, body: { confirm: 'DELETE' } });
    expect(del.status).toBe(200);
    expect(del.headers.get('Clear-Site-Data')).toBe('"cache"');
  });

  it('a revalidation after sign-out is refused, never answered from the session-less cache', async () => {
    const j = await signedIn(MEI);
    const { photo } = await storedPhoto(MEI.id);
    const res = await call(LIBRARY_API.photoFile(photo.id, 'preview'), { jar: j });
    const etag = must(res.headers.get('ETag'));
    const anon = await call(LIBRARY_API.photoFile(photo.id, 'preview'), {
      headers: { 'If-None-Match': etag },
    });
    expect(anon.status).toBe(401);
  });
});

describe('abort can’t strand a completed photo (LOW-1)', () => {
  it('DELETE racing complete: whoever claims first wins; no ready photo without files', async () => {
    const j = await signedIn(MEI);
    const file = jpegFile(100);
    const d = await createUpload(j, 'f.jpg', file);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), file, { jar: j })).status).toBe(200);
    const realHead = r2.head.bind(r2);
    let releaseHead!: () => void;
    const headGate = new Promise<void>((r) => {
      releaseHead = r;
    });
    let inHead!: () => void;
    const headReached = new Promise<void>((r) => {
      inHead = r;
    });
    vi.spyOn(r2, 'head').mockImplementation(async (k: string) => {
      const h = await realHead(k);
      inHead();
      await headGate;
      return h;
    });
    const completing = call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    await headReached;
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j, method: 'DELETE' })).status).toBe(204);
    releaseHead();
    expect((await completing).status).toBe(404);
    expect(db.photos.has(d.photoId)).toBe(false);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('a second DELETE (lost claim) deletes nothing', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'g.jpg', jpegFile(100));
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j, method: 'DELETE' })).status).toBe(204);
    const deletes = r2.deleteBatches.length;
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: j, method: 'DELETE' })).status).toBe(404);
    expect(r2.deleteBatches.length).toBe(deletes);
  });
});

describe('account purge backoff (LOW-3)', () => {
  it('reports progress on a partial purge so it isn’t backed off', async () => {
    for (let i = 0; i < 10_500; i++) {
      r2.objects.set(`u/${MEI.id}/p/x-${i}/original`, { bytes: new Uint8Array(1), etag: 'e' });
    }
    profile(MEI.id).deletionDue = new Date(Date.now() - 1000).toISOString();
    await runCleanup(env);
    const progress = world.calls.filter((c) => c.url.endsWith('/rpc/account_purge_progress'));
    expect(progress.map((c) => c.body)).toEqual([{ p_owner: MEI.id }]);
  });
});

describe('uploads pinned to the expected user (shared devices)', () => {
  it('409 session_changed when X-Zephyr-Expected-User names someone else; allowed when it matches or is absent', async () => {
    const mei = await signedIn(MEI);
    const bytes = jpegFile(100);
    const d = await createUpload(mei, 'a.jpg', bytes);
    const wei = await signedIn(WEI);
    const as = (user: string) => ({ 'X-Zephyr-Expected-User': user });
    const files = { files: [{ name: 'b.jpg', size: 10, sha256: 'b'.repeat(64) }] };

    // Mei's tab, but Wei is now signed in on this device: every uploads route refuses.
    const refused: [string, Promise<Response>][] = [
      ['create', call(LIBRARY_API.uploads, { jar: wei, body: files, headers: as(MEI.id) })],
      ['status', call(LIBRARY_API.upload(d.uploadId), { jar: wei, headers: as(MEI.id) })],
      ['abort', call(LIBRARY_API.upload(d.uploadId), { jar: wei, method: 'DELETE', headers: as(MEI.id) })],
      [
        'complete',
        call(LIBRARY_API.uploadComplete(d.uploadId), {
          jar: wei,
          body: { metadata: {} },
          headers: as(MEI.id),
        }),
      ],
      ['garbage', call(LIBRARY_API.uploads, { jar: mei, body: files, headers: as('not-a-uuid') })],
    ];
    for (const [what, p] of refused) {
      const res = await p;
      expect(res.status, what).toBe(409);
      expect(await read(res), what).toEqual({ ok: false, error: 'session_changed' });
    }
    const part = await app.request(
      `${APP}${LIBRARY_API.uploadPart(d.uploadId, 1)}`,
      {
        method: 'PUT',
        headers: {
          'CF-Connecting-IP': '203.0.113.7',
          'Content-Type': 'application/octet-stream',
          Origin: APP,
          Cookie: [...wei.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'Content-Length': '100',
          ...as(MEI.id),
        },
        body: bytes,
      },
      env,
    );
    expect(part.status).toBe(409);
    expect(db.uploads.has(d.uploadId)).toBe(true);
    expect(r2.multiparts.size).toBe(0);

    // Matching (any case) or absent: allowed.
    expect(
      (await call(LIBRARY_API.uploads, { jar: wei, body: files, headers: as(WEI.id.toUpperCase()) })).status,
    ).toBe(200);
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: mei, headers: as(MEI.id) })).status).toBe(200);
    expect((await call(LIBRARY_API.upload(d.uploadId), { jar: mei })).status).toBe(200);
  });
});

// ---- re-review Low items ---------------------------------------------------------------------------------
describe('staging prefix and late PUTs (L1)', () => {
  it('a late variant PUT unstages its copy under waitUntil', async () => {
    const j = await signedIn(MEI);
    const d = await createUpload(j, 'a.jpg', jpegFile(100));
    world.rpc.record_variant = () => null; // completed/aborted between the check and the write
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => undefined,
    };
    const res = await app.request(
      `${APP}${LIBRARY_API.uploadVariant(d.uploadId, 'thumb')}`,
      {
        method: 'PUT',
        headers: {
          'CF-Connecting-IP': '203.0.113.7',
          'Content-Type': 'image/jpeg',
          Origin: APP,
          Cookie: [...j.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          'Content-Length': '2000',
        },
        body: jpegVariant(100, 100),
      },
      env,
      ctx as unknown as ExecutionContext,
    );
    expect(res.status).toBe(410);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(r2.objects.has(`staging/${MEI.id}/${d.photoId}/thumb`)).toBe(false);
    expect(r2.deleted).toContain(`staging/${MEI.id}/${d.photoId}/thumb`);
  });

  it('an account purge also empties staging/<owner>/', async () => {
    await r2.put(`staging/${MEI.id}/${crypto.randomUUID()}/thumb`, 'x');
    await r2.put(`staging/${WEI.id}/${crypto.randomUUID()}/thumb`, 'x');
    profile(MEI.id).deletionDue = new Date(Date.now() - 1000).toISOString();
    expect((await runCleanup(env)).accountsPurged).toBe(1);
    expect([...r2.objects.keys()].filter((k) => k.startsWith(`staging/${MEI.id}/`))).toEqual([]);
    expect([...r2.objects.keys()].filter((k) => k.startsWith(`staging/${WEI.id}/`))).toHaveLength(1);
  });
});

describe('expiry claims like abort (L2)', () => {
  it('complete racing the expiry job never leaves a ready photo without files', async () => {
    const j = await signedIn(MEI);
    const file = jpegFile(100);
    const d = await createUpload(j, 'h.jpg', file);
    expect((await put(LIBRARY_API.uploadPart(d.uploadId, 1), file, { jar: j })).status).toBe(200);
    const realHead = r2.head.bind(r2);
    let releaseHead!: () => void;
    const headGate = new Promise<void>((r) => {
      releaseHead = r;
    });
    let inHead!: () => void;
    const headReached = new Promise<void>((r) => {
      inHead = r;
    });
    vi.spyOn(r2, 'head').mockImplementation(async (k: string) => {
      const h = await realHead(k);
      inHead();
      await headGate;
      return h;
    });
    const completing = call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    await headReached;
    must(db.uploads.get(d.uploadId)).expiresAt = Date.now() - 1;
    const counts = await runCleanup(env);
    expect(counts.uploadsAborted).toBe(1);
    releaseHead();
    expect((await completing).status).toBe(404);
    expect(db.photos.has(d.photoId)).toBe(false);
    expect(objectsUnder(MEI.id)).toEqual([]);
    expect(noDrift(MEI.id)).toBe(true);
    // Claimed once: a second run has nothing to abort.
    vi.restoreAllMocks();
    expect((await runCleanup(env)).uploadsAborted).toBe(0);
  });
});

describe('publishing variants after a failure (L3)', () => {
  async function completeWithFailedPublish(name: string) {
    const j = await signedIn(MEI);
    const file = jpegFile(100, name.length);
    const d = await createUpload(j, name, file);
    await put(LIBRARY_API.uploadPart(d.uploadId, 1), file, { jar: j });
    await put(LIBRARY_API.uploadVariant(d.uploadId, 'thumb'), jpegVariant(100, 100, 3000), { jar: j });
    const realPut = r2.put.bind(r2);
    const spy = vi.spyOn(r2, 'put').mockImplementation(async (key: string, value: unknown, opts) => {
      if (key === `${prefix(MEI.id, d.photoId)}thumb`) throw new Error('R2 down');
      return realPut(key, value, opts);
    });
    const res = await call(LIBRARY_API.uploadComplete(d.uploadId), { jar: j, body: { metadata: {} } });
    spy.mockRestore();
    expect(res.status).toBe(200);
    const photo = must(db.photos.get(d.photoId));
    expect(photo).toMatchObject({ publishPending: true, thumb: 3000 });
    expect(r2.objects.has(`${prefix(MEI.id, d.photoId)}thumb`)).toBe(false);
    expect(r2.objects.has(`staging/${MEI.id}/${d.photoId}/thumb`)).toBe(true);
    return d;
  }

  it('the job copies the staged variant, confirms and unstages it', async () => {
    const d = await completeWithFailedPublish('p1.jpg');
    // The sweep never touches staging, even for pending photos.
    const counts = await runCleanup(env);
    expect(counts).toMatchObject({ variantsPublished: 1, variantsLost: 0 });
    expect(must(r2.objects.get(`${prefix(MEI.id, d.photoId)}thumb`)).bytes.byteLength).toBe(3000);
    expect(r2.objects.has(`staging/${MEI.id}/${d.photoId}/thumb`)).toBe(false);
    expect(must(db.photos.get(d.photoId))).toMatchObject({ publishPending: false, thumb: 3000 });
    expect(noDrift(MEI.id)).toBe(true);
  });

  it('a lost staged copy drops the variant and its counted bytes', async () => {
    const d = await completeWithFailedPublish('p2.jpg');
    const before = must(db.profiles.get(MEI.id)).storage;
    r2.objects.delete(`staging/${MEI.id}/${d.photoId}/thumb`); // the lifecycle rule got there first
    const counts = await runCleanup(env);
    expect(counts.variantsLost).toBe(1);
    expect(must(db.photos.get(d.photoId))).toMatchObject({ publishPending: false, thumb: 0 });
    expect(must(db.profiles.get(MEI.id)).storage).toBe(before - 3000);
    expect(noDrift(MEI.id)).toBe(true);
    const thumb = await call(LIBRARY_API.photoFile(d.photoId, 'thumb'), { jar: await signedIn(MEI) });
    expect(thumb.status).toBe(404);
  });

  it('a staged copy of the wrong size waits for a later run', async () => {
    const d = await completeWithFailedPublish('p3.jpg');
    await r2.put(`staging/${MEI.id}/${d.photoId}/thumb`, jpegVariant(10, 10, 999));
    const counts = await runCleanup(env);
    expect(counts).toMatchObject({ variantsPublished: 0, variantsLost: 0 });
    expect(must(db.photos.get(d.photoId)).publishPending).toBe(true);
    expect(r2.objects.has(`staging/${MEI.id}/${d.photoId}/thumb`)).toBe(true);
  });
});

describe('sweep cursor (L4)', () => {
  it('resets the cursor instead of freezing when it can’t be stored', async () => {
    for (let i = 0; i < 1005; i++) await r2.put(`${prefix(MEI.id, crypto.randomUUID())}original`, 'x');
    const saved: (string | null)[] = [];
    world.rpc.set_job_state = (a) => {
      if (a.p_value !== null) return new Response('{"code":"23514"}', { status: 400 });
      saved.push(null);
      db.jobState.set('orphan_sweep_cursor', null);
      return null;
    };
    const counts = await runCleanup(env);
    expect(counts.orphansDeleted).toBe(1000);
    expect(saved).toEqual([null]);
    expect(db.jobState.get('orphan_sweep_cursor')).toBeNull();
  });
});
