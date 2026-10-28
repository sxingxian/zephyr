/**
 * R2 helpers for the photo library: object keys, batched deletes, prefix purges and the byte streams
 * that put upload parts into R2 at exactly their declared length.
 */
import type { MiddlewareHandler } from 'hono';
import { hmac, toPgBytea } from '../crypto';
import { type Env, list } from '../env';
import { fail, guardWrite } from '../http';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-member limits (documented in apps/api/README.md). */
export const LIBRARY_LIMITS = {
  /** POST /uploads per member per hour (each may hold up to the plan's batch size). */
  uploadCreatesPerHour: 120,
  /** JSON body caps. */
  uploadCreateBodyBytes: 256 * 1024,
  jsonBodyBytes: 32 * 1024,
  /** R2 deletes take at most 1,000 keys per call. */
  deleteBatch: 1000,
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

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^u/(${ID})/p/(${ID})/(original|thumb|preview)$`);
/** Parses a photo object key (`u/…`), or null for anything else. */
export function parseKey(key: string): { owner: string; photo: string; kind: PhotoKind } | null {
  const m = KEY_RE.exec(key);
  return m ? { owner: m[1] as string, photo: m[2] as string, kind: m[3] as PhotoKind } : null;
}

/** A member's key for durable rate limits: an HMAC of the user id, never the id itself. */
export const memberHash = async (env: Env, userId: string) =>
  toPgBytea(await hmac(`member:${userId}`, env.IP_HASH_SECRET));

/** Deletes keys in batches of 1,000 (R2's limit per call). Deleting a missing key is not an error. */
export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += LIBRARY_LIMITS.deleteBatch) {
    await bucket.delete(keys.slice(i, i + LIBRARY_LIMITS.deleteBatch));
  }
  return keys.length;
}

/** Deletes up to `maxPages` × 1,000 objects under a prefix. `complete` once nothing is left. */
export async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  maxPages: number,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await bucket.list({ prefix, limit: LIBRARY_LIMITS.deleteBatch });
    if (listed.objects.length === 0) return { deleted, complete: true };
    deleted += await deleteKeys(
      bucket,
      listed.objects.map((o) => o.key),
    );
  }
  const rest = await bucket.list({ prefix, limit: 1 });
  return { deleted, complete: rest.objects.length === 0 };
}

export interface PurgeItem {
  photoId: string;
  keys: string[];
}
/** Deletes purging photos' objects, then their rows and usage. On an R2 failure the job finishes later. */
export async function purgeNow(env: Env, items: PurgeItem[]): Promise<void> {
  if (items.length === 0) return;
  await deleteKeys(
    env.PHOTOS,
    items.flatMap((i) => i.keys),
  );
  await rpc<number>(env, 'confirm_photo_purges', { p_ids: items.map((i) => i.photoId) });
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
    if (c.req.method !== 'PUT') return json(c, next);
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
