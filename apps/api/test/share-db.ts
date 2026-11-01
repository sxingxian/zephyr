/**
 * In-memory stand-in for the sharing functions (supabase/migrations/…_sharing.sql), close enough for
 * routing tests: owner filtering, plan limits and downgrades, passcode attempts, renditions and storage,
 * favourites, the deletion queue and safety holds. The real rules are tested in SQL
 * (supabase/tests/50_sharing_test.sql).
 */

import { world } from './helpers';
import { db, PLANS, profile } from './library-db';

type Plan = 'free' | 'pro' | 'studio';
type Args = Record<string, unknown>;
const RULES: Record<
  Plan,
  { galleries: number | null; maxLinkDays: number; fullRes: boolean; studio: boolean; storage: number }
> = {
  free: { galleries: 3, maxLinkDays: 7, fullRes: false, studio: false, storage: PLANS.free.storage },
  pro: { galleries: null, maxLinkDays: 365, fullRes: true, studio: false, storage: PLANS.pro.storage },
  studio: { galleries: null, maxLinkDays: 365, fullRes: true, studio: true, storage: PLANS.pro.storage },
};

export interface Gallery {
  id: string;
  owner: string;
  name: string;
  message: string | null;
  tokenHash: string;
  linkHint: string;
  linkCt: string;
  linkIv: string;
  passcodeHmac: string | null;
  generation: number;
  downloads: 'none' | 'web' | 'full';
  x: { favourites: boolean; watermark: boolean; branding: boolean; accessLog: boolean };
  expiresAt: number;
  revokedAt: number | null;
  pausedUntil: number | null;
  views: number;
  downloadCount: number;
  favouritesNotifiedAt: number | null;
  pausedNotifiedAt?: number | null;
  csamAlertedAt?: number | null;
  createdAt: number;
  photos: string[];
}
interface Rendition {
  gallery: string;
  photo: string;
  size: string;
  owner: string;
  key: string;
  bytes: number;
  ev: number;
  wv: number;
}
interface Render {
  gallery: string;
  photo: string;
  owner: string;
  ev: number;
  key: string;
  bytes: number;
}
interface Branding {
  studioName: string | null;
  accent: string | null;
  logoKey: string | null;
  logoBytes: number;
  wmKind: 'text' | 'logo';
  wmText: string | null;
  wmPosition: string;
  wmOpacity: number;
  wmKey: string | null;
  wmBytes: number;
  wmVersion: number;
}

export const sdb = {
  plans: new Map<string, Plan>(),
  galleries: new Map<string, Gallery>(),
  renditions: [] as Rendition[],
  renders: [] as Render[],
  guests: [] as {
    id: string;
    gallery: string;
    hash: string;
    name: string | null;
    note: string | null;
    sentAt: string | null;
    net?: string;
    createdAt?: number;
    favs: Set<string>;
  }[],
  attempts: [] as { id: number; gallery: string; net: string; at: number }[],
  events: [] as {
    id: number;
    gallery: string;
    kind: string;
    place: string | null;
    device: string | null;
    count: number;
    at: number;
  }[],
  branding: new Map<string, Branding>(),
  reports: [] as {
    id: string;
    gallery: string;
    photo: string | null;
    reason: string;
    details: string | null;
    net: string;
    at?: number;
    owner?: string;
    alertedAt?: number | null;
  }[],
  queue: [] as { id: number; bucket: 'shared' | 'photos'; key: string; prefix: boolean }[],
  held: new Set<string>(),
  suspended: new Set<string>(),
  audit: [] as { action: string; target: string }[],
  seq: 0,
};
export function resetShareDb() {
  sdb.plans.clear();
  sdb.galleries.clear();
  sdb.renditions = [];
  sdb.renders = [];
  sdb.guests = [];
  sdb.attempts = [];
  sdb.events = [];
  sdb.branding.clear();
  sdb.reports = [];
  sdb.queue = [];
  sdb.held.clear();
  sdb.suspended.clear();
  blocked.clear();
  sdb.audit = [];
  sdb.seq = 0;
}
const plan = (owner: string): Plan => sdb.plans.get(owner) ?? (profile(owner).plan as Plan);
const rules = (owner: string) => RULES[plan(owner)];
const next = () => ++sdb.seq;
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const shareable = (id: string) => db.photos.get(id)?.status === 'ready' && !sdb.held.has(id);
const serving = (g: Gallery) =>
  g.revokedAt === null &&
  g.expiresAt > Date.now() &&
  !sdb.suspended.has(g.owner) &&
  !profile(g.owner).deletionDue;
const status = (g: Gallery) =>
  g.revokedAt !== null
    ? 'revoked'
    : g.expiresAt <= Date.now()
      ? 'expired'
      : g.pausedUntil && g.pausedUntil > Date.now()
        ? 'paused'
        : 'live';
const effective = (g: Gallery) => {
  const r = rules(g.owner);
  return {
    downloads: g.downloads === 'full' && !r.fullRes ? 'web' : g.downloads,
    favourites: g.x.favourites && r.studio,
    watermark: g.x.watermark && r.studio,
    branding: g.x.branding && r.studio,
    accessLog: g.x.accessLog && r.studio,
  };
};
const editVersion = (photo: string) => {
  const e = db.edits.get(photo);
  return e && Object.keys(e.recipe).length > 1 ? e.version : null;
};
/** Mirrors _shared_size: the edited output's size for edited photos (the fake's originals are 4000 × 3000). */
export const sharedSize = (photo: string): { width: number; height: number } => {
  const W = 4000;
  const H = 3000;
  const e = db.edits.get(photo);
  if (!e || editVersion(photo) === null) return { width: W, height: H };
  const crop = (e.recipe.crop ?? {}) as { quarterTurns?: number; rect?: { w?: number; h?: number } };
  const clamp = (n: unknown) => (typeof n === 'number' ? Math.min(Math.max(n, 0.0001), 1) : 1);
  const turned = Math.abs(Math.floor(crop.quarterTurns ?? 0)) % 2 === 1;
  const w = Math.max(1, Math.round((turned ? H : W) * clamp(crop.rect?.w)));
  const h = Math.max(1, Math.round((turned ? W : H) * clamp(crop.rect?.h)));
  if (e.previewVersion === e.version && e.previewWidth && e.previewHeight) {
    const long = Math.max(w, h);
    return e.previewWidth >= e.previewHeight
      ? { width: long, height: Math.max(1, Math.round((long * e.previewHeight) / e.previewWidth)) }
      : { width: Math.max(1, Math.round((long * e.previewWidth) / e.previewHeight)), height: long };
  }
  return { width: w, height: h };
};
const isRaw = (photo: string) => ['cr2', 'nef', 'arw'].includes(db.photos.get(photo)?.fileType ?? '');
const fullState = (g: Gallery, photo: string): 'n/a' | 'pending' | 'ready' => {
  if (effective(g).downloads !== 'full') return 'n/a';
  if (editVersion(photo) === null && !isRaw(photo)) return 'ready';
  return sdb.renders.some(
    (r) => r.gallery === g.id && r.photo === photo && r.ev === (editVersion(photo) ?? 0),
  )
    ? 'ready'
    : 'pending';
};
const visiblePhotos = (g: Gallery) => g.photos.filter(shareable);

// Rows that count toward storage, kept in step like the SQL triggers (and queued for deletion when they go).
function dropRenditions(pred: (r: Rendition) => boolean) {
  for (const r of sdb.renditions.filter(pred)) {
    profile(r.owner).storage -= r.bytes;
    sdb.queue.push({ id: next(), bucket: 'shared', key: r.key, prefix: false });
  }
  sdb.renditions = sdb.renditions.filter((r) => !pred(r));
}
function dropRenders(pred: (r: Render) => boolean) {
  for (const r of sdb.renders.filter(pred)) {
    profile(r.owner).storage -= r.bytes;
    sdb.queue.push({ id: next(), bucket: 'photos', key: r.key, prefix: false });
  }
  sdb.renders = sdb.renders.filter((r) => !pred(r));
}
/** The usage invariant with share bytes. */
export function shareBytes(owner: string) {
  const b = sdb.branding.get(owner);
  return (
    sdb.renditions.filter((r) => r.owner === owner).reduce((n, r) => n + r.bytes, 0) +
    sdb.renders.filter((r) => r.owner === owner).reduce((n, r) => n + r.bytes, 0) +
    (b ? b.logoBytes + b.wmBytes : 0)
  );
}

const summary = (g: Gallery) => ({
  id: g.id,
  name: g.name,
  status: status(g),
  photoCount: visiblePhotos(g).length,
  coverPhotoId: visiblePhotos(g)[0] ?? null,
  passcode: g.passcodeHmac !== null,
  downloads: g.downloads,
  expiresAt: iso(g.expiresAt),
  pausedUntil: g.pausedUntil && g.pausedUntil > Date.now() ? iso(g.pausedUntil) : null,
  views: g.views,
  favourites: sdb.guests.filter((x) => x.gallery === g.id).reduce((n, x) => n + x.favs.size, 0),
  createdAt: iso(g.createdAt),
});
const pending = (g: Gallery) =>
  effective(g).downloads === 'full' ? visiblePhotos(g).filter((p) => fullState(g, p) === 'pending') : [];
const detail = (g: Gallery) => ({
  ...summary(g),
  message: g.message,
  extras: { ...g.x },
  linkHint: g.linkHint,
  pendingRenders: pending(g).length,
  watermarkReady: wmReady(sdb.branding.get(g.owner)),
  storageFull: previewsBlocked(g.owner),
  revokedAt: iso(g.revokedAt),
});
/** Mirrors _watermark_ready: text needs its image, logo needs the logo. */
function wmReady(b: Branding | undefined): boolean {
  return !!b && (b.wmKind === 'logo' ? !!b.logoKey : !!b.wmKey);
}
/** Mirrors _share_overflow: 10% of the plan's storage, at most 5 GB. */
const overflow = (lim: number) => Math.min(Math.floor(lim / 10), 5 * 1073741824);
export const blocked = new Set<string>();
function previewsBlocked(owner: string): boolean {
  const prof = profile(owner);
  const lim = rules(owner).storage;
  return blocked.has(owner) && prof.storage + prof.reserved >= lim + overflow(lim);
}
const brandingJson = (b: Branding | undefined) => ({
  studioName: b?.studioName ?? null,
  accent: b?.accent ?? null,
  hasLogo: Boolean(b?.logoKey),
  watermark: {
    kind: b?.wmKind ?? 'text',
    text: b?.wmText ?? null,
    position: b?.wmPosition ?? 'bottom-right',
    opacity: b?.wmOpacity ?? 70,
    hasImage: Boolean(b?.wmKey),
  },
  watermarkReady: wmReady(b),
  updatedAt: b ? new Date().toISOString() : null,
});
const brand = (owner: string): Branding => {
  let b = sdb.branding.get(owner);
  if (!b) {
    b = {
      studioName: null,
      accent: null,
      logoKey: null,
      logoBytes: 0,
      wmKind: 'text',
      wmText: null,
      wmPosition: 'bottom-right',
      wmOpacity: 70,
      wmKey: null,
      wmBytes: 0,
      wmVersion: 1,
    };
    sdb.branding.set(owner, b);
  }
  return b;
};
const expiry = (owner: string, on: string) => {
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const day = Date.parse(on);
  if (Number.isNaN(day) || day < today || day > today + Math.min(rules(owner).maxLinkDays, 365) * 86400000)
    return null;
  return day + 86400000;
};
const liveCount = (owner: string) =>
  [...sdb.galleries.values()].filter(
    (g) => g.owner === owner && g.revokedAt === null && g.expiresAt > Date.now(),
  ).length;
const extrasOk = (owner: string, downloads: unknown, x: Record<string, unknown> = {}) =>
  !(
    (downloads === 'full' && !rules(owner).fullRes) ||
    (Object.values(x).some(Boolean) && !rules(owner).studio)
  );
const log = (
  g: Gallery,
  kind: string,
  place: string | null = null,
  device: string | null = null,
  count = 1,
) => {
  if (kind === 'opened') g.views += 1;
  if (kind === 'downloaded') g.downloadCount += count;
  if (effective(g).accessLog)
    sdb.events.push({ id: next(), gallery: g.id, kind, place, device, count, at: Date.now() });
};
const ownGallery = (a: Args) => {
  const g = sdb.galleries.get(String(a.p_id ?? a.p_gallery));
  return g && g.owner === String(a.p_owner) ? g : null;
};
const byToken = (h: unknown) => [...sdb.galleries.values()].find((g) => g.tokenHash === h) ?? null;
const keyOk = (key: unknown, pfx: string) =>
  typeof key === 'string' && key.startsWith(pfx) && /^[0-9a-f]{32}$/.test(key.slice(pfx.length));

function guestInfo(g: Gallery, net: unknown) {
  const e = effective(g);
  const b = sdb.branding.get(g.owner);
  const display = world.users.find((u) => u.id === g.owner)?.displayName ?? null;
  return {
    id: g.id,
    ownerId: g.owner,
    generation: g.generation,
    state: !serving(g)
      ? 'ended'
      : g.passcodeHmac === null
        ? 'open'
        : g.pausedUntil && g.pausedUntil > Date.now()
          ? 'paused'
          : 'locked',
    name: serving(g) ? g.name : '',
    message: serving(g) ? g.message : null,
    photoCount: visiblePhotos(g).length,
    expiresAt: iso(g.expiresAt),
    downloads: e.downloads,
    favourites: e.favourites,
    brand: !serving(g)
      ? { studioName: '', accent: null, hasLogo: false }
      : e.branding && b
        ? { studioName: b.studioName ?? display ?? 'Zephyr', accent: b.accent, hasLogo: Boolean(b.logoKey) }
        : { studioName: display ?? 'Zephyr', accent: null, hasLogo: false },
    turnstile:
      net !== null &&
      sdb.attempts.filter((x) => x.gallery === g.id && x.net === net && x.at > Date.now() - 900000).length >=
        2,
    pausedUntil: g.pausedUntil && g.pausedUntil > Date.now() ? iso(g.pausedUntil) : null,
  };
}

function media(g: Gallery | undefined, photo: string, size: string, download: boolean) {
  if (!g || !serving(g) || !g.photos.includes(photo) || !shareable(photo)) return null;
  const p = db.photos.get(photo);
  if (!p) return null;
  const e = effective(g);
  if ((download && (size === 'grid' || e.downloads === 'none')) || (size === 'full' && !download))
    return { unavailable: 'not_allowed' };
  const edit = db.edits.get(photo);
  const ev0 = editVersion(photo);
  let ev = 0;
  let src: string | null = null;
  const pfx = `u/${p.owner}/p/${p.id}/`;
  if (size === 'full') {
    if (e.downloads !== 'full') return { unavailable: 'not_allowed' };
    if (ev0 === null && !isRaw(photo)) src = `${pfx}original`;
    else {
      ev = ev0 ?? 0;
      src = sdb.renders.find((r) => r.gallery === g.id && r.photo === photo && r.ev === ev)?.key ?? null;
      if (!src) return { unavailable: 'pending' };
    }
  } else if (ev0 !== null) {
    // Edited: only the current edited preview, never the original (privacy first).
    if (edit?.previewVersion !== edit?.version || !edit?.previewKey) return { unavailable: 'pending' };
    ev = ev0;
    src = edit.previewKey;
  } else if (p.preview > 0) src = `${pfx}preview`;
  else if (!isRaw(photo)) src = `${pfx}original`;
  else return { unavailable: 'pending' };
  let wm: Record<string, unknown> | null = null;
  let wv = 0;
  const b = sdb.branding.get(g.owner);
  const wmKey = b ? (b.wmKind === 'logo' ? b.logoKey : b.wmKey) : null;
  if (e.watermark) {
    if (!b || !wmKey) return { unavailable: 'pending' };
    wv = b.wmVersion;
    wm = { key: wmKey, version: b.wmVersion, position: b.wmPosition, opacity: b.wmOpacity };
  }
  const r = sdb.renditions.find(
    (x) => x.gallery === g.id && x.photo === photo && x.size === size && x.ev === ev && x.wv === wv,
  );
  if (!r && size !== 'full') {
    const prof = profile(g.owner);
    const lim = rules(g.owner).storage;
    if (prof.storage + prof.reserved >= lim + overflow(lim))
      return { unavailable: 'pending', storageFull: true, ownerId: g.owner };
  }
  return {
    ownerId: g.owner,
    galleryName: g.name,
    position: g.photos.indexOf(photo),
    ...sharedSize(photo),
    rendition: r ? { key: r.key } : null,
    source: { key: src, editVersion: ev },
    watermark: wm,
    wmVersion: wv,
  };
}

export function shareRpc(): Record<string, (a: Args) => unknown> {
  return {
    // ---- members ----
    create_gallery: (a) => {
      const owner = String(a.p_owner);
      if (sdb.suspended.has(owner)) return { error: 'suspended' };
      const x = (a.p_extras ?? {}) as Record<string, unknown>;
      if (!extrasOk(owner, a.p_downloads, x)) return { error: 'plan' };
      const exp = expiry(owner, String(a.p_expires_on));
      if (exp === null) return { error: 'expiry' };
      const lim = rules(owner).galleries;
      if (lim !== null && liveCount(owner) >= lim) return { error: 'limit' };
      const photos = [...new Set(a.p_photo_ids as string[])].filter(
        (id) => db.photos.get(id)?.owner === owner && shareable(id),
      );
      if (!photos.length) return { error: 'no_photos' };
      const g: Gallery = {
        id: String(a.p_id),
        owner,
        name: String(a.p_name),
        message: (a.p_message as string | null) || null,
        tokenHash: String(a.p_token_hash),
        linkHint: String(a.p_link_hint),
        linkCt: String(a.p_link_ciphertext),
        linkIv: String(a.p_link_iv),
        passcodeHmac: (a.p_passcode_hmac as string | null) ?? null,
        generation: 1,
        downloads: a.p_downloads as Gallery['downloads'],
        x: {
          favourites: !!x.favourites,
          watermark: !!x.watermark,
          branding: !!x.branding,
          accessLog: !!x.accessLog,
        },
        expiresAt: exp,
        revokedAt: null,
        pausedUntil: null,
        views: 0,
        downloadCount: 0,
        favouritesNotifiedAt: null,
        createdAt: Date.now(),
        photos,
      };
      sdb.galleries.set(g.id, g);
      log(g, 'created');
      return { gallery: detail(g) };
    },
    list_galleries: (a) =>
      [...sdb.galleries.values()].filter((g) => g.owner === String(a.p_owner)).map(summary),
    get_gallery: (a) => {
      const g = ownGallery(a);
      return g ? detail(g) : null;
    },
    gallery_link: (a) => {
      const g = ownGallery(a);
      if (!g || g.revokedAt !== null) return null;
      const hex = (pg: string) => pg.replace(/^\\x/, '');
      return { ciphertext: hex(g.linkCt), iv: hex(g.linkIv) };
    },
    patch_gallery: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      if (g.revokedAt !== null) return { error: 'ended' };
      if (sdb.suspended.has(g.owner)) return { error: 'suspended' };
      const p = a.p_patch as Record<string, unknown>;
      const x = (p.extras ?? {}) as Record<string, unknown>;
      if (!extrasOk(g.owner, p.downloads, x)) return { error: 'plan' };
      if (p.expiresOn !== undefined) {
        const exp = expiry(g.owner, String(p.expiresOn));
        if (exp === null) return { error: 'expiry' };
        const lim = rules(g.owner).galleries;
        if (g.expiresAt <= Date.now() && lim !== null && liveCount(g.owner) >= lim) return { error: 'limit' };
        g.expiresAt = exp;
      }
      if (p.name !== undefined) g.name = String(p.name);
      if (p.message !== undefined) g.message = (p.message as string | null) || null;
      if (p.downloads !== undefined) g.downloads = p.downloads as Gallery['downloads'];
      Object.assign(g.x, x);
      if (p.unpause) {
        g.pausedUntil = null;
        sdb.attempts = sdb.attempts.filter((t) => t.gallery !== g.id);
      }
      if (g.downloads !== 'full') {
        dropRenders((r) => r.gallery === g.id);
        dropRenditions((r) => r.gallery === g.id && r.size === 'full');
      }
      return { gallery: detail(g) };
    },
    revoke_gallery: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      g.revokedAt ??= Date.now();
      g.pausedUntil = null;
      dropRenditions((r) => r.gallery === g.id);
      dropRenders((r) => r.gallery === g.id);
      log(g, 'revoked');
      return true;
    },
    gallery_passcode_state: (a) => {
      const g = ownGallery(a);
      return g ? { generation: g.generation, ended: ['revoked', 'expired'].includes(status(g)) } : null;
    },
    set_gallery_passcode: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      if (g.revokedAt !== null) return 'ended';
      if (Number(a.p_generation) !== g.generation + 1) return 'conflict';
      g.generation += 1;
      g.passcodeHmac = (a.p_hmac as string | null) ?? null;
      g.pausedUntil = null;
      sdb.attempts = sdb.attempts.filter((t) => t.gallery !== g.id);
      log(g, 'passcode_changed');
      return 'ok';
    },
    list_gallery_photos: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      const from = Number(a.p_cursor ?? 0);
      const lim = Number(a.p_limit ?? 100);
      const rows = g.photos
        .map((id, position) => ({ id, position }))
        .filter((r) => shareable(r.id) && r.position >= from);
      const page = rows.slice(0, lim);
      return {
        items: page.map((r) => ({
          photoId: r.id,
          position: r.position,
          favourites: sdb.guests.filter((x) => x.gallery === g.id && x.favs.has(r.id)).length,
          full: fullState(g, r.id),
        })),
        nextCursor: rows.length > lim ? String((page.at(-1)?.position ?? 0) + 1) : null,
      };
    },
    update_gallery_photos: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      if (g.revokedAt !== null) return { error: 'ended' };
      const remove = new Set((a.p_remove as string[] | null) ?? []);
      g.photos = g.photos.filter((p) => !remove.has(p));
      dropRenditions((r) => r.gallery === g.id && remove.has(r.photo));
      dropRenders((r) => r.gallery === g.id && remove.has(r.photo));
      for (const x of sdb.guests.filter((x) => x.gallery === g.id)) for (const p of remove) x.favs.delete(p);
      for (const p of (a.p_add as string[] | null) ?? []) {
        if (!g.photos.includes(p) && db.photos.get(p)?.owner === g.owner && shareable(p)) g.photos.push(p);
      }
      if (g.photos.length > 2000) return { error: 'too_many' };
      return { count: g.photos.length };
    },
    gallery_favourites: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      return sdb.guests
        .filter((x) => x.gallery === g.id && x.favs.size)
        .map((x) => ({ guestId: x.id, name: x.name, note: x.note, sentAt: x.sentAt, photoIds: [...x.favs] }));
    },
    gallery_activity: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      const before = a.p_before === null ? Number.POSITIVE_INFINITY : Number(a.p_before);
      const lim = Number(a.p_limit ?? 50);
      const evs = sdb.events.filter((e) => e.gallery === g.id && e.id < before).sort((x, y) => y.id - x.id);
      const page = evs.slice(0, lim);
      return {
        stats: {
          views: g.views,
          downloads: g.downloadCount,
          favourites: sdb.guests.filter((x) => x.gallery === g.id).reduce((n, x) => n + x.favs.size, 0),
          wrongPasscodesWeek: sdb.events.filter((e) => e.gallery === g.id && e.kind === 'wrong_passcode')
            .length,
        },
        events: page.map((e) => ({
          kind: e.kind,
          at: iso(e.at),
          place: e.place,
          device: e.device,
          count: e.count,
        })),
        nextCursor: evs.length > lim ? String(page.at(-1)?.id) : null,
      };
    },
    gallery_render_queue: (a) => {
      const g = ownGallery(a);
      if (!g) return null;
      return serving(g) ? pending(g).map((p) => ({ photoId: p, editVersion: editVersion(p) ?? 0 })) : [];
    },
    gallery_render_check: (a) => {
      const g = ownGallery(a);
      const photo = String(a.p_photo);
      if (!g?.photos.includes(photo) || !shareable(photo)) return null;
      if (!serving(g) || effective(g).downloads !== 'full' || (editVersion(photo) === null && !isRaw(photo)))
        return { status: 'not_needed' };
      const want = editVersion(photo) ?? 0;
      if (Number(a.p_version) !== want) return { status: 'stale' };
      if (sdb.renders.some((r) => r.gallery === g.id && r.photo === photo && r.ev === want))
        return { status: 'exists' };
      return { status: 'current' };
    },
    record_gallery_render: (a) => {
      const owner = String(a.p_owner);
      const g = ownGallery(a);
      const photo = String(a.p_photo);
      const v = Number(a.p_version);
      const bytes = Number(a.p_bytes);
      if (!g || !keyOk(a.p_key, `u/${owner}/g/${g.id}/${photo}/full-${v}-`)) return { status: 'invalid' };
      const chk = shareRpc().gallery_render_check?.(a) as { status: string } | null;
      if (!chk || chk.status === 'stale' || chk.status === 'not_needed') return { status: 'gone' };
      if (chk.status === 'exists') return { status: 'exists' };
      const prof = profile(owner);
      if (prof.storage + prof.reserved + bytes > rules(owner).storage) return { status: 'storage_full' };
      dropRenders((r) => r.gallery === g.id && r.photo === photo);
      sdb.renders.push({ gallery: g.id, photo, owner, ev: v, key: String(a.p_key), bytes });
      prof.storage += bytes;
      dropRenditions((r) => r.gallery === g.id && r.photo === photo && r.size === 'full');
      return { status: 'ok' };
    },
    gallery_preview_info: (a) => {
      const g = ownGallery(a);
      return g ? guestInfo(g, null) : null;
    },
    // ---- branding ----
    get_branding: (a) => brandingJson(sdb.branding.get(String(a.p_owner))),
    update_branding: (a) => {
      const owner = String(a.p_owner);
      const p = a.p_patch as Record<string, unknown>;
      const w = (p.watermark ?? {}) as Record<string, unknown>;
      if (!rules(owner).studio && ('studioName' in p || 'accent' in p || Object.keys(w).length))
        return { error: 'plan' };
      const b = brand(owner);
      // Switching to a watermark kind with no image while live galleries show the watermark: refused.
      const curKind = b.wmKind ?? 'text';
      if (w.kind && w.kind !== curKind && !(w.kind === 'logo' ? b.logoKey : b.wmKey)) {
        const n = [...sdb.galleries.values()].filter(
          (g) => g.owner === owner && serving(g) && effective(g).watermark,
        ).length;
        if (n > 0) return { error: 'in_use', galleries: n };
      }
      if ('studioName' in p) b.studioName = (p.studioName as string | null) || null;
      if ('accent' in p) b.accent = (p.accent as string | null) ?? null;
      if (Object.keys(w).length) {
        if (w.kind) b.wmKind = w.kind as Branding['wmKind'];
        if ('text' in w) b.wmText = (w.text as string | null) || null;
        if (w.position) b.wmPosition = String(w.position);
        if (w.opacity !== undefined) b.wmOpacity = Number(w.opacity);
        b.wmVersion += 1;
      }
      return { branding: brandingJson(b) };
    },
    record_branding_asset: (a) => {
      const owner = String(a.p_owner);
      const kind = String(a.p_kind);
      const bytes = Number(a.p_bytes);
      if (!keyOk(a.p_key, `o/${owner}/b/${kind}-`) || bytes < 1 || bytes > 2097152)
        return { status: 'invalid' };
      if (!rules(owner).studio) return { status: 'plan' };
      const b = brand(owner);
      const old = kind === 'logo' ? b.logoBytes : b.wmBytes;
      const prof = profile(owner);
      if (bytes > old && prof.storage + prof.reserved + bytes - old > rules(owner).storage)
        return { status: 'storage_full' };
      const oldKey = kind === 'logo' ? b.logoKey : b.wmKey;
      if (oldKey) sdb.queue.push({ id: next(), bucket: 'shared', key: oldKey, prefix: false });
      if (kind === 'logo') Object.assign(b, { logoKey: a.p_key, logoBytes: bytes });
      else Object.assign(b, { wmKey: a.p_key, wmBytes: bytes });
      b.wmVersion += 1;
      prof.storage += bytes - old;
      return { status: 'ok', branding: brandingJson(b) };
    },
    delete_branding_asset: (a) => {
      const owner = String(a.p_owner);
      const b = sdb.branding.get(owner);
      const kind = String(a.p_kind);
      if (b && ((kind === 'logo' && b.wmKind === 'logo') || (kind === 'watermark' && b.wmKind === 'text'))) {
        const n = [...sdb.galleries.values()].filter(
          (g) => g.owner === owner && serving(g) && effective(g).watermark,
        ).length;
        if (n > 0) return { error: 'in_use', galleries: n };
      }
      if (b) {
        const key = kind === 'logo' ? b.logoKey : b.wmKey;
        if (key) {
          sdb.queue.push({ id: next(), bucket: 'shared', key, prefix: false });
          profile(owner).storage -= kind === 'logo' ? b.logoBytes : b.wmBytes;
          if (kind === 'logo') Object.assign(b, { logoKey: null, logoBytes: 0 });
          else Object.assign(b, { wmKey: null, wmBytes: 0 });
          b.wmVersion += 1;
        }
      }
      return { branding: brandingJson(b) };
    },
    branding_asset_key: (a) => {
      const b = sdb.branding.get(String(a.p_owner));
      return (a.p_kind === 'logo' ? b?.logoKey : a.p_kind === 'watermark' ? b?.wmKey : null) ?? null;
    },
    // ---- guests ----
    guest_gallery_state: (a) => {
      const g = byToken(a.p_token_hash);
      return g
        ? {
            id: g.id,
            ownerId: g.owner,
            generation: g.generation,
            hasPasscode: g.passcodeHmac !== null,
            serving: serving(g),
            paused: !!g.pausedUntil && g.pausedUntil > Date.now(),
            expiresAt: iso(g.expiresAt),
          }
        : null;
    },
    guest_gallery_info: (a) => {
      const g = byToken(a.p_token_hash);
      return g ? guestInfo(g, a.p_network) : null;
    },
    gallery_unlock_reserve: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      if (!g) return null;
      if (!serving(g)) return { status: 'ended' };
      if (g.passcodeHmac === null) return { status: 'open' };
      if (g.pausedUntil && g.pausedUntil > Date.now())
        return { status: 'paused', pausedUntil: iso(g.pausedUntil) };
      const since = Date.now() - 900000;
      const mine = sdb.attempts.filter((t) => t.gallery === g.id && t.net === a.p_network && t.at > since);
      if (mine.length >= 5)
        return {
          status: 'limited',
          retryAfter: Math.max(1, Math.ceil(((mine[0]?.at ?? 0) + 900000 - Date.now()) / 1000)),
        };
      if (mine.length >= 2 && !a.p_has_turnstile) return { status: 'turnstile' };
      const all = sdb.attempts.filter((t) => t.gallery === g.id && t.at > since).length;
      const id = next();
      sdb.attempts.push({ id, gallery: g.id, net: String(a.p_network), at: Date.now() });
      let pausedNow = false;
      if (all + 1 >= 25) {
        g.pausedUntil = Date.now() + 900000;
        pausedNow = true;
        log(g, 'paused');
      }
      const notify = pausedNow && (!g.pausedNotifiedAt || g.pausedNotifiedAt <= Date.now() - 86400000);
      if (notify) g.pausedNotifiedAt = Date.now();
      return {
        status: 'ok',
        attemptId: id,
        hmac: String(g.passcodeHmac).replace(/^\\x/, ''),
        generation: g.generation,
        pausedNow,
        networkAttempts: mine.length + 1,
        ownerEmail: notify ? world.users.find((u) => u.id === g.owner)?.email : null,
        name: notify ? g.name : null,
      };
    },
    gallery_unlock_succeeded: (a) => {
      sdb.attempts = sdb.attempts.filter((t) => t.id !== Number(a.p_attempt));
      return null;
    },
    guest_photos: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      if (!g || !serving(g)) return null;
      const from = Number(a.p_cursor ?? 0);
      const lim = Number(a.p_limit ?? 60);
      const guest = sdb.guests.find((x) => x.gallery === g.id && x.hash === a.p_guest);
      const rows = g.photos
        .map((id, position) => ({ id, position }))
        .filter((r) => shareable(r.id) && r.position >= from);
      const page = rows.slice(0, lim);
      return {
        items: page.map((r) => ({
          id: r.id,
          ...sharedSize(r.id),
          full: fullState(g, r.id),
          favourite: !!guest?.favs.has(r.id),
        })),
        nextCursor: rows.length > lim ? String((page.at(-1)?.position ?? 0) + 1) : null,
        selection: effective(g).favourites
          ? { count: guest?.favs.size ?? 0, sentAt: guest?.sentAt ?? null, name: guest?.name ?? null }
          : null,
      };
    },
    guest_media: (a) => {
      if (typeof a.p_download !== 'boolean') throw new Error('guest_media: p_download is required');
      return media(sdb.galleries.get(String(a.p_gallery)), String(a.p_photo), String(a.p_size), a.p_download);
    },
    note_previews_blocked: (a) => {
      blocked.add(String(a.p_owner));
      return null;
    },
    record_rendition: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      const photo = String(a.p_photo);
      const size = String(a.p_size);
      const bytes = Number(a.p_bytes);
      if (!g || !keyOk(a.p_key, `o/${g.owner}/g/${g.id}/${photo}/${size}-`) || bytes < 1)
        return { status: 'invalid' };
      const m = media(g, photo, size, size === 'full') as {
        unavailable?: string;
        source: { editVersion: number };
        wmVersion: number;
      } | null;
      if (
        !m ||
        m.unavailable ||
        m.source.editVersion !== Number(a.p_edit_version) ||
        m.wmVersion !== Number(a.p_wm_version)
      )
        return { status: 'gone' };
      const cur = sdb.renditions.find((r) => r.gallery === g.id && r.photo === photo && r.size === size);
      if (cur && cur.ev === Number(a.p_edit_version) && cur.wv === Number(a.p_wm_version))
        return { status: 'exists', key: cur.key };
      const prof = profile(g.owner);
      const lim = rules(g.owner).storage;
      if (
        bytes > (cur?.bytes ?? 0) &&
        prof.storage + prof.reserved + bytes - (cur?.bytes ?? 0) > lim + (size === 'full' ? 0 : overflow(lim))
      ) {
        if (size !== 'full') blocked.add(g.owner);
        return { status: 'storage_full' };
      }
      if (size !== 'full') blocked.delete(g.owner);
      dropRenditions((r) => r === cur);
      sdb.renditions.push({
        gallery: g.id,
        photo,
        size,
        owner: g.owner,
        key: String(a.p_key),
        bytes,
        ev: Number(a.p_edit_version),
        wv: Number(a.p_wm_version),
      });
      prof.storage += bytes;
      return { status: 'ok' };
    },
    gallery_event: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      if (g && ['opened', 'unlocked', 'downloaded', 'wrong_passcode'].includes(String(a.p_kind))) {
        log(
          g,
          String(a.p_kind),
          (a.p_place as string | null) ?? null,
          (a.p_device as string | null) ?? null,
          Number(a.p_count ?? 1),
        );
      }
      return null;
    },
    guest_set_favourite: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      const photo = String(a.p_photo);
      if (!g || !serving(g) || !g.photos.includes(photo) || !shareable(photo)) return null;
      if (!effective(g).favourites) return 'off';
      if (typeof a.p_network !== 'string') throw new Error('guest_set_favourite: p_network is required');
      let guest = sdb.guests.find((x) => x.gallery === g.id && x.hash === a.p_guest);
      if (!guest && !a.p_on) return 'ok';
      if (
        a.p_on &&
        !guest?.favs.size &&
        sdb.guests.filter((x) => x.gallery === g.id && x.favs.size > 0).length >= 500
      )
        return 'limit';
      if (!guest) {
        const day = Date.now() - 86400000;
        if (
          sdb.guests.filter((x) => x.gallery === g.id && x.net === a.p_network && (x.createdAt ?? 0) > day)
            .length >= 20
        )
          return 'limit';
        guest = {
          net: String(a.p_network),
          createdAt: Date.now(),
          id: crypto.randomUUID(),
          gallery: g.id,
          hash: String(a.p_guest),
          name: null,
          note: null,
          sentAt: null,
          favs: new Set(),
        };
        sdb.guests.push(guest);
      }
      if (a.p_on) guest.favs.add(photo);
      else guest.favs.delete(photo);
      return 'ok';
    },
    guest_send_favourites: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      if (!g || !serving(g)) return null;
      if (!effective(g).favourites) return { status: 'off' };
      const guest = sdb.guests.find((x) => x.gallery === g.id && x.hash === a.p_guest);
      if (!guest?.favs.size) return { status: 'empty' };
      guest.name = String(a.p_name);
      guest.note = (a.p_note as string | null) || null;
      guest.sentAt = new Date().toISOString();
      const notify = !g.favouritesNotifiedAt || g.favouritesNotifiedAt <= Date.now() - 3600000;
      if (notify) g.favouritesNotifiedAt = Date.now();
      log(g, 'favourites_sent', null, null, guest.favs.size);
      return {
        status: 'ok',
        count: guest.favs.size,
        notify,
        ownerEmail: notify ? world.users.find((u) => u.id === g.owner)?.email : null,
        galleryName: notify ? g.name : null,
      };
    },
    guest_report: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      if (!g) return null;
      if (sdb.reports.filter((r) => r.net === a.p_network).length >= 10) return { status: 'limited' };
      const id = crypto.randomUUID();
      const photo = g.photos.includes(String(a.p_photo)) ? String(a.p_photo) : null;
      sdb.reports.push({
        id,
        gallery: g.id,
        photo,
        reason: String(a.p_reason),
        details: (a.p_details as string | null) ?? null,
        net: String(a.p_network),
        at: Date.now(),
        owner: g.owner,
        alertedAt: null,
      });
      sdb.audit.push({ action: 'safety.report', target: id });
      let alert = false;
      let pendingCount = 0;
      if (a.p_reason === 'csam' && (!g.csamAlertedAt || g.csamAlertedAt <= Date.now() - 3600000)) {
        pendingCount = sdb.reports.filter(
          (r) => r.gallery === g.id && r.reason === 'csam' && !r.alertedAt,
        ).length;
        g.csamAlertedAt = Date.now();
        alert = true;
      }
      return { status: 'ok', reportId: id, ownerId: g.owner, photoId: photo, alert, pendingCount };
    },
    confirm_safety_alert: (a) => {
      const r = sdb.reports.find((x) => x.id === a.p_report);
      if (r?.reason !== 'csam') return 0;
      let n = 0;
      for (const x of sdb.reports)
        if (x.reason === 'csam' && !x.alertedAt && x.gallery === r.gallery && (x.at ?? 0) <= (r.at ?? 0)) {
          x.alertedAt = Date.now();
          n++;
        }
      return n;
    },
    due_safety_alerts: () => {
      const now = Date.now();
      const groups = new Map<string, typeof sdb.reports>();
      for (const r of sdb.reports) {
        if (r.reason !== 'csam' || r.alertedAt || (r.at ?? now) > now - 300_000) continue;
        groups.set(r.gallery, [...(groups.get(r.gallery) ?? []), r]);
      }
      const out = [];
      for (const [gid, rs] of groups) {
        const g = sdb.galleries.get(gid);
        if (g?.csamAlertedAt && g.csamAlertedAt > now - 3600000) continue;
        if (g) g.csamAlertedAt = now;
        const last = rs.reduce((m, r) => ((r.at ?? 0) >= (m.at ?? 0) ? r : m));
        out.push({
          galleryId: g ? gid : null,
          ownerId: last.owner ?? null,
          reportId: last.id,
          photoId: last.photo,
          count: rs.length,
        });
      }
      return out;
    },
    guest_logo: (a) => {
      const g = sdb.galleries.get(String(a.p_gallery));
      return g && serving(g) && effective(g).branding ? (sdb.branding.get(g.owner)?.logoKey ?? null) : null;
    },
    apply_safety_hold: (a) => {
      const photo = String(a.p_photo);
      const p = db.photos.get(photo);
      if (!p) return null;
      const was = sdb.held.has(photo);
      sdb.held.add(photo);
      sdb.suspended.add(p.owner);
      for (const g of sdb.galleries.values()) g.photos = g.photos.filter((x) => x !== photo);
      dropRenditions((r) => r.photo === photo);
      dropRenders((r) => r.photo === photo);
      if (!was) sdb.audit.push({ action: 'safety.csam_match', target: photo });
      return { ownerId: p.owner, alreadyHeld: was };
    },
    // ---- jobs ----
    due_share_cleanup: () => {
      let purged = 0;
      let deleted = 0;
      const now = Date.now();
      for (const g of [...sdb.galleries.values()]) {
        const ended = Math.min(g.revokedAt ?? g.expiresAt, g.expiresAt);
        if (ended <= now - 86400000 && sdb.renditions.concat().some((r) => r.gallery === g.id)) {
          dropRenditions((r) => r.gallery === g.id);
          dropRenders((r) => r.gallery === g.id);
          purged += 1;
        }
        if (ended <= now - 30 * 86400000) {
          sdb.queue.push(
            { id: next(), bucket: 'shared', key: `o/${g.owner}/g/${g.id}/`, prefix: true },
            { id: next(), bucket: 'photos', key: `u/${g.owner}/g/${g.id}/`, prefix: true },
          );
          sdb.guests = sdb.guests.filter((x) => x.gallery !== g.id);
          sdb.galleries.delete(g.id);
          deleted += 1;
        }
      }
      const reminders = [...sdb.galleries.values()]
        .filter(
          (g) =>
            g.revokedAt === null &&
            g.expiresAt > now &&
            g.expiresAt <= now + 3 * 86400000 &&
            !(g as { reminded?: boolean }).reminded,
        )
        .map((g) => {
          (g as { reminded?: boolean }).reminded = true;
          return {
            galleryId: g.id,
            ownerEmail: world.users.find((u) => u.id === g.owner)?.email ?? null,
            name: g.name,
            expiresAt: iso(g.expiresAt),
          };
        });
      return { reminders, purged, deleted };
    },
    due_share_deletions: (a) => sdb.queue.slice(0, Number(a.p_limit ?? 500)),
    confirm_share_deletions: (a) => {
      const ids = new Set(a.p_ids as number[]);
      const before = sdb.queue.length;
      sdb.queue = sdb.queue.filter((q) => !ids.has(q.id));
      return before - sdb.queue.length;
    },
  };
}
