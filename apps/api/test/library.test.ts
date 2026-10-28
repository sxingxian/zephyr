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
    expect(must(r2.objects.get(`${prefix(MEI.id, d.photoId)}thumb`)).contentType).toBe('image/webp');
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
  it('serves variants with fixed type, sandbox CSP, private immutable caching and ETag/304', async () => {
    const j = await signedIn(MEI);
    const { photo } = await storedPhoto(MEI.id);
    const res = await call(LIBRARY_API.photoFile(photo.id, 'thumb'), { jar: j });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
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
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
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
    expect(counts).toMatchObject({ photosPurged: 1, objectsDeleted: 3 });
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
        objectsDeleted: 3,
        rateLimitRows: 0,
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
