/**
 * A small in-memory stand-in for the library's Postgres functions (supabase/migrations/…_library.sql),
 * close enough for routing tests: owner filtering, reservations and usage, statuses and purges. The
 * real rules are tested in SQL (supabase/tests/30_library_test.sql).
 */
import { world } from './helpers';

const PART = 16 * 1024 * 1024;
const VARIANT_ROOM = 307200 + 1572864;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
export const PLANS = {
  free: { storage: 5 * GB, batch: 25, types: ['jpeg', 'png', 'webp'], maxFile: 50 * MB },
  pro: {
    storage: 250 * GB,
    batch: 500,
    types: ['jpeg', 'png', 'webp', 'cr2', 'nef', 'arw'],
    maxFile: 200 * MB,
  },
} as const;

export interface Photo {
  id: string;
  owner: string;
  status: 'uploading' | 'ready' | 'trashed' | 'purging';
  fileType: string;
  filename: string;
  size: number;
  sha: string;
  metadata: Record<string, unknown>;
  favourite: boolean;
  thumb: number;
  preview: number;
  createdAt: string;
  trashedAt: string | null;
  purgeAfter: string | null;
  publishPending?: boolean;
  /** Only ever grows (phase 4): each save or revert takes the next number. */
  editVersion?: number;
}
export interface Edit {
  photoId: string;
  owner: string;
  recipe: Record<string, unknown>;
  version: number;
  thumbVersion: number | null;
  thumbKey: string | null;
  thumbBytes: number;
  previewVersion: number | null;
  previewKey: string | null;
  previewBytes: number;
  previewWidth?: number | null;
  previewHeight?: number | null;
  updatedAt: string;
}
export interface Recipe {
  id: string;
  owner: string;
  name: string;
  recipe: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface Upload {
  id: string;
  owner: string;
  photoId: string;
  r2Key: string;
  r2UploadId: string | null;
  fileType: string;
  size: number;
  partCount: number;
  parts: Record<string, string>;
  variants: Record<string, number>;
  reserved: number;
  expiresAt: number;
}
export interface Profile {
  plan: keyof typeof PLANS;
  storage: number;
  reserved: number;
  deletionDue: string | null;
}
export interface Album {
  id: string;
  owner: string;
  name: string;
  cover: string | null;
  photos: Set<string>;
  createdAt: string;
}

export const db = {
  photos: new Map<string, Photo>(),
  uploads: new Map<string, Upload>(),
  albums: new Map<string, Album>(),
  profiles: new Map<string, Profile>(),
  jobState: new Map<string, string | null>(),
  edits: new Map<string, Edit>(),
  recipes: new Map<string, Recipe>(),
  /** Phase 6: recorded mask keys per photo (photo_masks). */
  maskKeys: new Map<string, string[]>(),
  /** Every library RPC's p_owner, to prove the Worker only ever passes the session's user. */
  owners: [] as string[],
};

export function resetDb() {
  db.photos.clear();
  db.uploads.clear();
  db.albums.clear();
  db.profiles.clear();
  db.jobState.clear();
  db.edits.clear();
  db.maskKeys.clear();
  db.recipes.clear();
  db.owners.length = 0;
}

export const profile = (id: string): Profile => {
  let p = db.profiles.get(id);
  if (!p) {
    p = { plan: 'free', storage: 0, reserved: 0, deletionDue: null };
    db.profiles.set(id, p);
  }
  return p;
};
export const prefix = (owner: string, photo: string) => `u/${owner}/p/${photo}/`;
/** The prefix every edited-variant key of this version and kind starts with (a nonce follows). */
export const editKeyOf = (owner: string, photo: string, v: number, kind: 'thumb' | 'preview') =>
  `${prefix(owner, photo)}edit-${v}-${kind}-`;
const editKeyOk = (owner: string, photo: string, v: number, kind: string, key: unknown) =>
  typeof key === 'string' &&
  key.startsWith(`${prefix(owner, photo)}edit-${v}-${kind}-`) &&
  /^[0-9a-f]{32}$/.test(key.slice(`${prefix(owner, photo)}edit-${v}-${kind}-`.length));
const editKeys = (e: Edit | undefined) =>
  e ? [...(e.thumbKey ? [e.thumbKey] : []), ...(e.previewKey ? [e.previewKey] : [])] : [];
const keys = (owner: string, photo: string) => [
  ...['original', 'thumb', 'preview'].map((k) => prefix(owner, photo) + k),
  ...['thumb', 'preview'].map((k) => `staging/${owner}/${photo}/${k}`),
  ...editKeys(db.edits.get(photo)),
];
const emptyRecipe = (r: Record<string, unknown> | null | undefined) => !r || Object.keys(r).length <= 1;
const editBytes = (photo: string) => {
  const e = db.edits.get(photo);
  return e ? e.thumbBytes + e.previewBytes : 0;
};
export function editJson(e: Edit) {
  return {
    photoId: e.photoId,
    recipe: e.recipe,
    version: e.version,
    rendered: e.thumbVersion === e.version && e.previewVersion === e.version,
    updatedAt: e.updatedAt,
  };
}

export function photoJson(p: Photo) {
  return {
    id: p.id,
    filename: p.filename,
    fileType: p.fileType,
    sizeBytes: p.size,
    width: (p.metadata.width as number) ?? null,
    height: (p.metadata.height as number) ?? null,
    takenAt: (p.metadata.takenAt as string) ?? null,
    createdAt: p.createdAt,
    favourite: p.favourite,
    hasThumb: p.thumb > 0,
    hasPreview: p.preview > 0,
    edit: (() => {
      const e = db.edits.get(p.id);
      return e && !emptyRecipe(e.recipe) ? { version: e.version, rendered: editJson(e).rendered } : null;
    })(),
    ...(p.status === 'trashed' ? { trashedAt: p.trashedAt, purgeAt: p.purgeAfter } : {}),
  };
}
const albumJson = (a: Album) => {
  const ready = [...a.photos].filter((id) => db.photos.get(id)?.status === 'ready');
  return {
    id: a.id,
    name: a.name,
    photoCount: ready.length,
    coverPhotoIds: ready.slice(0, 3),
    createdAt: a.createdAt,
    updatedAt: a.createdAt,
  };
};

/** The usage invariant from the migration. */
export function noDrift(owner: string): boolean {
  const p = profile(owner);
  const stored = [...db.photos.values()]
    .filter((x) => x.owner === owner && x.status !== 'uploading')
    .reduce((n, x) => n + x.size + x.thumb + x.preview + editBytes(x.id), 0);
  const reserved = [...db.uploads.values()]
    .filter((u) => u.owner === owner)
    .reduce((n, u) => n + u.reserved, 0);
  return p.storage === stored && p.reserved === reserved;
}

/** Adds a ready photo directly (as a finished upload would), keeping usage in step. */
export function seedPhoto(owner: string, over: Partial<Photo> = {}): Photo {
  const p: Photo = {
    id: crypto.randomUUID(),
    owner,
    status: 'ready',
    fileType: 'jpeg',
    filename: 'IMG_0001.jpg',
    size: 1000,
    sha: crypto.randomUUID(),
    metadata: {},
    favourite: false,
    thumb: 10,
    preview: 20,
    createdAt: new Date().toISOString(),
    trashedAt: null,
    purgeAfter: null,
    ...over,
  };
  db.photos.set(p.id, p);
  if (p.status !== 'uploading') profile(owner).storage += p.size + p.thumb + p.preview;
  return p;
}

type Args = Record<string, unknown>;
const own = (a: Args) => {
  const o = String(a.p_owner);
  db.owners.push(o);
  return o;
};
const live = (u: Upload | undefined, owner: string) =>
  u && u.owner === owner && u.expiresAt > Date.now() ? u : null;
const startPurge = (owner: string, ids: string[] | null) => {
  const purge: { photoId: string; keys: string[] }[] = [];
  for (const p of db.photos.values()) {
    if (p.owner === owner && p.status === 'trashed' && (!ids || ids.includes(p.id))) {
      p.status = 'purging';
      purge.push({ photoId: p.id, keys: keys(owner, p.id) });
    }
  }
  return purge;
};

export function libraryRpc(): Record<string, (a: Args) => unknown> {
  return {
    get_session_profile: (a) => {
      const u = world.users.find((x) => x.id === String(a.p_user_id));
      if (!u) return null;
      return {
        isStaff: Boolean(u.staff),
        displayName: u.displayName ?? null,
        plan: profile(u.id).plan,
        createdAt: '2026-10-01T00:00:00Z',
        deleted: false,
        deletionDue: profile(u.id).deletionDue,
      };
    },
    create_uploads: (a) => {
      const owner = own(a);
      const prof = profile(owner);
      if (prof.deletionDue) return { error: 'account_pending_deletion' };
      const rules = PLANS[prof.plan];
      const files = a.p_files as { name: string; size: number; sha256: string; type: string }[];
      if (files.length > rules.batch) return { error: 'batch_too_large' };
      let avail = rules.storage - prof.storage - prof.reserved;
      const seen = new Map<string, string>();
      return {
        results: files.map((f) => {
          if (!(rules.types as readonly string[]).includes(f.type))
            return { status: 'rejected', reason: 'type' };
          if (f.size > rules.maxFile) return { status: 'rejected', reason: 'too_large' };
          const dedupe = `${f.sha256}:${f.size}`;
          const existing =
            seen.get(dedupe) ??
            [...db.photos.values()].find(
              (p) =>
                p.owner === owner &&
                p.sha === f.sha256 &&
                p.size === f.size &&
                ['ready', 'trashed'].includes(p.status),
            )?.id;
          if (existing) return { status: 'duplicate', photoId: existing };
          const need = f.size + VARIANT_ROOM;
          if (need > avail) return { status: 'rejected', reason: 'quota' };
          const photo = seedPhoto(owner, {
            status: 'uploading',
            filename: f.name,
            fileType: f.type,
            size: f.size,
            sha: f.sha256,
            thumb: 0,
            preview: 0,
          });
          const up: Upload = {
            id: crypto.randomUUID(),
            owner,
            photoId: photo.id,
            r2Key: `${prefix(owner, photo.id)}original`,
            r2UploadId: null,
            fileType: f.type,
            size: f.size,
            partCount: Math.ceil(f.size / PART),
            parts: {},
            variants: {},
            reserved: need,
            expiresAt: Date.now() + 24 * 3600 * 1000,
          };
          db.uploads.set(up.id, up);
          prof.reserved += need;
          avail -= need;
          seen.set(dedupe, photo.id);
          return {
            status: 'ready',
            uploadId: up.id,
            photoId: photo.id,
            partSize: PART,
            partCount: up.partCount,
            fileType: f.type,
            r2Key: up.r2Key,
          };
        }),
      };
    },
    get_upload: (a) => {
      const owner = own(a);
      const u = db.uploads.get(String(a.p_upload));
      if (!u || u.owner !== owner) return null;
      return {
        uploadId: u.id,
        photoId: u.photoId,
        r2Key: u.r2Key,
        r2UploadId: u.r2UploadId,
        fileType: u.fileType,
        sizeBytes: u.size,
        partSize: PART,
        partCount: u.partCount,
        parts: u.parts,
        variants: u.variants,
        expiresAt: new Date(u.expiresAt).toISOString(),
        expired: u.expiresAt <= Date.now(),
      };
    },
    set_upload_r2: (a) => {
      const u = live(db.uploads.get(String(a.p_upload)), own(a));
      if (!u) return null;
      u.r2UploadId ??= String(a.p_r2_upload_id);
      return u.r2UploadId;
    },
    record_part: (a) => {
      const u = live(db.uploads.get(String(a.p_upload)), own(a));
      const n = Number(a.p_n);
      if (!u || n < 1 || n > u.partCount) return null;
      u.parts[String(n)] = String(a.p_etag);
      return true;
    },
    record_variant: (a) => {
      const u = live(db.uploads.get(String(a.p_upload)), own(a));
      if (!u) return null;
      u.variants[String(a.p_kind)] = Number(a.p_bytes);
      return true;
    },
    complete_upload: (a) => {
      const owner = own(a);
      const u = db.uploads.get(String(a.p_upload));
      if (!u || u.owner !== owner) return null;
      if (u.expiresAt <= Date.now()) return { status: 'expired' };
      if (Object.keys(u.parts).length !== u.partCount) return { status: 'incomplete' };
      const p = db.photos.get(u.photoId) as Photo;
      const prof = profile(owner);
      const existing = [...db.photos.values()].find(
        (x) =>
          x.id !== p.id &&
          x.owner === owner &&
          x.sha === p.sha &&
          x.size === p.size &&
          ['ready', 'trashed'].includes(x.status),
      );
      db.uploads.delete(u.id);
      prof.reserved -= u.reserved;
      if (existing) {
        db.photos.delete(p.id);
        return { status: 'duplicate', photoId: existing.id };
      }
      Object.assign(p, {
        status: 'ready',
        metadata: a.p_metadata ?? {},
        // The Worker's measured sizes, never what the browser reported (uploads.variants).
        thumb: Math.min(Number(a.p_thumb_bytes ?? 0), 307200),
        preview: Math.min(Number(a.p_preview_bytes ?? 0), 1572864),
      });
      p.publishPending = p.thumb > 0 || p.preview > 0;
      prof.storage += p.size + p.thumb + p.preview;
      return { status: 'ready', photo: photoJson(p) };
    },
    abort_upload: (a) => {
      const owner = own(a);
      const u = db.uploads.get(String(a.p_upload));
      if (!u || u.owner !== owner) return null;
      db.uploads.delete(u.id);
      db.photos.delete(u.photoId);
      profile(owner).reserved -= u.reserved;
      return { r2Key: u.r2Key, r2UploadId: u.r2UploadId, keys: keys(owner, u.photoId) };
    },
    list_photos: (a) => {
      const owner = own(a);
      if (a.p_album && db.albums.get(String(a.p_album))?.owner !== owner) return null;
      const album = a.p_album ? db.albums.get(String(a.p_album)) : null;
      const status = a.p_view === 'trash' ? 'trashed' : 'ready';
      const items = [...db.photos.values()]
        .filter((p) => p.owner === owner && p.status === status)
        .filter((p) => a.p_view !== 'favourites' || p.favourite)
        .filter((p) => a.p_view !== 'edited' || !emptyRecipe(db.edits.get(p.id)?.recipe))
        .filter((p) => !album || album.photos.has(p.id))
        .filter((p) => !a.p_q || p.filename.toLowerCase().includes(String(a.p_q).toLowerCase()))
        .map(photoJson);
      return { items: items.slice(0, Number(a.p_limit)), nextCursor: null };
    },
    get_photo: (a) => {
      const owner = own(a);
      const p = db.photos.get(String(a.p_id));
      if (!p || p.owner !== owner || !['ready', 'trashed'].includes(p.status)) return null;
      const albums = [...db.albums.values()]
        .filter((al) => al.owner === owner && al.photos.has(p.id))
        .map((al) => ({ id: al.id, name: al.name }));
      const e = db.edits.get(p.id);
      return {
        ...photoJson(p),
        metadata: p.metadata,
        albums,
        recipe: e && !emptyRecipe(e.recipe) ? e.recipe : null,
      };
    },
    photo_file: (a) => {
      const owner = own(a);
      const p = db.photos.get(String(a.p_id));
      if (!p || p.owner !== owner || !['ready', 'trashed'].includes(p.status)) return null;
      const e = db.edits.get(p.id);
      const live = e && !emptyRecipe(e.recipe);
      return {
        fileType: p.fileType,
        filename: p.filename,
        sizeBytes: p.size,
        hasThumb: p.thumb > 0,
        hasPreview: p.preview > 0,
        editVersion: e?.version ?? null,
        editThumbKey: live && e.thumbVersion === e.version ? e.thumbKey : null,
        editPreviewKey: live && e.previewVersion === e.version ? e.previewKey : null,
      };
    },
    patch_photo: (a) => {
      const owner = own(a);
      const p = db.photos.get(String(a.p_id));
      if (!p || p.owner !== owner || !['ready', 'trashed'].includes(p.status)) return null;
      if (a.p_favourite !== null && a.p_favourite !== undefined) p.favourite = Boolean(a.p_favourite);
      if (a.p_filename) p.filename = String(a.p_filename);
      return photoJson(p);
    },
    bulk_photos: (a) => {
      const owner = own(a);
      const ids = a.p_ids as string[];
      const album = a.p_album ? db.albums.get(String(a.p_album)) : null;
      if (String(a.p_action).endsWith('album') && album?.owner !== owner) return null;
      const mine = ids.map((id) => db.photos.get(id)).filter((p): p is Photo => p?.owner === owner);
      const ready = mine.filter((p) => p.status === 'ready');
      switch (a.p_action) {
        case 'favourite':
        case 'unfavourite':
          for (const p of ready) p.favourite = a.p_action === 'favourite';
          return { affected: ready.length };
        case 'trash':
          for (const p of ready) {
            p.status = 'trashed';
            p.trashedAt = new Date().toISOString();
            p.purgeAfter = new Date(Date.now() + 30 * 86400_000).toISOString();
          }
          return { affected: ready.length };
        case 'restore': {
          const trashed = mine.filter((p) => p.status === 'trashed');
          for (const p of trashed) Object.assign(p, { status: 'ready', trashedAt: null, purgeAfter: null });
          return { affected: trashed.length };
        }
        case 'delete_forever': {
          const purge = startPurge(owner, ids);
          return { affected: purge.length, purge };
        }
        case 'add_to_album':
          for (const p of ready) album?.photos.add(p.id);
          return { affected: ready.length };
        case 'remove_from_album':
          for (const p of mine) album?.photos.delete(p.id);
          return { affected: mine.length };
        default:
          return { error: 'invalid' };
      }
    },
    empty_trash: (a) => {
      const purge = startPurge(own(a), null);
      return { deleted: purge.length, purge };
    },
    list_albums: (a) => {
      const owner = own(a);
      return [...db.albums.values()].filter((al) => al.owner === owner).map(albumJson);
    },
    get_album: (a) => {
      const al = db.albums.get(String(a.p_id));
      return al && al.owner === own(a) ? albumJson(al) : null;
    },
    create_album: (a) => {
      const owner = own(a);
      const al: Album = {
        id: crypto.randomUUID(),
        owner,
        name: String(a.p_name),
        cover: null,
        photos: new Set(
          ((a.p_photo_ids as string[] | null) ?? []).filter((id) => db.photos.get(id)?.owner === owner),
        ),
        createdAt: new Date().toISOString(),
      };
      db.albums.set(al.id, al);
      return albumJson(al);
    },
    patch_album: (a) => {
      const al = db.albums.get(String(a.p_id));
      if (!al || al.owner !== own(a)) return null;
      if (a.p_cover_set && a.p_cover && !al.photos.has(String(a.p_cover))) return { error: 'invalid' };
      if (a.p_name) al.name = String(a.p_name);
      if (a.p_cover_set) al.cover = (a.p_cover as string | null) ?? null;
      return albumJson(al);
    },
    delete_album: (a) => {
      const al = db.albums.get(String(a.p_id));
      if (!al || al.owner !== own(a)) return null;
      db.albums.delete(al.id);
      return true;
    },
    get_usage: (a) => {
      const owner = own(a);
      const p = profile(owner);
      const rules = PLANS[p.plan];
      const mine = [...db.photos.values()].filter((x) => x.owner === owner);
      return {
        usedBytes: p.storage,
        reservedBytes: p.reserved,
        limitBytes: rules.storage,
        trashBytes: mine
          .filter((x) => x.status === 'trashed' || x.status === 'purging')
          .reduce((n, x) => n + x.size + x.thumb + x.preview + editBytes(x.id), 0),
        photoCount: mine.filter((x) => x.status === 'ready').length,
        plan: p.plan,
        fileTypes: rules.types,
        maxFileBytes: rules.maxFile,
        batchSize: rules.batch,
      };
    },
    request_account_deletion: (a) => {
      const p = profile(own(a));
      p.deletionDue ??= new Date(Date.now() + 30 * 86400_000).toISOString();
      return p.deletionDue;
    },
    restore_account: (a) => {
      const p = profile(own(a));
      if (!p.deletionDue || Date.parse(p.deletionDue) <= Date.now()) return null;
      p.deletionDue = null;
      return true;
    },
    // Claims like the SQL: rows and reservation go first, then the Worker cleans R2.
    due_expired_uploads: () =>
      [...db.uploads.values()]
        .filter((u) => u.expiresAt <= Date.now())
        .map((u) => {
          db.uploads.delete(u.id);
          db.photos.delete(u.photoId);
          profile(u.owner).reserved -= u.reserved;
          return { uploadId: u.id, r2Key: u.r2Key, r2UploadId: u.r2UploadId, keys: keys(u.owner, u.photoId) };
        }),
    due_publishes: () =>
      [...db.photos.values()]
        .filter((p) => p.publishPending && (p.status === 'ready' || p.status === 'trashed'))
        .map((p) => ({ photoId: p.id, ownerId: p.owner, thumbBytes: p.thumb, previewBytes: p.preview })),
    finish_publish: (a) => {
      const p = db.photos.get(String(a.p_photo));
      if (!p || p.owner !== own(a) || !p.publishPending) return null;
      let freed = 0;
      if (a.p_lost_thumb) {
        freed += p.thumb;
        p.thumb = 0;
      }
      if (a.p_lost_preview) {
        freed += p.preview;
        p.preview = 0;
      }
      p.publishPending = false;
      profile(p.owner).storage -= freed;
      return true;
    },
    due_photo_purges: () => {
      for (const p of db.photos.values()) {
        if (p.status === 'trashed' && p.purgeAfter && Date.parse(p.purgeAfter) <= Date.now())
          p.status = 'purging';
      }
      return [...db.photos.values()]
        .filter((p) => p.status === 'purging')
        .map((p) => ({ photoId: p.id, keys: keys(p.owner, p.id) }));
    },
    confirm_photo_purges: (a) => {
      let n = 0;
      for (const id of a.p_ids as string[]) {
        const p = db.photos.get(id);
        if (p?.status !== 'purging') continue;
        profile(p.owner).storage -= p.size + p.thumb + p.preview + editBytes(id);
        db.photos.delete(id);
        db.edits.delete(id);
        n++;
      }
      return n;
    },
    due_account_purges: () =>
      [...db.profiles.entries()]
        .filter(([, p]) => p.deletionDue && Date.parse(p.deletionDue) <= Date.now())
        .map(([id]) => ({
          ownerId: id,
          prefix: `u/${id}/`,
          stagingPrefix: `staging/${id}/`,
          uploads: [...db.uploads.values()]
            .filter((u) => u.owner === id && u.r2UploadId)
            .map((u) => ({ r2Key: u.r2Key, r2UploadId: u.r2UploadId })),
        })),
    account_purge_progress: () => null,
    sweep_photo_rows: (a) =>
      (a.p_ids as string[]).flatMap((id) => {
        const p = db.photos.get(id);
        if (!p) return [];
        const activeUpload = [...db.uploads.values()].some((u) => u.photoId === id);
        const e = db.edits.get(id);
        return [
          {
            id,
            ownerId: p.owner,
            status: p.status,
            activeUpload,
            editThumbKey: e?.thumbKey ?? null,
            editPreviewKey: e?.previewKey ?? null,
            maskKeys: db.maskKeys.get(id) ?? [],
            hasThumb: p.thumb > 0,
            hasPreview: p.preview > 0,
          },
        ];
      }),
    get_job_state: (a) => db.jobState.get(String(a.p_key)) ?? null,
    set_job_state: (a) => {
      db.jobState.set(String(a.p_key), (a.p_value as string | null) ?? null);
      return null;
    },
    purge_rate_limits: () => 0,
    record_cleanup: () => null,
    ...editorRpc(),
  };
}

const readyOf = (a: Args, id: unknown) => {
  const p = db.photos.get(String(id));
  return p && p.owner === own(a) && p.status === 'ready' ? p : null;
};

/** The editor's functions (supabase/migrations/…_editor.sql), same contract, in memory. */
function editorRpc(): Record<string, (a: Args) => unknown> {
  const recipeJson = (r: Recipe) => ({
    id: r.id,
    name: r.name,
    recipe: r.recipe,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  const validRecipe = (r: unknown) =>
    Boolean(r && typeof r === 'object' && (r as { v?: unknown }).v === 1 && JSON.stringify(r).length <= 4096);
  const nextVersion = (p: Photo) => {
    p.editVersion = (p.editVersion ?? 0) + 1;
    return p.editVersion;
  };
  const upsert = (p: Photo, recipe: Record<string, unknown>) => {
    const v = nextVersion(p);
    const old = db.edits.get(p.id);
    const e: Edit = old
      ? { ...old, recipe, version: v, updatedAt: new Date().toISOString() }
      : {
          photoId: p.id,
          owner: p.owner,
          recipe,
          version: v,
          thumbVersion: null,
          thumbKey: null,
          thumbBytes: 0,
          previewVersion: null,
          previewKey: null,
          previewBytes: 0,
          updatedAt: new Date().toISOString(),
        };
    db.edits.set(p.id, e);
    return e;
  };
  const revert = (p: Photo) => {
    const e = db.edits.get(p.id);
    if (!e) return [];
    db.edits.delete(p.id);
    nextVersion(p);
    profile(p.owner).storage -= e.thumbBytes + e.previewBytes;
    return editKeys(e);
  };
  return {
    get_edit: (a) => {
      const p = readyOf(a, a.p_photo);
      if (!p) return null;
      const e = db.edits.get(p.id);
      return { edit: e ? editJson(e) : null };
    },
    save_edit: (a) => {
      if (!validRecipe(a.p_recipe)) return { status: 'invalid' };
      const p = readyOf(a, a.p_photo);
      if (!p) return null;
      const cur = db.edits.get(p.id);
      if ((cur?.version ?? null) !== (a.p_base_version ?? null)) {
        return { status: 'conflict', edit: cur ? editJson(cur) : null };
      }
      return { status: 'ok', edit: editJson(upsert(p, a.p_recipe as Record<string, unknown>)) };
    },
    delete_edit: (a) => {
      const p = readyOf(a, a.p_photo);
      if (!p) return null;
      return { keys: revert(p) };
    },
    edit_variant_check: (a) => {
      const p = readyOf(a, a.p_photo);
      const kind = String(a.p_kind);
      if (!p || (kind !== 'thumb' && kind !== 'preview')) return null;
      const e = db.edits.get(p.id);
      const v = Number(a.p_version);
      if (!e || e.version !== v) return { status: 'stale' };
      const exists = (kind === 'thumb' ? e.thumbVersion : e.previewVersion) === v;
      // Phase 8: 'exists' also gives the recorded variant's key.
      return exists
        ? { status: 'exists', key: kind === 'thumb' ? e.thumbKey : e.previewKey }
        : { status: 'current' };
    },
    record_edit_variant: (a) => {
      const kind = String(a.p_kind);
      const bytes = Number(a.p_bytes);
      const v = Number(a.p_version);
      const cap = kind === 'thumb' ? 307200 : kind === 'preview' ? 1572864 : 0;
      if (!cap || !(bytes >= 1 && bytes <= cap)) return { status: 'invalid' };
      if (!editKeyOk(own(a), String(a.p_photo), v, kind, a.p_key)) return { status: 'invalid' };
      const p = readyOf(a, a.p_photo);
      const e = p ? db.edits.get(p.id) : undefined;
      if (!p || !e || e.version !== v) return { status: 'gone' };
      const oldV = kind === 'thumb' ? e.thumbVersion : e.previewVersion;
      const oldKey = kind === 'thumb' ? e.thumbKey : e.previewKey;
      if (oldV === v) return { status: 'exists' };
      const oldBytes = kind === 'thumb' ? e.thumbBytes : e.previewBytes;
      const prof = profile(p.owner);
      const delta = bytes - oldBytes;
      if (delta > 0 && prof.storage + prof.reserved + delta > PLANS[prof.plan].storage)
        return { status: 'storage_full' };
      const key = String(a.p_key);
      if (kind === 'thumb') Object.assign(e, { thumbVersion: v, thumbKey: key, thumbBytes: bytes });
      else
        Object.assign(e, {
          previewVersion: v,
          previewKey: key,
          previewBytes: bytes,
          previewWidth: (a.p_width as number | undefined) ?? null,
          previewHeight: (a.p_height as number | undefined) ?? null,
        });
      prof.storage += delta;
      return { status: 'ok', previousKey: oldKey };
    },
    bulk_edit_state: (a) => {
      const owner = own(a);
      const items = (a.p_ids as string[])
        .map((id) => db.photos.get(id))
        .filter((p): p is Photo => p?.owner === owner && p.status === 'ready')
        .map((p) => {
          const e = db.edits.get(p.id);
          return { photoId: p.id, version: e?.version ?? null, recipe: e?.recipe ?? null };
        });
      return { batchSize: PLANS[profile(owner).plan].batch, items };
    },
    apply_bulk_edits: (a) => {
      const items = a.p_items as {
        photoId: string;
        baseVersion: number | null;
        recipe: Record<string, unknown> | null;
      }[];
      if (items.some((it) => it.recipe !== null && !validRecipe(it.recipe))) return { error: 'invalid' };
      const applied: unknown[] = [];
      const conflicts: string[] = [];
      const dropped: string[] = [];
      for (const it of items) {
        const p = readyOf(a, it.photoId);
        if (!p) continue;
        const cur = db.edits.get(p.id);
        if ((cur?.version ?? null) !== it.baseVersion) {
          conflicts.push(p.id);
          continue;
        }
        if (it.recipe === null) {
          if (!cur) continue;
          dropped.push(...revert(p));
          applied.push({ photoId: p.id, edit: null });
        } else {
          applied.push({ photoId: p.id, edit: editJson(upsert(p, it.recipe)) });
        }
      }
      return { applied, conflicts, keys: dropped };
    },
    list_recipes: (a) => {
      const owner = own(a);
      return [...db.recipes.values()].filter((r) => r.owner === owner).map(recipeJson);
    },
    create_recipe: (a) => {
      const owner = own(a);
      if (!validRecipe(a.p_recipe) || 'crop' in (a.p_recipe as object)) return { error: 'invalid' };
      if ([...db.recipes.values()].filter((r) => r.owner === owner).length >= 200) return { error: 'limit' };
      const now = new Date().toISOString();
      const r: Recipe = {
        id: crypto.randomUUID(),
        owner,
        name: String(a.p_name),
        recipe: a.p_recipe as Record<string, unknown>,
        createdAt: now,
        updatedAt: now,
      };
      db.recipes.set(r.id, r);
      return recipeJson(r);
    },
    update_recipe: (a) => {
      const r = db.recipes.get(String(a.p_id));
      if (!r || r.owner !== own(a)) return null;
      if (a.p_name) r.name = String(a.p_name);
      if (a.p_recipe) r.recipe = a.p_recipe as Record<string, unknown>;
      r.updatedAt = new Date().toISOString();
      return recipeJson(r);
    },
    delete_recipe: (a) => {
      const r = db.recipes.get(String(a.p_id));
      if (!r || r.owner !== own(a)) return null;
      db.recipes.delete(r.id);
      return true;
    },
  };
}

/** GoTrue's admin delete-user cascades: the profile and library rows go with the user. */
export function deleteUserCascade(id: string) {
  world.users = world.users.filter((u) => u.id !== id);
  db.profiles.delete(id);
  for (const [k, p] of db.photos) if (p.owner === id) db.photos.delete(k);
  for (const [k, u] of db.uploads) if (u.owner === id) db.uploads.delete(k);
  for (const [k, al] of db.albums) if (al.owner === id) db.albums.delete(k);
}
