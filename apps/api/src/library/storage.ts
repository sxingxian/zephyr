/**
 * Object helpers for the photo library: object keys, batched deletes, prefix purges and the byte streams
 * that put upload parts into the photo store at exactly their declared length.
 */
import type { MiddlewareHandler } from 'hono';
import { hmac, toPgBytea } from '../crypto';
import { type Env, list } from '../env';
import { fail, guardWrite } from '../http';
import { photoStore, storeIdOf } from '../storage/config';
import type { ObjectStore } from '../storage/types';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

/**
 * Ids in paths must be in canonical (lower-case) form. Object keys are built from them, and the database
 * builds keys from uuid::text, which is always lower case: accepting another spelling would let a request
 * store objects under keys nothing records, counts or deletes. Ids the API hands out are always lower case.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Per-member limits (documented in apps/api/README.md). */
export const LIBRARY_LIMITS = {
  /** POST /uploads per member per hour (each may hold up to the plan's batch size). */
  uploadCreatesPerHour: 120,
  /** JSON body caps. */
  uploadCreateBodyBytes: 256 * 1024,
  jsonBodyBytes: 32 * 1024,
  /** R2 deletes take at most 1,000 keys per call. */
  deleteBatch: 1000,
  /** The orphan sweep leaves edited variants younger than this alone (a PUT may be between write and record). */
  editGraceMs: 60 * 60 * 1000,
} as const;

export type PhotoKind = 'original' | 'thumb' | 'preview';
export type VariantKey = 'thumb' | 'preview';

/** `u/<owner>/p/<photo>/<kind>`: grouped by owner so an account purge can delete by prefix. */
export const photoKey = (owner: string, photo: string, kind: PhotoKind) => `u/${owner}/p/${photo}/${kind}`;
/**
 * `staging/<owner>/<photo>/<kind>`: where variant PUTs land. Only a completion that won the database claim
 * copies them to the photo's keys, so a late or racing PUT can never overwrite a finished photo's files.
 * A separate top-level prefix, so an R2 lifecycle rule can delete anything left there after 2 days.
 */
export const stagingKey = (owner: string, photo: string, kind: VariantKey) =>
  `staging/${owner}/${photo}/${kind}`;
/** Every key a photo may have, in public._photo_keys order. */
export const photoKeys = (owner: string, photo: string) => [
  photoKey(owner, photo, 'original'),
  photoKey(owner, photo, 'thumb'),
  photoKey(owner, photo, 'preview'),
  stagingKey(owner, photo, 'thumb'),
  stagingKey(owner, photo, 'preview'),
];

/**
 * `u/<owner>/p/<photo>/edit-<version>-<kind>-<nonce>`: an edited variant rendered from one edit version
 * (phase 4). Every PUT writes its own key (128-bit random nonce), so no request can overwrite or delete an
 * object another request stored; the database records the one key per kind that counts.
 */
export function newEditKey(owner: string, photo: string, version: number, kind: VariantKey): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `u/${owner}/p/${photo}/edit-${version}-${kind}-${nonce}`;
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^u/(${ID})/p/(${ID})/(original|thumb|preview)$`);
const EDIT_KEY_RE = new RegExp(`^u/(${ID})/p/(${ID})/edit-([1-9][0-9]{0,9})-(thumb|preview)-[0-9a-f]{32}$`);
/** Phase 6: a background mask, `u/<owner>/p/<photo>/m/<maskId>.png`. */
const MASK_KEY_RE = new RegExp(`^u/(${ID})/p/(${ID})/m/(${ID})\\.png$`);
/** A photo key whose ids are spelled in any case: one that only matches this was never written canonically. */
const ANY_CASE_PHOTO_KEY_RE = new RegExp(`^u/${ID}/p/${ID}/`, 'i');
const CANONICAL_PHOTO_KEY_RE = new RegExp(`^u/${ID}/p/${ID}/`);
export type ParsedKey =
  | { owner: string; photo: string; kind: PhotoKind }
  | { owner: string; photo: string; kind: 'edit'; version: number; variant: VariantKey }
  | { owner: string; photo: string; kind: 'mask'; mask: string };
/**
 * True for a `u/<owner>/p/<photo>/…` key whose ids aren't in canonical lower-case form. Nothing records,
 * counts or serves such a key, so the orphan sweep deletes it.
 */
export function isNonCanonicalPhotoKey(key: string): boolean {
  return ANY_CASE_PHOTO_KEY_RE.test(key) && !CANONICAL_PHOTO_KEY_RE.test(key);
}
/** Parses a photo object key (`u/…`, including edited variants and masks), or null for anything else. */
export function parseKey(key: string): ParsedKey | null {
  const m = KEY_RE.exec(key);
  if (m) return { owner: m[1] as string, photo: m[2] as string, kind: m[3] as PhotoKind };
  const e = EDIT_KEY_RE.exec(key);
  if (e) {
    return {
      owner: e[1] as string,
      photo: e[2] as string,
      kind: 'edit',
      version: Number(e[3]),
      variant: e[4] as VariantKey,
    };
  }
  const mk = MASK_KEY_RE.exec(key);
  if (mk) return { owner: mk[1] as string, photo: mk[2] as string, kind: 'mask', mask: mk[3] as string };
  return null;
}

/**
 * Shared devices: a page started by one member must not keep writing into whoever signs in next. When
 * the client says whose work this is (X-Zephyr-Expected-User), a different session user gets 409
 * session_changed. Without the header the request is allowed (older clients). Only ever adds a refusal.
 * Runs after requireMember.
 */
export const expectedUser: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const expected = c.req.header('X-Zephyr-Expected-User');
  if (expected !== undefined && expected.trim().toLowerCase() !== c.get('session').userId.toLowerCase()) {
    return c.json(fail('session_changed'), 409);
  }
  await next();
};

/** A member's key for durable rate limits: an HMAC of the user id, never the id itself. */
export const memberHash = async (env: Env, userId: string) =>
  toPgBytea(await hmac(`member:${userId}`, env.IP_HASH_SECRET));

/** Deletes keys in batches of 1,000 (the limit per call). Deleting a missing key is not an error. */
export async function deleteKeys(store: ObjectStore, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += LIBRARY_LIMITS.deleteBatch) {
    await store.delete(keys.slice(i, i + LIBRARY_LIMITS.deleteBatch));
  }
  return keys.length;
}

/** Deletes up to `maxPages` × 1,000 objects under a prefix. `complete` once nothing is left. */
export async function deletePrefix(
  store: ObjectStore,
  prefix: string,
  maxPages: number,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await store.list(prefix, { limit: LIBRARY_LIMITS.deleteBatch });
    if (listed.objects.length === 0) return { deleted, complete: true };
    deleted += await deleteKeys(
      store,
      listed.objects.map((o) => o.key),
    );
  }
  const rest = await store.list(prefix, { limit: 1 });
  return { deleted, complete: rest.objects.length === 0 };
}

export interface PurgeItem {
  photoId: string;
  keys: string[];
  /** The store the photo lives on (phase 8; 'r2' until the purge function returns it). */
  storeId?: string | null;
}
/**
 * Deletes purging photos' objects on each photo's own store, then their rows and usage. Rows are confirmed
 * only for the photos whose objects are gone: a store that fails leaves its photos for the next run.
 */
export async function purgeNow(env: Env, items: PurgeItem[]): Promise<void> {
  if (items.length === 0) return;
  const byStore = new Map<string, PurgeItem[]>();
  for (const i of items) {
    const id = storeIdOf(i);
    byStore.set(id, [...(byStore.get(id) ?? []), i]);
  }
  const done: string[] = [];
  let firstError: unknown = null;
  for (const [id, group] of byStore) {
    try {
      await deleteKeys(
        photoStore(env, id),
        group.flatMap((i) => i.keys),
      );
      done.push(...group.map((i) => i.photoId));
    } catch (err) {
      firstError ??= err;
    }
  }
  if (done.length) await rpc<number>(env, 'confirm_photo_purges', { p_ids: done });
  if (firstError) throw firstError;
}

const BINARY_TYPES = new Set(['application/octet-stream', 'image/jpeg', 'image/webp']);

/**
 * Library routes' write guard. JSON routes get the usual Origin + JSON + body-size check; the binary
 * PUTs (parts, variants) need an allowed Origin and a binary content type instead (a cross-site page
 * can't send a PUT without a preflight we never answer).
 */
export function libraryGuard(maxJsonBytes: number): MiddlewareHandler<HonoEnv> {
  const json = guardWrite((env) => list(env.APP_ORIGINS), maxJsonBytes);
  return async (c, next) => {
    // Saving an edit (PUT …/photos/:id/edit) is the one JSON PUT; every other PUT carries bytes.
    if (c.req.method !== 'PUT' || /\/edit$/.test(c.req.path)) return json(c, next);
    const origin = c.req.header('Origin');
    if (!origin || !list(c.env.APP_ORIGINS).includes(origin)) return c.json(fail('forbidden'), 403);
    const type = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!BINARY_TYPES.has(type)) return c.json(fail('invalid'), 415);
    await next();
  };
}

/** The request's Content-Length, or null if absent or malformed. */
export function contentLength(header: string | undefined): number | null {
  if (!header || !/^\d{1,12}$/.test(header)) return null;
  return Number(header);
}

const concat = (chunks: Uint8Array[], total: number) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

/**
 * Reads at least `n` bytes (fewer if the stream ends) without losing them: returns those bytes and a
 * stream that replays them followed by the rest.
 */
export async function peek(
  body: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    total += r.value.byteLength;
  }
  const head = concat(chunks, total);
  const rest = new ReadableStream<Uint8Array>({
    start(ctrl) {
      if (head.byteLength) ctrl.enqueue(head);
      if (done) ctrl.close();
    },
    async pull(ctrl) {
      const r = await reader.read();
      if (r.done) ctrl.close();
      else ctrl.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, rest };
}

export class BodyLengthError extends Error {
  constructor(readonly tooLong: boolean) {
    super(tooLong ? 'body longer than declared' : 'body shorter than declared');
    this.name = 'BodyLengthError';
  }
}

/**
 * Passes exactly `expected` bytes through and errors (BodyLengthError, also kept in `state`) if the
 * source is longer or shorter, so a part can never be bigger than the server allowed. In Workers the
 * result is also a FixedLengthStream, which R2 needs to know the length up front.
 */
export function exactLength(
  src: ReadableStream<Uint8Array>,
  expected: number,
): { stream: ReadableStream<Uint8Array>; state: { error?: BodyLengthError } } {
  const state: { error?: BodyLengthError } = {};
  let seen = 0;
  const counted = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        seen += chunk.byteLength;
        if (seen > expected) {
          state.error = new BodyLengthError(true);
          ctrl.error(state.error);
          return;
        }
        ctrl.enqueue(chunk);
      },
      flush(ctrl) {
        if (seen !== expected) {
          state.error = new BodyLengthError(false);
          ctrl.error(state.error);
        }
      },
    }),
  );
  const Fixed = (globalThis as { FixedLengthStream?: typeof FixedLengthStream }).FixedLengthStream;
  if (!Fixed) return { stream: counted, state };
  const fixed = new Fixed(expected);
  counted.pipeTo(fixed.writable).catch(() => undefined);
  return { stream: fixed.readable as ReadableStream<Uint8Array>, state };
}

/** Reads a whole body of exactly `expected` bytes (≤ a small cap). Null if it's longer or shorter. */
export async function readExact(
  body: ReadableStream<Uint8Array> | null,
  expected: number,
): Promise<Uint8Array | null> {
  if (!body) return expected === 0 ? new Uint8Array() : null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.byteLength;
    if (total > expected) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(r.value);
  }
  return total === expected ? concat(chunks, total) : null;
}
