import { LIBRARY_HEADER } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  call,
  initKeys,
  installFetch,
  type Jar,
  jar,
  read,
  resetWorld,
  sbToken,
  type User,
  world,
} from './helpers';

/** Phase 7: library context, role gates and the read-only gate (docs/phase-7.md). */
const MEI: User = { id: '20000000-0000-0000-0000-000000000001', email: 'mei@example.com', passkeys: 1 };
const JUN: User = {
  id: '20000000-0000-0000-0000-000000000002',
  email: 'jun@example.com',
  displayName: 'Jun Hao',
};
const AISHA: User = { id: '20000000-0000-0000-0000-000000000003', email: 'aisha@example.com' };
const OUTSIDER: User = { id: '20000000-0000-0000-0000-000000000004', email: 'x@example.com' };
const PHOTO = '30000000-0000-4000-8000-000000000001';
const GALLERY = '60000000-0000-4000-8000-000000000001';

async function signedIn(u: User): Promise<Jar> {
  const j = jar();
  j.cookies.set('__Host-zs-at', await sbToken({ sub: u.id, email: u.email }));
  return j;
}
const rpcCalls = (fn: string) =>
  world.calls
    .filter((c) => c.url.endsWith(`/rest/v1/rpc/${fn}`))
    .map((c) => c.body as Record<string, unknown>);
const inTeam = { [LIBRARY_HEADER]: MEI.id };

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  world.users.push(JUN, AISHA, OUTSIDER);
  world.teams = { [MEI.id]: { [JUN.id]: 'editor', [AISHA.id]: 'viewer' } };
  world.rpc.list_albums = () => [];
  world.rpc.create_album = (a) => ({ id: 'a1', name: a.p_name, count: 0, coverPhotoId: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('libraryContext', () => {
  it('uses the member’s own library without the header', async () => {
    const r = await call('/api/v1/albums', { jar: await signedIn(MEI) });
    expect(r.status).toBe(200);
    expect(rpcCalls('library_access')[0]).toEqual({ p_member: MEI.id, p_owner: MEI.id });
    expect(rpcCalls('list_albums')[0]?.p_owner).toBe(MEI.id);
    expect(r.headers.get('Vary')).toContain(LIBRARY_HEADER);
  });

  it('treats the member’s own id in the header as their own library', async () => {
    const r = await call('/api/v1/albums', {
      jar: await signedIn(MEI),
      headers: { [LIBRARY_HEADER]: MEI.id.toUpperCase() },
    });
    expect(r.status).toBe(200);
    expect(rpcCalls('list_albums')[0]?.p_owner).toBe(MEI.id);
  });

  it('opens the owner’s library for an Editor and writes into it', async () => {
    const j = await signedIn(JUN);
    const list = await call('/api/v1/albums', { jar: j, headers: inTeam });
    expect(list.status).toBe(200);
    expect(rpcCalls('list_albums')[0]?.p_owner).toBe(MEI.id);
    const made = await call('/api/v1/albums', { jar: j, headers: inTeam, body: { name: 'Wedding' } });
    expect(made.status).toBe(201);
    expect(rpcCalls('create_album')[0]?.p_owner).toBe(MEI.id);
  });

  it('accepts ?library= on GET (media URLs) but never on writes', async () => {
    const j = await signedIn(JUN);
    const list = await call(`/api/v1/albums?library=${MEI.id}`, { jar: j });
    expect(list.status).toBe(200);
    expect(rpcCalls('list_albums')[0]?.p_owner).toBe(MEI.id);
    const made = await call(`/api/v1/albums?library=${MEI.id}`, { jar: j, body: { name: 'Own' } });
    expect(made.status).toBe(201);
    expect(rpcCalls('create_album')[0]?.p_owner).toBe(JUN.id);
    const outsider = await call(`/api/v1/albums?library=${MEI.id}`, { jar: await signedIn(OUTSIDER) });
    expect(outsider.status).toBe(403);
    expect((await read(outsider)).error).toBe('library_unavailable');
  });

  it('lets a Viewer read but not write', async () => {
    const j = await signedIn(AISHA);
    expect((await call('/api/v1/albums', { jar: j, headers: inTeam })).status).toBe(200);
    const w = await call('/api/v1/albums', { jar: j, headers: inTeam, body: { name: 'Nope' } });
    expect(w.status).toBe(403);
    expect((await read(w)).error).toBe('role_forbidden');
    expect(rpcCalls('create_album')).toHaveLength(0);
  });

  it('refuses a library the member can’t open (unknown, removed or suspended)', async () => {
    const r = await call('/api/v1/albums', { jar: await signedIn(OUTSIDER), headers: inTeam });
    expect(r.status).toBe(403);
    expect((await read(r)).error).toBe('library_unavailable');
    expect(rpcCalls('list_albums')).toHaveLength(0);
  });

  it('refuses a malformed header before any lookup', async () => {
    for (const bad of ['not-a-uuid', `${MEI.id},${JUN.id}`, '../x']) {
      const r = await call('/api/v1/albums', {
        jar: await signedIn(JUN),
        headers: { [LIBRARY_HEADER]: bad },
      });
      expect(r.status).toBe(400);
    }
    expect(rpcCalls('library_access')).toHaveLength(0);
  });

  it('never trusts a database row that makes someone else the owner, or an unknown role', async () => {
    world.rpc.library_access = () => ({ role: 'owner', plan: 'studio', state: 'active' });
    const r = await call('/api/v1/albums', { jar: await signedIn(JUN), headers: inTeam });
    expect(r.status).toBe(403);
    world.rpc.library_access = () => ({ role: 'admin', plan: 'studio', state: 'active' });
    expect((await call('/api/v1/albums', { jar: await signedIn(JUN), headers: inTeam })).status).toBe(403);
  });

  it('answers session_changed for a team-library request started by someone else on this device', async () => {
    const r = await call('/api/v1/albums', {
      jar: await signedIn(JUN),
      headers: { ...inTeam, 'X-Zephyr-Expected-User': AISHA.id },
    });
    expect(r.status).toBe(409);
    expect((await read(r)).error).toBe('session_changed');
  });

  it('needs a session first', async () => {
    expect((await call('/api/v1/albums', { headers: inTeam })).status).toBe(401);
  });

  it('shows the open library’s storage in usage', async () => {
    world.rpc.get_usage = () => ({ usedBytes: 1, limitBytes: 2, photoCount: 1 });
    const r = await call('/api/v1/me/usage', { jar: await signedIn(AISHA), headers: inTeam });
    expect(r.status).toBe(200);
    expect(rpcCalls('get_usage')[0]?.p_owner).toBe(MEI.id);
  });
});

describe('role gates in every library route group', () => {
  const upload = { files: [{ name: 'a.jpg', size: 10, sha256: 'a'.repeat(64) }] };
  const writes: { name: string; path: string; method: string; body?: unknown; who: User; fn: string }[] = [
    {
      name: 'photo rename',
      path: `/api/v1/photos/${PHOTO}`,
      method: 'PATCH',
      body: { filename: 'x.jpg' },
      who: AISHA,
      fn: 'patch_photo',
    },
    {
      name: 'bulk trash (viewer)',
      path: '/api/v1/photos/bulk',
      method: 'POST',
      body: { ids: [PHOTO], action: 'trash' },
      who: AISHA,
      fn: 'bulk_photos',
    },
    {
      name: 'bulk favourite (viewer)',
      path: '/api/v1/photos/bulk',
      method: 'POST',
      body: { ids: [PHOTO], action: 'favourite' },
      who: AISHA,
      fn: 'bulk_photos',
    },
    {
      name: 'delete forever (editor)',
      path: '/api/v1/photos/bulk',
      method: 'POST',
      body: { ids: [PHOTO], action: 'delete_forever' },
      who: JUN,
      fn: 'bulk_photos',
    },
    {
      name: 'edit save',
      path: `/api/v1/photos/${PHOTO}/edit`,
      method: 'PUT',
      body: { recipe: {}, baseVersion: 0 },
      who: AISHA,
      fn: 'save_edit',
    },
    {
      name: 'edit revert',
      path: `/api/v1/photos/${PHOTO}/edit`,
      method: 'DELETE',
      who: AISHA,
      fn: 'delete_edit',
    },
    {
      name: 'bulk edits',
      path: '/api/v1/photos/edits/bulk',
      method: 'POST',
      body: { ids: [PHOTO], recipe: null, sections: [] },
      who: AISHA,
      fn: 'bulk_edit_state',
    },
    {
      name: 'upload',
      path: '/api/v1/uploads',
      method: 'POST',
      body: upload,
      who: AISHA,
      fn: 'create_uploads',
    },
    {
      name: 'album create',
      path: '/api/v1/albums',
      method: 'POST',
      body: { name: 'A' },
      who: AISHA,
      fn: 'create_album',
    },
    {
      name: 'recipe create',
      path: '/api/v1/recipes',
      method: 'POST',
      body: { name: 'R', recipe: {} },
      who: AISHA,
      fn: 'create_recipe',
    },
    {
      name: 'empty Trash (editor)',
      path: '/api/v1/trash/empty',
      method: 'POST',
      body: {},
      who: JUN,
      fn: 'empty_trash',
    },
    {
      name: 'galleries (viewer reads)',
      path: '/api/v1/galleries',
      method: 'GET',
      who: AISHA,
      fn: 'list_galleries',
    },
    {
      name: 'gallery create',
      path: '/api/v1/galleries',
      method: 'POST',
      body: { name: 'G' },
      who: AISHA,
      fn: 'create_gallery',
    },
    {
      name: 'branding (viewer reads)',
      path: '/api/v1/me/branding',
      method: 'GET',
      who: AISHA,
      fn: 'get_branding',
    },
    {
      name: 'AI job',
      path: '/api/v1/ai/jobs',
      method: 'POST',
      body: { kind: 'bg_removal', photoIds: [PHOTO] },
      who: AISHA,
      fn: 'ai_bg_job_create',
    },
    {
      name: 'AI queue (viewer reads)',
      path: '/api/v1/ai/jobs',
      method: 'GET',
      who: AISHA,
      fn: 'ai_jobs_list',
    },
    {
      name: 'AI settings (editor)',
      path: '/api/v1/ai/settings',
      method: 'PATCH',
      body: { sceneTags: false },
      who: JUN,
      fn: 'ai_member_settings_update',
    },
    {
      name: 'delete faces (editor)',
      path: '/api/v1/ai/faces',
      method: 'DELETE',
      who: JUN,
      fn: 'ai_faces_delete_all',
    },
    {
      name: 'device claim',
      path: `/api/v1/ai/jobs/${PHOTO}/claim`,
      method: 'POST',
      body: { device: 'd' },
      who: AISHA,
      fn: 'ai_device_claim',
    },
    {
      name: 'name a person',
      path: `/api/v1/ai/people/${PHOTO}`,
      method: 'PATCH',
      body: { name: 'A' },
      who: AISHA,
      fn: 'ai_person_patch',
    },
  ];
  for (const w of writes) {
    it(`refuses ${w.name} with role_forbidden`, async () => {
      const r = await call(w.path, {
        jar: await signedIn(w.who),
        headers: inTeam,
        method: w.method,
        body: w.body,
      });
      expect(r.status).toBe(403);
      expect((await read(r)).error).toBe('role_forbidden');
      expect(rpcCalls(w.fn)).toHaveLength(0);
    });
  }

  it('lets an Editor move photos to Trash and a Viewer download', async () => {
    world.rpc.bulk_photos = () => ({ affected: 1 });
    const t = await call('/api/v1/photos/bulk', {
      jar: await signedIn(JUN),
      headers: inTeam,
      body: { ids: [PHOTO], action: 'trash' },
    });
    expect(t.status).toBe(200);
    expect(rpcCalls('bulk_photos')[0]?.p_owner).toBe(MEI.id);
    world.rpc.photo_file = () => null;
    const d = await call(`/api/v1/photos/${PHOTO}/original`, { jar: await signedIn(AISHA), headers: inTeam });
    expect(d.status).toBe(404); // reached the lookup, scoped to the owner
    expect(rpcCalls('photo_file')[0]?.p_owner).toBe(MEI.id);
  });

  it('lets the owner empty Trash', async () => {
    world.rpc.empty_trash = () => ({ deleted: 0, purge: [] });
    const r = await call('/api/v1/trash/empty', { jar: await signedIn(MEI), body: {} });
    expect(r.status).toBe(200);
  });
});

describe('read-only libraries', () => {
  beforeEach(() => {
    world.libraryState = 'read_only';
  });
  const blocked: { name: string; path: string; method: string; body?: unknown; fn: string }[] = [
    {
      name: 'new uploads',
      path: '/api/v1/uploads',
      method: 'POST',
      body: { files: [{ name: 'a.jpg', size: 1, sha256: 'a'.repeat(64) }] },
      fn: 'create_uploads',
    },
    {
      name: 'edit saves',
      path: `/api/v1/photos/${PHOTO}/edit`,
      method: 'PUT',
      body: { recipe: {}, baseVersion: 0 },
      fn: 'save_edit',
    },
    {
      name: 'new galleries',
      path: '/api/v1/galleries',
      method: 'POST',
      body: { name: 'G' },
      fn: 'create_gallery',
    },
    {
      name: 'gallery extensions',
      path: `/api/v1/galleries/${GALLERY}`,
      method: 'PATCH',
      body: { expiresOn: '2027-01-01' },
      fn: 'patch_gallery',
    },
    {
      name: 'AI jobs',
      path: '/api/v1/ai/jobs',
      method: 'POST',
      body: { kind: 'bg_removal', photoIds: [PHOTO] },
      fn: 'ai_bg_job_create',
    },
  ];
  for (const b of blocked) {
    it(`refuses ${b.name}`, async () => {
      const r = await call(b.path, { jar: await signedIn(MEI), method: b.method, body: b.body });
      expect(r.status).toBe(403);
      expect((await read(r)).error).toBe('library_read_only');
      expect(rpcCalls(b.fn)).toHaveLength(0);
    });
  }

  it('still allows Trash, emptying it and renaming a gallery', async () => {
    world.rpc.bulk_photos = () => ({ affected: 1 });
    world.rpc.empty_trash = () => ({ deleted: 1, purge: [] });
    world.rpc.patch_gallery = () => ({ gallery: { id: GALLERY } });
    const j = await signedIn(MEI);
    expect(
      (await call('/api/v1/photos/bulk', { jar: j, body: { ids: [PHOTO], action: 'trash' } })).status,
    ).toBe(200);
    expect((await call('/api/v1/trash/empty', { jar: j, body: {} })).status).toBe(200);
    expect(
      (await call(`/api/v1/galleries/${GALLERY}`, { jar: j, method: 'PATCH', body: { name: 'Renamed' } }))
        .status,
    ).toBe(200);
  });
});

describe('library routes take the owner only from the library context', () => {
  // Every route file's source, keyed by file name (Vite reads them at test time).
  const sources = Object.fromEntries(
    Object.entries(
      import.meta.glob<string>('../src/routes/*.ts', { query: '?raw', import: 'default', eager: true }),
    ).map(([path, text]) => [path.slice(path.lastIndexOf('/') + 1), text]),
  );
  const LIBRARY_ROUTE_FILES = [
    'photos.ts',
    'edits.ts',
    'uploads.ts',
    'albums.ts',
    'recipes.ts',
    'trash.ts',
    'galleries.ts',
    'branding.ts',
    'ai.ts',
  ];

  it('covers every route file that passes p_owner (new files must be classified)', () => {
    const personal = new Set(['me.ts', 'team.ts', 'billing.ts']);
    const withOwner = Object.keys(sources).filter((f) => /p_owner/.test(sources[f] ?? ''));
    expect(withOwner.length).toBeGreaterThan(5);
    for (const f of withOwner) expect(LIBRARY_ROUTE_FILES.includes(f) || personal.has(f), f).toBe(true);
  });

  it.each(LIBRARY_ROUTE_FILES)('%s never passes the session user as an owner', (f) => {
    const src = sources[f] ?? '';
    expect(src.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/get\('session'\)\.userId/);
    expect(src).not.toMatch(/p_owner:\s*(actorOf\(|s\.userId|session\.userId)/);
    expect(src).not.toMatch(/const ownerOf\s*=/);
    expect(src).toMatch(/libraryContext|ownerOf/);
  });
});
