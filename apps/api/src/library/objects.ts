/**
 * The object-storage seam. Phase 5 code reaches buckets only through these plain operations (put, get,
 * head, delete, list) so the provider can be swapped (phase 8: an admin may move storage from Cloudflare R2
 * to an S3-compatible service) by adding another ObjectStore and changing `stores()`. Phase 3/4 code still
 * calls env.PHOTOS directly; moving it behind this interface is a mechanical follow-up.
 *
 * The one provider-specific read path is `fetchCached`: guest renditions are read through the media host
 * (an R2 custom domain behind Cloudflare's cache, where the CSAM Scanning Tool sees them). Another provider
 * needs its own CDN origin there, with the same "only the Worker may fetch" rule (the X-Zephyr-Media secret).
 */
import type { Env } from '../env';

export interface StoredObject {
  key: string;
  size: number;
  uploaded: Date;
  contentType: string | null;
}
export interface ObjectBody extends StoredObject {
  body: ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}
export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  /** Required for streams: the exact byte length (providers need it up front). */
  length?: number;
}
export interface ObjectStore {
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<ObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  /** Deletes up to 1,000 keys. Deleting a missing key is not an error. */
  delete(keys: string[]): Promise<void>;
  list(
    prefix: string,
    opts?: { cursor?: string | null; limit?: number },
  ): Promise<{ objects: StoredObject[]; cursor: string | null }>;
}

const meta = (o: R2Object): StoredObject => ({
  key: o.key,
  size: o.size,
  uploaded: o.uploaded instanceof Date ? o.uploaded : new Date(),
  contentType: o.httpMetadata?.contentType ?? null,
});

/** Cloudflare R2 through a Worker binding. */
export function r2Store(bucket: R2Bucket): ObjectStore {
  return {
    async put(key, body, opts) {
      let value: Uint8Array | ReadableStream<Uint8Array> = body;
      // R2 needs a stream's length up front; FixedLengthStream also errors if the length is wrong.
      if (
        body instanceof ReadableStream &&
        opts.length !== undefined &&
        typeof FixedLengthStream !== 'undefined'
      ) {
        const fixed = new FixedLengthStream(opts.length);
        body.pipeTo(fixed.writable).catch(() => undefined);
        value = fixed.readable;
      }
      const o = await bucket.put(key, value, {
        httpMetadata: {
          contentType: opts.contentType,
          ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
        },
      });
      if (!o) throw new Error('object store: put refused');
      return meta(o);
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o || !('body' in o)) return null;
      return { ...meta(o), body: o.body, bytes: async () => new Uint8Array(await o.arrayBuffer()) };
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? meta(o) : null;
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
    async list(prefix, opts = {}) {
      const r = await bucket.list({
        prefix,
        limit: opts.limit ?? 1000,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      });
      return { objects: r.objects.map(meta), cursor: r.truncated ? (r.cursor ?? null) : null };
    },
  };
}

export type BucketName = 'photos' | 'shared';
/** The stores phase 5 uses: `photos` (zephyr-photos, members' files) and `shared` (zephyr-shared, guest renditions and branding). */
export function stores(env: Env): Record<BucketName, ObjectStore> {
  return { photos: r2Store(env.PHOTOS), shared: r2Store(env.SHARED) };
}

/** Deletes keys in batches of 1,000. */
export async function deleteAll(store: ObjectStore, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += 1000) await store.delete(keys.slice(i, i + 1000));
  return keys.length;
}

/** Deletes up to `maxPages` × 1,000 objects under a prefix. `complete` once nothing is left. */
export async function deleteUnder(
  store: ObjectStore,
  prefix: string,
  maxPages: number,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await store.list(prefix, { limit: 1000 });
    if (listed.objects.length === 0) return { deleted, complete: true };
    deleted += await deleteAll(
      store,
      listed.objects.map((o) => o.key),
    );
  }
  return { deleted, complete: (await store.list(prefix, { limit: 1 })).objects.length === 0 };
}

/** A random 128-bit nonce as 32 lower-case hex characters (object keys end in one). */
export const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Reads a shared object through the media host, so it passes Cloudflare's cache (and its CSAM Scanning
 * Tool). The host is closed to everyone but this Worker by a WAF rule on the X-Zephyr-Media header.
 * Returns the response as is: callers handle 451 (blocked by Cloudflare) and other failures.
 */
export function fetchCached(env: Env, key: string): Promise<Response> {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return fetch(`https://${env.MEDIA_HOST}/${path}`, {
    headers: { 'X-Zephyr-Media': env.MEDIA_HOST_SECRET },
    // Never follow a redirect off the media host.
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
}
