import { GALLERY_TOKEN_RE, SHARE_API } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { drainShareDeletions, runCleanup } from '../src/jobs';
import {
  APP,
  call,
  env,
  guestLimiter,
  initKeys,
  installFetch,
  type Jar,
  jar,
  mediaLimiter,
  must,
  r2,
  read,
  resetWorld,
  sbToken,
  shared,
  shareLimiter,
  type User,
  world,
} from './helpers';
import { images } from './images';
import { db, deleteUserCascade, libraryRpc, PLANS, profile, resetDb, seedPhoto } from './library-db';
import { type Gallery, resetShareDb, sdb, shareBytes, shareRpc } from './share-db';

const MEI: User = {
  id: '20000000-0000-0000-0000-000000000001',
  email: 'mei@example.com',
  passkeys: 1,
  displayName: 'Mei Lin',
};
const WEI: User = { id: '20000000-0000-0000-0000-000000000002', email: 'wei@example.com', passkeys: 1 };

// ---- a Cache API stand-in honouring max-age, so the 60-second state lookup can be tested ---------------------
const cacheStore = new Map<string, { body: string; until: number }>();
const fakeCaches = {
  default: {
    async match(k: string) {
      const e = cacheStore.get(k);
      return e && e.until > Date.now() ? new Response(e.body) : undefined;
    },
    async put(k: string, r: Response) {
      const age = Number(/max-age=(\d+)/.exec(r.headers.get('Cache-Control') ?? '')?.[1] ?? 0);
      cacheStore.set(k, { body: await r.text(), until: Date.now() + age * 1000 });
    },
    async delete(k: string) {
      return cacheStore.delete(k);
    },
  },
};

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  resetDb();
  resetShareDb();
  cacheStore.clear();
  vi.stubGlobal('caches', fakeCaches);
  world.users.push({ ...WEI });
  const lib = libraryRpc();
  Object.assign(world.rpc, lib, shareRpc());
  world.rpc.due_account_purges = (a) =>
    ((lib.due_account_purges as (a: Record<string, unknown>) => unknown)(a) as { ownerId: string }[]).map(
      (x) => ({
        ...x,
        sharedPrefix: `o/${x.ownerId}/`,
      }),
    );
  world.onUserDeleted = deleteUserCascade;
  sdb.plans.set(MEI.id, 'studio');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- fixtures -----------------------------------------------------------------------------------------------
async function signedIn(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}
const JPEG = (n = 300) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], 0);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, 3000 >> 8, 3000 & 0xff, 4000 >> 8, 4000 & 0xff, 0x03], 20);
  return b;
};
const PNG = (n = 300) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};
/** A ready photo with its preview and original in R2. */
async function photo(owner: string, fileType = 'jpeg') {
  const p = seedPhoto(owner, { fileType, filename: fileType === 'jpeg' ? 'IMG_0001.jpg' : 'IMG_0001.CR2' });
  await r2.put(`u/${owner}/p/${p.id}/preview`, JPEG(), { httpMetadata: { contentType: 'image/jpeg' } });
  await r2.put(`u/${owner}/p/${p.id}/original`, JPEG(900), { httpMetadata: { contentType: 'image/jpeg' } });
  return p;
}
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
async function create(j: Jar, photoIds: string[], over: Record<string, unknown> = {}) {
  return call(SHARE_API.galleries, {
    jar: j,
    body: {
      name: 'Wedding',
      photoIds,
      passcode: true,
      expiresOn: inDays(5),
      downloads: 'web',
      extras: {},
      ...over,
    },
  });
}
async function created(j: Jar, photoIds: string[], over: Record<string, unknown> = {}) {
  const res = await create(j, photoIds, over);
  expect(res.status).toBe(201);
  const body = await read(res);
  const token = String(body.url).split('/g/')[1] as string;
  return { ...body, token, g: sdb.galleries.get(body.gallery.id) as Gallery };
}
async function put(
  path: string,
  bytes: Uint8Array,
  j: Jar | null,
  type = 'image/jpeg',
  headers: Record<string, string> = {},
) {
  return app.request(
    `${APP}${path}`,
    {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '203.0.113.7',
        'Content-Type': type,
        Origin: APP,
        ...(j ? { Cookie: [...j.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        'Content-Length': String(bytes.byteLength),
        ...headers,
      },
      body: bytes,
    },
    env,
  );
}
/** Unlocks as a guest (Turnstile-free first attempt); returns the guest's jar. */
async function unlock(token: string, passcode: string, g = jar(), ip?: string) {
  const res = await call(SHARE_API.guestUnlock(token), { jar: g, body: { passcode }, ip });
  return { res, g };
}
const photosOf = async (token: string, g: Jar) => read(await call(SHARE_API.guestPhotos(token), { jar: g }));
const get = (url: string, g?: Jar) => call(url, { jar: g });
const sharedKeys = (pfx = '') => [...shared.objects.keys()].filter((k) => k.startsWith(pfx));
const usageOk = (owner: string) => {
  const stored = [...db.photos.values()]
    .filter((p) => p.owner === owner)
    .reduce((n, p) => n + p.size + p.thumb + p.preview, 0);
  return profile(owner).storage === stored + shareBytes(owner);
};

// ---- members ------------------------------------------------------------------------------------------------
describe('member galleries', () => {
  it('creates a gallery: link and passcode shown once, token stored only as a hash and encrypted', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const res = await create(j, [p.id]);
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body.url).toMatch(new RegExp(`^${APP}/g/[A-Za-z0-9_-]{43}$`));
    expect(body.passcode).toMatch(/^[0-9]{6}$/);
    const token = String(body.url).split('/g/')[1] as string;
    expect(GALLERY_TOKEN_RE.test(token)).toBe(true);
    const g = sdb.galleries.get(body.gallery.id) as Gallery;
    expect(g.tokenHash).not.toContain(token);
    expect(g.linkCt).not.toContain(token);
    expect(g.passcodeHmac).not.toContain(body.passcode);
    expect(body.gallery).toMatchObject({
      name: 'Wedding',
      status: 'live',
      photoCount: 1,
      passcode: true,
      linkHint: token.slice(0, 8),
    });
    // The owner can copy the same link again; nobody else can.
    expect(await read(await call(SHARE_API.galleryLink(g.id), { jar: j }))).toEqual({
      ok: true,
      url: body.url,
    });
    expect((await call(SHARE_API.galleryLink(g.id), { jar: await signedIn(WEI) })).status).toBe(404);
    // A ciphertext moved to another gallery doesn't decrypt (the id is authenticated).
    const other = await created(j, [p.id]);
    other.g.linkCt = g.linkCt;
    other.g.linkIv = g.linkIv;
    expect((await call(SHARE_API.galleryLink(other.g.id), { jar: j })).status).toBe(500);
  });

  it('enforces plan limits: full size, extras, live-gallery cap, link length', async () => {
    const j = await signedIn(WEI);
    const p = await photo(WEI.id);
    expect((await read(await create(j, [p.id], { downloads: 'full' }))).error).toBe('plan_required');
    expect((await create(j, [p.id], { extras: { favourites: true } })).status).toBe(403);
    expect((await create(j, [p.id], { expiresOn: inDays(8) })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await create(j, [p.id])).status).toBe(201);
    const fourth = await create(j, [p.id]);
    expect(fourth.status).toBe(409);
    expect((await read(fourth)).error).toBe('quota_exceeded');
  });

  it('is per owner, needs a session, the expected user and an allowed origin, and is rate limited', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { g } = await created(j, [p.id]);
    const w = await signedIn(WEI);
    for (const path of [
      SHARE_API.gallery(g.id),
      SHARE_API.galleryPhotos(g.id),
      SHARE_API.galleryFavourites(g.id),
      SHARE_API.galleryActivity(g.id),
      SHARE_API.galleryRenderQueue(g.id),
      SHARE_API.galleryPreview(g.id),
    ]) {
      expect((await call(path, { jar: w })).status).toBe(404);
    }
    expect((await call(SHARE_API.gallery(g.id), { jar: w, method: 'DELETE' })).status).toBe(404);
    expect((await create(w, [p.id])).status).toBe(400); // someone else's photo
    expect((await call(SHARE_API.galleries)).status).toBe(401);
    expect((await call(SHARE_API.galleries, { jar: j, body: {}, origin: 'https://evil.test' })).status).toBe(
      403,
    );
    const changed = await call(SHARE_API.gallery(g.id), {
      jar: j,
      method: 'PATCH',
      body: { name: 'x' },
      headers: { 'X-Zephyr-Expected-User': WEI.id },
    });
    expect(changed.status).toBe(409);
    shareLimiter.ok = false;
    expect(
      (await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { name: 'x' } })).status,
    ).toBe(429);
    expect((await call(SHARE_API.galleryLink(g.id), { jar: j })).status).toBe(429);
    shareLimiter.ok = true;
    expect(shareLimiter.keys.every((k) => k === `share:${MEI.id}` || k === `share:${WEI.id}`)).toBe(true);
    profile(MEI.id).deletionDue = new Date(Date.now() + 86400000).toISOString();
    expect((await read(await call(SHARE_API.galleries, { jar: j }))).error).toBe('account_pending_deletion');
  });

  it('lists, changes, adds and removes photos, and revokes for good', async () => {
    const j = await signedIn(MEI);
    const [a, b, c] = [await photo(MEI.id), await photo(MEI.id), await photo(MEI.id)];
    const { g, token } = await created(j, [a.id, b.id]);
    expect((await read(await call(SHARE_API.galleries, { jar: j }))).galleries).toHaveLength(1);
    const patched = await read(
      await call(SHARE_API.gallery(g.id), {
        jar: j,
        method: 'PATCH',
        body: { name: '  Reception ', message: 'Hi' },
      }),
    );
    expect(patched.gallery).toMatchObject({ name: 'Reception', message: 'Hi' });
    expect((await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: {} })).status).toBe(400);
    expect(
      await read(
        await call(SHARE_API.galleryPhotos(g.id), { jar: j, body: { add: [c.id], remove: [a.id] } }),
      ),
    ).toEqual({ ok: true, count: 2 });
    const page = await read(await call(SHARE_API.galleryPhotos(g.id), { jar: j }));
    expect(page.items.map((x: { photoId: string }) => x.photoId)).toEqual([b.id, c.id]);
    expect((await call(`${SHARE_API.galleryPhotos(g.id)}?cursor=abc`, { jar: j })).status).toBe(400);
    expect((await call(SHARE_API.gallery(g.id), { jar: j, method: 'DELETE' })).status).toBe(204);
    expect((await read(await call(SHARE_API.gallery(g.id), { jar: j }))).gallery.status).toBe('revoked');
    expect(
      (await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { name: 'x' } })).status,
    ).toBe(409);
    expect((await call(SHARE_API.galleryLink(g.id), { jar: j })).status).toBe(404);
    expect((await read(await get(SHARE_API.guest(token)))).state).toBe('ended');
  });

  it('a new passcode ends unlocked sessions; turning it off opens the gallery', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { g, token, passcode } = await created(j, [p.id]);
    const { g: guest } = await unlock(token, passcode);
    expect((await call(SHARE_API.guestPhotos(token), { jar: guest })).status).toBe(200);
    const fresh = await read(await call(SHARE_API.galleryPasscode(g.id), { jar: j, body: {} }));
    expect(fresh.passcode).toMatch(/^[0-9]{6}$/);
    expect(g.generation).toBe(2);
    expect((await call(SHARE_API.guestPhotos(token), { jar: guest })).status).toBe(401);
    expect((await unlock(token, passcode, jar(), '198.51.100.1')).res.status).toBe(401);
    expect((await unlock(token, fresh.passcode, jar(), '198.51.100.1')).res.status).toBe(200);
    expect((await call(SHARE_API.galleryPasscode(g.id), { jar: j, method: 'DELETE' })).status).toBe(204);
    expect((await read(await get(SHARE_API.guest(token)))).state).toBe('open');
    expect((await call(SHARE_API.galleryPasscode(g.id), { jar: await signedIn(WEI), body: {} })).status).toBe(
      404,
    );
  });
});

// ---- guests: info and unlock --------------------------------------------------------------------------------
describe('guest info and unlock', () => {
  it('unknown and malformed tokens get the same 404; responses are no-store and no-referrer', async () => {
    for (const t of ['A'.repeat(43), 'short', `${'A'.repeat(42)}!`]) {
      const res = await get(SHARE_API.guest(t));
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    }
    guestLimiter.ok = false;
    expect((await get(SHARE_API.guest('A'.repeat(43)))).status).toBe(429);
  });

  it('a locked page shows the name and brand, not the message or photos', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token, passcode } = await created(j, [p.id], { message: 'Private note' });
    const info = await read(await get(SHARE_API.guest(token)));
    expect(info).toMatchObject({
      ok: true,
      state: 'locked',
      name: 'Wedding',
      message: null,
      photoCount: 0,
      turnstile: false,
    });
    expect(info.brand.studioName).toBe('Mei Lin');
    expect((await call(SHARE_API.guestPhotos(token))).status).toBe(401);
    const { g } = await unlock(token, passcode);
    const open = await read(await get(SHARE_API.guest(token), g));
    expect(open).toMatchObject({ state: 'open', message: 'Private note', photoCount: 1 });
  });

  it('wrong passcodes: remaining count, Turnstile after 2, 5 per network, then a pause from anywhere', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token, passcode, g } = await created(j, [p.id]);
    const wrong = passcode === '000000' ? '111111' : '000000';
    const first = await unlock(token, wrong);
    expect(first.res.status).toBe(401);
    expect(await read(first.res)).toEqual({ ok: false, error: 'wrong_passcode', remaining: 4 });
    const second = await read((await unlock(token, wrong)).res);
    expect(second).toMatchObject({ error: 'wrong_passcode', remaining: 3, turnstile: true });
    // Without a token: 400, nothing counted.
    const third = await unlock(token, wrong);
    expect(third.res.status).toBe(400);
    expect(await read(third.res)).toMatchObject({ error: 'verification_failed', turnstile: true });
    expect((await read(await get(SHARE_API.guest(token)))).turnstile).toBe(true);
    // A token for another form fails.
    world.turnstile = { success: true, hostname: 'zephyrapp.midnightpoetry.studio', action: 'email_start' };
    expect(
      (await call(SHARE_API.guestUnlock(token), { body: { passcode: wrong, turnstileToken: 't' } })).status,
    ).toBe(400);
    world.turnstile.action = 'gallery_unlock';
    for (const left of [2, 1, 0]) {
      const r = await call(SHARE_API.guestUnlock(token), { body: { passcode: wrong, turnstileToken: 't' } });
      expect((await read(r)).remaining).toBe(left);
    }
    const limited = await call(SHARE_API.guestUnlock(token), { body: { passcode, turnstileToken: 't' } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    // 25 failures from anywhere pause unlocking and email the owner once.
    for (let i = 0; sdb.attempts.length < 24; i++) await unlock(token, wrong, jar(), `198.51.100.${i + 1}`);
    const paused = await unlock(token, wrong, jar(), '192.0.2.200');
    expect(paused.res.status).toBe(423);
    expect(await read(paused.res)).toMatchObject({ error: 'gallery_paused' });
    expect(paused.res.headers.get('Retry-After')).toBe('900');
    expect(world.emails.filter((e) => e.to === MEI.email && /paused/.test(e.subject))).toHaveLength(1);
    const still = await unlock(token, passcode, jar(), '192.0.2.201');
    expect(still.res.status).toBe(423);
    expect((await read(await get(SHARE_API.guest(token)))).state).toBe('paused');
    // Reopening clears it.
    await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { unpause: true } });
    expect((await unlock(token, passcode, jar(), '192.0.2.202')).res.status).toBe(200);
    // Paused again the same day: no second email (at most one a day per gallery).
    for (let i = 0; sdb.attempts.length < 24; i++) await unlock(token, wrong, jar(), `198.51.101.${i + 1}`);
    expect((await unlock(token, wrong, jar(), '192.0.2.210')).res.status).toBe(423);
    expect(world.emails.filter((e) => e.to === MEI.email && /paused/.test(e.subject))).toHaveLength(1);
  });

  it('an ended link names neither the gallery nor its owner', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token, g } = await created(j, [p.id], { passcode: false });
    expect((await read(await get(SHARE_API.guest(token)))).brand.studioName).toBe('Mei Lin');
    await call(SHARE_API.gallery(g.id), { jar: j, method: 'DELETE' });
    const info = await read(await get(SHARE_API.guest(token)));
    expect(info).toMatchObject({ state: 'ended', name: '', message: null });
    expect(info.brand).toEqual({ studioName: '', accent: null, logoUrl: null });
    expect(JSON.stringify(info)).not.toMatch(/Mei|Wedding/);
  });

  it('the unlock cookie: HttpOnly __Host- cookie, forged, expired and moved cookies fail', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const a = await created(j, [p.id]);
    const b = await created(j, [p.id]);
    const { res, g } = await unlock(a.token, a.passcode);
    const sc = res.headers.get('Set-Cookie') ?? '';
    const name = `__Host-zg-${a.g.id.replace(/-/g, '').slice(0, 12)}`;
    expect(sc).toMatch(
      new RegExp(
        `^${name}=1\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$`,
      ),
    );
    expect((await call(SHARE_API.guestPhotos(a.token), { jar: g })).status).toBe(200);
    const value = g.cookies.get(name) as string;
    const [gen, exp, sig] = value.split('.');
    const forge = (v: string) => {
      const f = jar();
      f.cookies.set(name, v);
      return f;
    };
    expect(
      (await call(SHARE_API.guestPhotos(a.token), { jar: forge(`${gen}.${Number(exp) + 3600}.${sig}`) }))
        .status,
    ).toBe(401);
    expect(
      (await call(SHARE_API.guestPhotos(a.token), { jar: forge(`${gen}.${exp}.${'A'.repeat(43)}`) })).status,
    ).toBe(401);
    // Another gallery's cookie under this gallery's name doesn't unlock it.
    const other = jar();
    other.cookies.set(`__Host-zg-${b.g.id.replace(/-/g, '').slice(0, 12)}`, value);
    expect((await call(SHARE_API.guestPhotos(b.token), { jar: other })).status).toBe(401);
    // After 12 hours it's expired.
    vi.useFakeTimers({ now: Date.now() + 12 * 3600 * 1000 + 1000, toFake: ['Date'] });
    expect((await call(SHARE_API.guestPhotos(a.token), { jar: g })).status).toBe(401);
  });
});

// ---- guest photos and media ---------------------------------------------------------------------------------
describe('guest photos and media', () => {
  async function setup(over: Record<string, unknown> = {}, owner = MEI) {
    const j = await signedIn(owner);
    const p = await photo(owner.id);
    const c = await created(j, [p.id], { passcode: false, ...over });
    const page = await photosOf(c.token, jar());
    return { j, p, ...c, item: page.items?.[0], page };
  }

  it('lists photos with signed same-origin URLs; downloads only when on', async () => {
    const { item, token, page } = await setup({ downloads: 'none' });
    expect(item.grid).toMatch(
      new RegExp(`^/api/v1/g/${token}/m/[0-9a-f-]{36}/grid\\?e=\\d+&s=[A-Za-z0-9_-]{43}$`),
    );
    expect(item.download).toBeUndefined();
    expect(item.favourite).toBeUndefined();
    expect(page.selection).toBeUndefined();
    const full = await setup({ downloads: 'full' });
    expect(full.item.download.full).toMatch(/\/full\?/);
    expect(full.item.download.web).toMatch(/\/web\?/);
    // Free: full size degrades to web after a downgrade.
    sdb.plans.set(MEI.id, 'free');
    const again = await photosOf(full.token, jar());
    expect(again.items[0].download.full).toBeNull();
  });

  it('makes a grid rendition once, stores it in zephyr-shared, counts it, serves it through the media host', async () => {
    const { item, g, p } = await setup();
    const res = await get(item.grid);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(images.pipelines).toHaveLength(1);
    expect(images.pipelines[0]?.ops[0]).toEqual([
      'transform',
      { width: 640, height: 640, fit: 'scale-down' },
    ]);
    expect(images.pipelines[0]?.output).toEqual({ format: 'image/jpeg', quality: 82 });
    const keys = sharedKeys(`o/${MEI.id}/g/${g.id}/${p.id}/grid-`);
    expect(keys).toHaveLength(1);
    expect(world.media.fetched).toEqual(keys);
    expect(usageOk(MEI.id)).toBe(true);
    expect((await get(item.grid)).status).toBe(200);
    expect(images.pipelines).toHaveLength(1);
    mediaLimiter.ok = false;
    expect((await get(item.grid)).status).toBe(429);
  });

  it('refuses tampered, expired, moved and other-gallery URLs', async () => {
    const a = await setup();
    const b = await setup();
    const bad = [
      a.item.grid.replace(/s=([A-Za-z0-9_-])/, (_: string, ch: string) => `s=${ch === 'A' ? 'B' : 'A'}`),
      a.item.grid.replace('/grid?', '/view?'),
      a.item.grid.replace(a.token, b.token),
      a.item.grid.replace(a.p.id, b.p.id),
      a.item.grid.replace(/e=\d+/, (m: string) => `e=${Number(m.slice(2)) + 3600}`),
      a.item.grid.split('?')[0],
    ];
    for (const url of bad) expect((await get(url as string)).status).toBe(404);
    vi.useFakeTimers({ now: Date.now() + 3 * 3600 * 1000, toFake: ['Date'] });
    expect((await get(a.item.grid)).status).toBe(404);
  });

  it('revoking stops media at once; a new passcode stops old URLs within 60 seconds', async () => {
    const a = await setup({ passcode: true });
    const { g } = await unlock(a.token, a.passcode);
    const item = (await photosOf(a.token, g)).items[0];
    expect((await get(item.view)).status).toBe(200);
    await call(SHARE_API.galleryPasscode(a.g.id), { jar: a.j, body: {} });
    expect((await get(item.view)).status).toBe(200); // cached state, same generation
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ['Date'] });
    expect((await get(item.view)).status).toBe(404);
    vi.useRealTimers();
    const b = await setup();
    expect((await get(b.item.grid)).status).toBe(200);
    await call(SHARE_API.gallery(b.g.id), { jar: b.j, method: 'DELETE' });
    expect((await get(b.item.grid)).status).toBe(404);
    expect(usageOk(MEI.id)).toBe(true);
  });

  it('downloads: web and full as attachments, logged; full needs the plan', async () => {
    const { item, g } = await setup({ downloads: 'full', extras: { accessLog: true } });
    const web = await get(item.download.web);
    // Never the member's file name: the gallery name and the position.
    expect(web.headers.get('Content-Disposition')).toMatch(/^attachment; filename="Wedding 001-web\.jpg"/);
    const full = await get(item.download.full);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Disposition')).toMatch(/filename="Wedding 001-full\.jpg"/);
    expect(full.headers.get('Content-Disposition')).not.toContain('IMG_0001');
    // Full size comes from the original, re-encoded without resizing.
    expect(images.pipelines.at(-1)?.ops).toEqual([]);
    expect(images.pipelines.at(-1)?.inputBytes).toBe(900);
    expect(g.downloadCount).toBe(2);
    expect(sdb.events.filter((e) => e.kind === 'downloaded')).toHaveLength(2);
    sdb.plans.set(MEI.id, 'free');
    expect((await get(item.download.full)).status).toBe(404);
  });

  it('downloads are checked when served: turning downloads off stops URLs already handed out', async () => {
    const { item, g, j } = await setup({ downloads: 'web' });
    expect((await get(item.download.web)).status).toBe(200);
    await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { downloads: 'none' } });
    const res = await get(item.download.web);
    expect(res.status).toBe(404);
    expect((await get(item.view)).status).toBe(200);
  });

  it('an edited photo whose edited preview is not ready is pending, never the unedited original', async () => {
    const { item, p } = await setup();
    // A rendition made from the original before the edit.
    expect((await get(item.view)).status).toBe(200);
    db.edits.set(p.id, {
      photoId: p.id,
      owner: MEI.id,
      recipe: { v: 1, crop: { x: 0.5 } },
      version: 2,
      thumbVersion: null,
      thumbKey: null,
      thumbBytes: 0,
      previewVersion: null,
      previewKey: null,
      previewBytes: 0,
      updatedAt: new Date().toISOString(),
    });
    images.reset();
    for (const url of [item.grid, item.view]) {
      const res = await get(url);
      expect(res.status).toBe(503);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Retry-After')).toBe('30');
      expect(await read(res)).toMatchObject({ ok: false, error: 'pending' });
    }
    expect(images.pipelines).toHaveLength(0);
    expect(world.media.fetched.filter((k) => k.includes('/view-'))).toHaveLength(1);
    // Once the edited preview lands, a new rendition is made from it.
    const key = `u/${MEI.id}/p/${p.id}/edit-2-preview-${'a'.repeat(32)}`;
    await r2.put(key, JPEG(), { httpMetadata: { contentType: 'image/jpeg' } });
    Object.assign(must(db.edits.get(p.id)), { previewVersion: 2, previewKey: key, previewBytes: 300 });
    expect((await get(item.view)).status).toBe(200);
    expect(images.pipelines).toHaveLength(1);
  });

  it('edited photos report the edited output’s size, never the uncropped original’s', async () => {
    const { p, token } = await setup();
    const sizeOf = async () => {
      const page = await photosOf(token, jar());
      return [page.items[0].width, page.items[0].height];
    };
    expect(await sizeOf()).toEqual([4000, 3000]);
    // Cropped to half the width and turned a quarter: 3000 × 2000 out, before any preview is stored.
    db.edits.set(p.id, {
      photoId: p.id,
      owner: MEI.id,
      recipe: { v: 1, crop: { quarterTurns: 1, rect: { x: 0, y: 0, w: 1, h: 0.5 } } },
      version: 3,
      thumbVersion: null,
      thumbKey: null,
      thumbBytes: 0,
      previewVersion: null,
      previewKey: null,
      previewBytes: 0,
      updatedAt: new Date().toISOString(),
    });
    expect(await sizeOf()).toEqual([3000, 2000]);
    // The stored preview's aspect wins, scaled to the output's long edge.
    Object.assign(must(db.edits.get(p.id)), {
      previewVersion: 3,
      previewKey: `u/${MEI.id}/p/${p.id}/edit-3-preview-${'b'.repeat(32)}`,
      previewBytes: 300,
      previewWidth: 2048,
      previewHeight: 1366,
    });
    expect(await sizeOf()).toEqual([3000, 2001]);
    // A preview of an older version doesn't count.
    must(db.edits.get(p.id)).version = 4;
    expect(await sizeOf()).toEqual([3000, 2000]);
  });

  it('watermark on but nothing to draw: pending, never unwatermarked', async () => {
    const { item, j, g } = await setup({ extras: { watermark: true } });
    images.reset();
    const res = await get(item.view);
    expect(res.status).toBe(503);
    expect(images.pipelines).toHaveLength(0);
    const before = await read(await call(SHARE_API.gallery(g.id), { jar: j }));
    expect(before.gallery.watermarkReady).toBe(false);
    expect((await put(SHARE_API.brandingAsset('watermark'), PNG(), j, 'image/png')).status).toBe(200);
    // The stored watermark image vanished from the bucket: still never unwatermarked.
    const wmKey = must(sdb.branding.get(MEI.id)?.wmKey);
    shared.objects.delete(wmKey);
    expect((await get(item.view)).status).toBe(503);
    expect(sharedKeys(`o/${MEI.id}/g/`)).toHaveLength(0);
  });

  it('past the storage allowance, previews are pending and the member is told', async () => {
    const { item, g, j } = await setup();
    const lim = PLANS.pro.storage;
    const allowance = Math.min(Math.floor(lim / 10), 5 * 1073741824);
    // Over the plan but within the allowance: previews are still made.
    profile(MEI.id).storage += lim;
    expect((await get(item.grid)).status).toBe(200);
    // Past the allowance: pending, and flagged for Settings and the gallery.
    profile(MEI.id).storage += allowance;
    images.reset();
    expect((await get(item.view)).status).toBe(503);
    expect(images.pipelines).toHaveLength(0);
    const detail = await read(await call(SHARE_API.gallery(g.id), { jar: j }));
    expect(detail.gallery.storageFull).toBe(true);
    profile(MEI.id).storage -= lim + allowance;
    expect((await get(item.view)).status).toBe(200);
  });

  it('watermarks while the plan has it; a downgrade turns it off', async () => {
    const { item, j } = await setup({ extras: { watermark: true } });
    expect((await put(SHARE_API.brandingAsset('watermark'), PNG(), j, 'image/png')).status).toBe(200);
    images.reset();
    expect((await get(item.view)).status).toBe(200);
    const draw = images.pipelines[0]?.ops.find((o) => o[0] === 'draw');
    expect(draw?.[1]).toMatchObject({ opacity: 0.7, bottom: expect.any(Number), right: expect.any(Number) });
    sdb.plans.set(MEI.id, 'pro');
    images.reset();
    expect((await get(item.view)).status).toBe(200);
    expect(images.pipelines[0]?.ops.some((o) => o[0] === 'draw')).toBe(false);
  });

  it('a 451 from the media host holds the photo, suspends sharing and alerts the safety team', async () => {
    const { item, p, token, j } = await setup();
    world.media.blocked = { has: () => true } as unknown as Set<string>;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await get(item.grid);
    expect(res.status).toBe(404);
    expect(logged.mock.calls.flat().join(' ')).toContain('safety_451');
    expect(sdb.held.has(p.id)).toBe(true);
    expect(sdb.suspended.has(MEI.id)).toBe(true);
    expect(sdb.audit).toContainEqual({ action: 'safety.csam_match', target: p.id });
    const alert = world.emails.find((e) => e.to === 'safety@zephyr.test');
    expect(alert?.text).toContain(p.id);
    expect(alert?.html).not.toMatch(/<img|https?:\/\/media/);
    expect((await read(await get(SHARE_API.guest(token)))).state).toBe('ended');
    expect((await create(j, [(await photo(MEI.id)).id])).status).toBe(403);
    expect(usageOk(MEI.id)).toBe(true);
  });

  it('media host down or an image the binding rejects: an error, nothing kept', async () => {
    const a = await setup();
    world.media.down = true;
    expect((await get(a.item.grid)).status).toBe(502);
    world.media.down = false;
    const b = await setup();
    images.fail = true;
    expect((await get(b.item.grid)).status).toBe(502);
    expect(sharedKeys(`o/${MEI.id}/g/${b.g.id}/`)).toHaveLength(0);
  });

  it('two requests racing to make the same rendition record one; the other object is deleted', async () => {
    const { item, g } = await setup();
    const [x, y] = await Promise.all([get(item.view), get(item.view)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(sdb.renditions.filter((r) => r.gallery === g.id)).toHaveLength(1);
    expect(sharedKeys(`o/${MEI.id}/g/${g.id}/`)).toEqual([sdb.renditions[0]?.key]);
    expect(usageOk(MEI.id)).toBe(true);
  });
});

// ---- full-size renders --------------------------------------------------------------------------------------
describe('full-size renders from the device', () => {
  it('queues RAW and edited photos, stores a render once, counts it, refuses stale and full storage', async () => {
    sdb.plans.set(MEI.id, 'pro');
    const j = await signedIn(MEI);
    const raw = await photo(MEI.id, 'cr2');
    const { g, token } = await created(j, [raw.id], { downloads: 'full', passcode: false });
    expect(await read(await call(SHARE_API.galleryRenderQueue(g.id), { jar: j }))).toEqual({
      ok: true,
      pending: [{ photoId: raw.id, editVersion: 0 }],
    });
    expect((await photosOf(token, jar())).items[0].download.full).toBeNull();
    expect((await put(SHARE_API.galleryFullRender(g.id, raw.id, 3), JPEG(), j)).status).toBe(410);
    expect((await put(SHARE_API.galleryFullRender(g.id, raw.id, 0), PNG(), j, 'image/jpeg')).status).toBe(
      415,
    );
    expect((await put(SHARE_API.galleryFullRender(g.id, raw.id, 0), PNG(), j, 'image/png')).status).toBe(415);
    expect((await put(SHARE_API.galleryFullRender(g.id, crypto.randomUUID(), 0), JPEG(), j)).status).toBe(
      404,
    );
    expect(
      (await put(SHARE_API.galleryFullRender(g.id, raw.id, 0), JPEG(), await signedIn(WEI))).status,
    ).toBe(404);
    // Two at once: one counts, the other's object goes.
    const [a, b] = await Promise.all([
      put(SHARE_API.galleryFullRender(g.id, raw.id, 0), JPEG(500), j),
      put(SHARE_API.galleryFullRender(g.id, raw.id, 0), JPEG(500), j),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(sdb.renders).toHaveLength(1);
    expect([...r2.objects.keys()].filter((k) => k.startsWith(`u/${MEI.id}/g/${g.id}/`))).toEqual([
      sdb.renders[0]?.key,
    ]);
    expect(usageOk(MEI.id)).toBe(true);
    expect((await read(await call(SHARE_API.galleryRenderQueue(g.id), { jar: j }))).pending).toEqual([]);
    const item = (await photosOf(token, jar())).items[0];
    expect((await get(item.download.full)).status).toBe(200);
    expect(images.pipelines.at(-1)?.inputBytes).toBe(500);
    // Storage full.
    const raw2 = await photo(MEI.id, 'cr2');
    await call(SHARE_API.galleryPhotos(g.id), { jar: j, body: { add: [raw2.id] } });
    profile(MEI.id).storage += 250 * 1024 ** 3;
    expect((await put(SHARE_API.galleryFullRender(g.id, raw2.id, 0), JPEG(), j)).status).toBe(413);
    // Turning full-size downloads off drops renders (they only count while shared).
    profile(MEI.id).storage -= 250 * 1024 ** 3;
    await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { downloads: 'web' } });
    expect(sdb.renders).toHaveLength(0);
    expect(usageOk(MEI.id)).toBe(true);
    expect((await put(SHARE_API.galleryFullRender(g.id, raw2.id, 0), JPEG(), j)).status).toBe(410);
  });

  it('needs a length, a JPEG and the size limit', async () => {
    const j = await signedIn(MEI);
    const raw = await photo(MEI.id, 'cr2');
    const { g } = await created(j, [raw.id], { downloads: 'full' });
    expect(
      (
        await put(SHARE_API.galleryFullRender(g.id, raw.id, 0), JPEG(), j, 'image/jpeg', {
          'Content-Length': String(65 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await put(SHARE_API.galleryFullRender(g.id, raw.id, 0), JPEG(), j, 'image/jpeg', {
          Origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
  });
});

// ---- favourites and reports ---------------------------------------------------------------------------------
describe('favourites', () => {
  it('a browser favourites photos and sends them; the owner is emailed at most hourly', async () => {
    const j = await signedIn(MEI);
    const [a, b] = [await photo(MEI.id), await photo(MEI.id)];
    const { g, token } = await created(j, [a.id, b.id], {
      passcode: false,
      extras: { favourites: true, accessLog: true },
    });
    const guest = jar();
    expect((await call(SHARE_API.guestSend(token), { jar: guest, body: { name: 'Lin' } })).status).toBe(400);
    const fav = await call(SHARE_API.guestFavourite(token, a.id), { jar: guest, method: 'PUT', body: {} });
    expect(fav.status).toBe(204);
    expect(fav.headers.get('Set-Cookie')).toMatch(
      /^__Host-zv=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(sdb.guests[0]?.hash).not.toContain(guest.cookies.get('__Host-zv'));
    await call(SHARE_API.guestFavourite(token, b.id), { jar: guest, method: 'PUT', body: {} });
    await call(SHARE_API.guestFavourite(token, b.id), { jar: guest, method: 'DELETE' });
    const page = await photosOf(token, guest);
    expect(page.selection).toEqual({ count: 1, sentAt: null, name: null });
    expect(page.items.map((x: { favourite: boolean }) => x.favourite)).toEqual([true, false]);
    expect(
      (
        await call(SHARE_API.guestFavourite(token, crypto.randomUUID()), {
          jar: guest,
          method: 'PUT',
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(SHARE_API.guestSend(token), {
          jar: guest,
          body: { name: ' Lin <b>', note: 'These‮ please' },
        })
      ).status,
    ).toBe(200);
    const mail = world.emails.find((e) => e.to === MEI.email);
    expect(mail?.subject).toContain('Lin <b> sent favourites');
    expect(mail?.html).toContain('Lin &lt;b&gt;');
    expect(mail?.html).not.toContain('‮');
    const other = jar();
    await call(SHARE_API.guestFavourite(token, b.id), { jar: other, method: 'PUT', body: {} });
    await call(SHARE_API.guestSend(token), { jar: other, body: { name: 'Ann' } });
    expect(world.emails.filter((e) => e.to === MEI.email)).toHaveLength(1);
    const sel = await read(await call(SHARE_API.galleryFavourites(g.id), { jar: j }));
    expect(sel.guests).toHaveLength(2);
    const act = await read(await call(SHARE_API.galleryActivity(g.id), { jar: j }));
    expect(act.events.map((e: { kind: string }) => e.kind)).toContain('favourites_sent');
  });

  it('the favourites id is hashed per gallery; one network makes at most 20 new guests a day', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const a = await created(j, [p.id], { passcode: false, extras: { favourites: true } });
    const b = await created(j, [p.id], { passcode: false, extras: { favourites: true } });
    const guest = jar();
    await call(SHARE_API.guestFavourite(a.token, p.id), { jar: guest, method: 'PUT', body: {} });
    await call(SHARE_API.guestFavourite(b.token, p.id), { jar: guest, method: 'PUT', body: {} });
    const [ha, hb] = [sdb.guests[0]?.hash, sdb.guests[1]?.hash];
    expect(ha).toBeTruthy();
    expect(ha).not.toBe(hb);
    for (let n = 1; n < 20; n++) {
      const res = await call(SHARE_API.guestFavourite(a.token, p.id), {
        jar: jar(),
        method: 'PUT',
        body: {},
      });
      expect(res.status).toBe(204);
    }
    const over = await call(SHARE_API.guestFavourite(a.token, p.id), { jar: jar(), method: 'PUT', body: {} });
    expect(over.status).toBe(409);
    expect(await read(over)).toMatchObject({ error: 'limit_reached' });
    // Another network still can; an existing guest still can.
    expect(
      (
        await call(SHARE_API.guestFavourite(a.token, p.id), {
          jar: jar(),
          method: 'PUT',
          body: {},
          ip: '198.51.100.9',
        })
      ).status,
    ).toBe(204);
    expect(
      (await call(SHARE_API.guestFavourite(a.token, p.id), { jar: guest, method: 'PUT', body: {} })).status,
    ).toBe(204);
    // IPv6: the cap is per /48, so rotating /64s inside one customer's /48 doesn't reset it.
    const v6 = (n: number) => `2001:db8:77:${n.toString(16)}::1`;
    for (let n = 0; n < 20; n++) {
      const res = await call(SHARE_API.guestFavourite(b.token, p.id), {
        jar: jar(),
        method: 'PUT',
        body: {},
        ip: v6(n),
      });
      expect(res.status).toBe(204);
    }
    const rotated = await call(SHARE_API.guestFavourite(b.token, p.id), {
      jar: jar(),
      method: 'PUT',
      body: {},
      ip: v6(999),
    });
    expect(rotated.status).toBe(409);
    expect(
      (
        await call(SHARE_API.guestFavourite(b.token, p.id), {
          jar: jar(),
          method: 'PUT',
          body: {},
          ip: '2001:db8:78::1',
        })
      ).status,
    ).toBe(204);
  });

  it('only guests with favourites count toward the 500 cap', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { g, token } = await created(j, [p.id], { passcode: false, extras: { favourites: true } });
    const add = (n: number, favs: boolean) => {
      for (let i = 0; i < n; i++)
        sdb.guests.push({
          id: crypto.randomUUID(),
          gallery: g.id,
          hash: `\\x${i}${favs}`,
          name: null,
          note: null,
          sentAt: null,
          favs: new Set(favs ? [p.id] : []),
        });
    };
    add(600, false);
    add(499, true);
    expect(
      (await call(SHARE_API.guestFavourite(token, p.id), { jar: jar(), method: 'PUT', body: {} })).status,
    ).toBe(204);
    expect(
      (await call(SHARE_API.guestFavourite(token, p.id), { jar: jar(), method: 'PUT', body: {} })).status,
    ).toBe(409);
  });

  it('off without the plan or the extra', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token } = await created(j, [p.id], { passcode: false });
    expect((await call(SHARE_API.guestFavourite(token, p.id), { method: 'PUT', body: {} })).status).toBe(403);
    expect((await photosOf(token, jar())).items[0].favourite).toBeUndefined();
  });

  it('needs the unlock when a passcode is set', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token } = await created(j, [p.id], { extras: { favourites: true } });
    expect((await call(SHARE_API.guestFavourite(token, p.id), { method: 'PUT', body: {} })).status).toBe(401);
    expect(
      (
        await call(SHARE_API.guestFavourite(token, p.id), {
          method: 'PUT',
          body: {},
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
  });
});

describe('reports', () => {
  it('works with the link alone, needs Turnstile, alerts the safety team for CSAM only', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token, g } = await created(j, [p.id]);
    world.turnstile = {
      success: true,
      hostname: 'zephyrapp.midnightpoetry.studio',
      action: 'gallery_report',
    };
    expect((await call(SHARE_API.guestReport(token), { body: { reason: 'csam' } })).status).toBe(400);
    expect(
      (await call(SHARE_API.guestReport(token), { body: { reason: 'spam', turnstileToken: 't' } })).status,
    ).toBe(400);
    expect(
      (await call(SHARE_API.guestReport('A'.repeat(43)), { body: { reason: 'other', turnstileToken: 't' } }))
        .status,
    ).toBe(404);
    expect(
      (await call(SHARE_API.guestReport(token), { body: { reason: 'copyright', turnstileToken: 't' } }))
        .status,
    ).toBe(202);
    expect(world.emails).toHaveLength(0);
    expect(
      (
        await call(SHARE_API.guestReport(token), {
          body: { reason: 'csam', photoId: p.id, details: 'x', turnstileToken: 't' },
        })
      ).status,
    ).toBe(202);
    const alert = world.emails.find((e) => e.to === 'safety@zephyr.test');
    expect(alert?.text).toContain(g.id);
    expect(alert?.text).toContain(p.id);
    expect(alert?.text).not.toContain(token);
    expect(sdb.reports).toHaveLength(2);
    expect(sdb.audit.filter((a) => a.action === 'safety.report')).toHaveLength(2);
    // Every report is recorded, but Safety is emailed at most once an hour per gallery; the email names only
    // the photo the database validated (in this gallery), never the guest's.
    const other = crypto.randomUUID();
    for (let i = 0; i < 3; i++)
      await call(SHARE_API.guestReport(token), {
        body: { reason: 'csam', photoId: other, turnstileToken: 't' },
      });
    expect(sdb.reports).toHaveLength(5);
    expect(world.emails.filter((e) => e.to === 'safety@zephyr.test')).toHaveLength(1);
    vi.useFakeTimers({ now: Date.now() + 3601_000, toFake: ['Date'] });
    expect(
      (
        await call(SHARE_API.guestReport(token), {
          body: { reason: 'csam', photoId: other, turnstileToken: 't' },
        })
      ).status,
    ).toBe(202);
    vi.useRealTimers();
    const alerts = world.emails.filter((e) => e.to === 'safety@zephyr.test');
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).not.toContain(other);
    expect(alerts[1]?.text).toContain('4 CSAM reports');
    sdb.reports.splice(2);
    world.turnstile.action = 'gallery_unlock';
    expect(
      (await call(SHARE_API.guestReport(token), { body: { reason: 'other', turnstileToken: 't' } })).status,
    ).toBe(400);
  });
  it('the cron emails Safety about CSAM reports no alert covered, once the gallery’s hour allows', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token } = await created(j, [p.id]);
    world.turnstile = {
      success: true,
      hostname: 'zephyrapp.midnightpoetry.studio',
      action: 'gallery_report',
    };
    const csam = (ip?: string) =>
      call(SHARE_API.guestReport(token), { body: { reason: 'csam', turnstileToken: 't' }, ip });
    const safety = () => world.emails.filter((e) => e.to === 'safety@zephyr.test');
    // The request's own alert fails to send: the report stays unalerted (and the hour is claimed).
    world.resendStatus = 500;
    expect((await csam()).status).toBe(202);
    world.resendStatus = 200;
    // A second report inside the hour isn't emailed by the request.
    expect((await csam('198.51.100.4')).status).toBe(202);
    expect(safety()).toHaveLength(0);
    await runCleanup(env);
    expect(safety()).toHaveLength(0);
    vi.useFakeTimers({ now: Date.now() + 3601_000, toFake: ['Date'] });
    try {
      const counts = await runCleanup(env);
      expect(counts.safetyAlerts).toBe(1);
      expect(safety()).toHaveLength(1);
      expect(safety()[0]?.text).toContain('2 CSAM reports');
      expect(safety()[0]?.text).not.toContain(token);
      expect(sdb.reports.every((r) => r.alertedAt)).toBe(true);
      // Covered now: later runs send nothing.
      await runCleanup(env);
      expect(safety()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('the report limit is per customer network: rotating IPv6 /64s inside one /48 doesn’t reset it', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { token } = await created(j, [p.id]);
    world.turnstile = {
      success: true,
      hostname: 'zephyrapp.midnightpoetry.studio',
      action: 'gallery_report',
    };
    const report = (ip: string) =>
      call(SHARE_API.guestReport(token), { body: { reason: 'other', turnstileToken: 't' }, ip });
    for (let n = 0; n < 10; n++) expect((await report(`2001:db8:99:${n.toString(16)}::1`)).status).toBe(202);
    expect((await report('2001:db8:99:abcd::1')).status).toBe(429);
    expect((await report('2001:db8:9a::1')).status).toBe(202);
  });
});

// ---- owner preview ------------------------------------------------------------------------------------------
describe('owner preview', () => {
  it('shows the guest page without a passcode, events, favourites or downloads', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const { g } = await created(j, [p.id], {
      downloads: 'web',
      extras: { favourites: true, accessLog: true },
    });
    const info = await read(await call(SHARE_API.galleryPreview(g.id), { jar: j }));
    expect(info).toMatchObject({ state: 'open', name: 'Wedding', photoCount: 1 });
    const page = await read(await call(SHARE_API.galleryPreviewPhotos(g.id), { jar: j }));
    const item = page.items[0];
    expect(item.download).toBeUndefined();
    expect(item.favourite).toBeUndefined();
    expect(item.grid).toMatch(new RegExp(`^/api/v1/galleries/${g.id}/preview/m/`));
    const first = await call(item.grid, { jar: j });
    expect(first.status).toBe(200);
    // Never stored by the browser, so it can't outlive the session (and so no ETag to revalidate).
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(first.headers.get('ETag')).toBeNull();
    expect((await call(item.grid, { headers: { 'If-None-Match': '"x"' } })).status).toBe(401);
    expect((await call(item.grid, { jar: await signedIn(WEI) })).status).toBe(404);
    expect((await call(item.grid)).status).toBe(401);
    expect(g.views).toBe(0);
    expect(sdb.events.filter((e) => e.kind !== 'created')).toHaveLength(0);
  });
});

// ---- branding -----------------------------------------------------------------------------------------------
describe('branding', () => {
  it('settings need the plan; accents come from the fixed list', async () => {
    const w = await signedIn(WEI);
    expect(
      (await call(SHARE_API.branding, { jar: w, method: 'PUT', body: { studioName: 'W' } })).status,
    ).toBe(403);
    const j = await signedIn(MEI);
    expect(
      (await call(SHARE_API.branding, { jar: j, method: 'PUT', body: { accent: '#123456' } })).status,
    ).toBe(400);
    const ok = await read(
      await call(SHARE_API.branding, {
        jar: j,
        method: 'PUT',
        body: { studioName: 'Mei Studio', accent: '#2D5FD3' },
      }),
    );
    expect(ok.branding).toMatchObject({ studioName: 'Mei Studio', accent: '#2D5FD3', hasLogo: false });
    expect((await read(await call(SHARE_API.branding, { jar: j }))).branding.studioName).toBe('Mei Studio');
  });

  it("a watermark image a live gallery draws can't be deleted (409 asset_in_use); watermarkReady says so", async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    expect((await put(SHARE_API.brandingAsset('watermark'), PNG(), j, 'image/png')).status).toBe(200);
    expect((await read(await call(SHARE_API.branding, { jar: j }))).branding.watermarkReady).toBe(true);
    const { g } = await created(j, [p.id], { passcode: false, extras: { watermark: true } });
    expect((await read(await call(SHARE_API.gallery(g.id), { jar: j }))).gallery.watermarkReady).toBe(true);
    const res = await call(SHARE_API.brandingAsset('watermark'), { jar: j, method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await read(res)).toEqual({ ok: false, error: 'asset_in_use', galleries: 1 });
    expect(sdb.branding.get(MEI.id)?.wmKey).toBeTruthy();
    // Switching to a logo watermark with no logo would stop the gallery too: refused the same way.
    const sw = await call(SHARE_API.branding, {
      jar: j,
      method: 'PUT',
      body: { watermark: { kind: 'logo' } },
    });
    expect(sw.status).toBe(409);
    expect(await read(sw)).toEqual({ ok: false, error: 'asset_in_use', galleries: 1 });
    expect(sdb.branding.get(MEI.id)?.wmKind ?? 'text').toBe('text');
    // The logo isn't drawn by a text watermark: it can go.
    expect((await call(SHARE_API.brandingAsset('logo'), { jar: j, method: 'DELETE' })).status).toBe(200);
    // Once no live gallery uses it, the watermark image can go too.
    await call(SHARE_API.gallery(g.id), { jar: j, method: 'PATCH', body: { extras: { watermark: false } } });
    expect((await call(SHARE_API.brandingAsset('watermark'), { jar: j, method: 'DELETE' })).status).toBe(200);
    expect((await read(await call(SHARE_API.branding, { jar: j }))).branding.watermarkReady).toBe(false);
  });

  it('logo uploads are re-encoded to a small PNG, counted, served to the owner and to guests (branding on)', async () => {
    const j = await signedIn(MEI);
    expect((await put(SHARE_API.brandingAsset('logo'), PNG(), j, 'image/svg+xml')).status).toBe(415);
    expect(
      (await put(SHARE_API.brandingAsset('logo'), new TextEncoder().encode('<svg onload=x>'), j, 'image/png'))
        .status,
    ).toBe(415);
    expect(
      (
        await put(SHARE_API.brandingAsset('logo'), PNG(), j, 'image/png', {
          'Content-Length': String(3 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
    const up = await put(SHARE_API.brandingAsset('logo'), JPEG(), j, 'image/jpeg');
    expect(up.status).toBe(200);
    expect((await read(up)).branding.hasLogo).toBe(true);
    expect(images.pipelines[0]).toMatchObject({
      ops: [['transform', { width: 512, height: 512, fit: 'scale-down' }]],
      output: { format: 'image/png' },
    });
    const [key] = sharedKeys(`o/${MEI.id}/b/logo-`);
    expect(key).toBeDefined();
    expect(usageOk(MEI.id)).toBe(true);
    const mine = await call(SHARE_API.brandingAsset('logo'), { jar: j });
    expect(mine.status).toBe(200);
    expect(mine.headers.get('Content-Type')).toBe('image/png');
    expect(mine.headers.get('Cache-Control')).toBe('private, no-cache');
    expect((await call(SHARE_API.brandingAsset('logo'), { jar: await signedIn(WEI) })).status).toBe(404);
    const p = await photo(MEI.id);
    const { token } = await created(j, [p.id], { passcode: false, extras: { branding: true } });
    const info = await read(await get(SHARE_API.guest(token)));
    expect(info.brand.logoUrl).toMatch(new RegExp(`^/api/v1/g/${token}/brand/logo\\?e=\\d+&s=`));
    expect((await get(info.brand.logoUrl)).status).toBe(200);
    // Tamper with the signature (always a different character, so the test can't pass by luck).
    const tampered = info.brand.logoUrl.replace(
      /s=(.)/,
      (_m: string, ch: string) => `s=${ch === 'A' ? 'B' : 'A'}`,
    );
    expect((await get(tampered)).status).toBe(404);
    // Replacing it queues the old object; deleting releases the bytes.
    await put(SHARE_API.brandingAsset('logo'), PNG(), j, 'image/png');
    expect(sdb.queue.map((q) => q.key)).toContain(key);
    expect(
      (await read(await call(SHARE_API.brandingAsset('logo'), { jar: j, method: 'DELETE' }))).branding
        .hasLogo,
    ).toBe(false);
    expect(usageOk(MEI.id)).toBe(true);
    // Without the plan.
    expect((await put(SHARE_API.brandingAsset('logo'), PNG(), await signedIn(WEI), 'image/png')).status).toBe(
      403,
    );
    expect(sharedKeys(`o/${WEI.id}/`)).toHaveLength(0);
  });
});

// ---- jobs ---------------------------------------------------------------------------------------------------
describe('clean-up', () => {
  it('emails expiry reminders, drops renditions of ended galleries and drains the deletion queue', async () => {
    const j = await signedIn(MEI);
    const p = await photo(MEI.id);
    const a = await created(j, [p.id], { passcode: false, expiresOn: inDays(1) });
    const item = (await photosOf(a.token, jar())).items[0];
    await get(item.grid);
    const [key] = sharedKeys(`o/${MEI.id}/g/${a.g.id}/`);
    const counts = await runCleanup(env);
    expect(counts.expiryReminders).toBe(1);
    expect(world.emails.find((e) => /expires soon/.test(e.subject))?.to).toBe(MEI.email);
    a.g.expiresAt = Date.now() - 2 * 86400000;
    const again = await runCleanup(env);
    expect(again.galleryRenditionsPurged).toBe(1);
    expect(again.shareObjectsDeleted).toBeGreaterThanOrEqual(1);
    expect(shared.objects.has(key as string)).toBe(false);
    expect(sdb.queue).toHaveLength(0);
    expect(usageOk(MEI.id)).toBe(true);
    a.g.expiresAt = Date.now() - 31 * 86400000;
    await shared.put(`o/${MEI.id}/g/${a.g.id}/${p.id}/view-${'b'.repeat(32)}`, JPEG());
    const last = await runCleanup(env);
    expect(last.galleriesDeleted).toBe(1);
    expect(sharedKeys(`o/${MEI.id}/g/${a.g.id}/`)).toHaveLength(0);
  });

  it('the queue never deletes anything but share objects', async () => {
    await r2.put(`u/${MEI.id}/p/${crypto.randomUUID()}/original`, JPEG());
    const victim = [...r2.objects.keys()][0] as string;
    sdb.queue.push(
      { id: 1, bucket: 'photos', key: victim, prefix: false },
      { id: 2, bucket: 'photos', key: `u/${MEI.id}/`, prefix: true },
      { id: 3, bucket: 'shared', key: 'o/', prefix: true },
    );
    await drainShareDeletions(env);
    expect(r2.objects.has(victim)).toBe(true);
    expect(sdb.queue).toHaveLength(3);
  });

  it('account purge empties the shared bucket prefix', async () => {
    const j = await signedIn(MEI);
    await put(SHARE_API.brandingAsset('logo'), PNG(), j, 'image/png');
    await shared.put(`o/${WEI.id}/b/logo-${'c'.repeat(32)}`, PNG());
    profile(MEI.id).deletionDue = new Date(Date.now() - 1000).toISOString();
    await runCleanup(env);
    expect(sharedKeys(`o/${MEI.id}/`)).toHaveLength(0);
    expect(sharedKeys(`o/${WEI.id}/`)).toHaveLength(1);
  });
});
