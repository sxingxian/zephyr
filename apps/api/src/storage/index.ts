/**
 * The object-storage seam (phase 5, extended in phase 8). Nothing outside src/storage/ touches a bucket
 * binding: the photo library goes through `photoStore(env, storeId)` (whichever store the photo lives on,
 * R2 or an S3-compatible service), and the two buckets that always stay on R2 through `stores(env)`:
 *
 * - `shared` (zephyr-shared): guest renditions and branding, read through the media host's cache, where
 *   Cloudflare's CSAM Scanning Tool sees them.
 * - `galleryRenders` (zephyr-photos, `u/<owner>/g/…`): full-size gallery renders. They're derived files the
 *   share pipeline can rebuild, so they don't move with a storage switch.
 *
 * The one provider-specific read path is `fetchCached`: guest renditions are read through the media host
 * (an R2 custom domain behind Cloudflare's cache). The host is closed to everyone but this Worker by a WAF
 * rule on the X-Zephyr-Media header.
 */
import type { Env } from '../env';
import { allStores } from './config';
import { r2Store } from './r2';
import type { ObjectStore } from './types';

export { allStores, photoStore, storeConfigs, storeFor, storeIdOf } from './config';
export { r2Store } from './r2';
export type { ByteRange, CompletedPart, ObjectBody, ObjectStore, PutOptions, StoredObject } from './types';
export { StoreError } from './types';

export type BucketName = 'galleryRenders' | 'shared';
/** The stores that always stay on R2 (see above). The photo library uses `photoStore` instead. */
export function stores(env: Env): Record<BucketName, ObjectStore> {
  return { galleryRenders: r2Store(env.PHOTOS, 'r2'), shared: r2Store(env.SHARED, 'shared') };
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

/**
 * Deletes photo-library keys on every configured store. For keys handed back by the database without a
 * store (edit reverts, replaced variants, dropped masks): a photo may be mid-move, with a copy on both
 * stores, and deleting a missing key is a no-op. Throws the first store error after trying them all.
 */
export async function deleteEverywhere(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { stores: all } = allStores(env);
  let first: unknown = null;
  for (const store of all) {
    try {
      await deleteAll(store, keys);
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
}

/** A random 128-bit nonce as 32 lower-case hex characters (object keys end in one). */
export const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Reads a shared object through the media host, so it passes Cloudflare's cache (and its CSAM Scanning
 * Tool). Returns the response as is: callers handle 451 (blocked by Cloudflare) and other failures.
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
