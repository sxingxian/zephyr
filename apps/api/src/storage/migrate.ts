/**
 * The storage migration pipeline (docs/phase-8.md › Migration). A photo moves as one unit: every object
 * under `u/<owner>/p/<photo>/` is streamed from the old store into the new one with its SHA-256 computed on
 * the way, read back from the new store and hashed again, and only when every object matches is the item
 * marked verified (which flips `photos.store_id` in the database, under the photo's row lock).
 *
 * - Queue `zephyr-storage`: each message says "claim and copy the next batch of this migration" (20 photos,
 *   leased by storage_migration_batch). A full batch enqueues the next one.
 * - Failures go back to pending with a backoff; the fifth becomes `failed` (shown in Admin, retryable).
 * - The 5-minute cron re-enqueues a batch for a migration that's copying (expired leases are reclaimed by the
 *   database) and deletes old copies once storage_old_copies_due says the hold has passed. Before deleting,
 *   any object that reached the old store after the copy (a late write during the flip) is copied over too.
 *
 * Nothing here logs keys, endpoints or error bodies: only store ids and short StoreError codes.
 */
import type { Env, StorageMessage } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';
import { photoStore } from './config';
import { digestOf, hashing } from './hash';
import type { ObjectStore } from './types';
import { StoreError } from './types';

/** The queue's name in wrangler.jsonc (its DLQ: zephyr-storage-dlq). */
export const STORAGE_QUEUE_NAME = 'zephyr-storage';

export const MIGRATION_LIMITS = {
  /** Photos claimed per queue message. */
  batch: 20,
  /** Attempts before an item becomes `failed`. */
  attempts: 5,
  /** Backoff before attempt n+1: base × 2^n seconds, capped. */
  backoffBaseS: 30,
  backoffMaxS: 3600,
  /** Old-copy deletions per cron run. */
  oldCopies: 50,
  /** Re-lists of the source prefix to pick up objects written while a photo was being copied. */
  passes: 3,
} as const;

export interface MigrationItem {
  photoId: string;
  ownerId: string;
  from: string;
  to: string;
  attempts: number;
}
export interface OldCopyItem {
  migrationId: string;
  photoId: string;
  ownerId: string;
  from: string;
  to: string;
}
type ItemState = 'verified' | 'failed' | 'pending' | 'deleted';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const photoPrefix = (ownerId: string, photoId: string) => `u/${ownerId}/p/${photoId}/`;

const codeOf = (err: unknown) => (err instanceof StoreError ? err.code : 'error');

export const backoffSeconds = (attempts: number) =>
  Math.min(MIGRATION_LIMITS.backoffMaxS, MIGRATION_LIMITS.backoffBaseS * 2 ** Math.max(0, attempts));

async function listAll(store: ObjectStore, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { objects: { key: string }[]; cursor: string | null } = await store.list(prefix, {
      cursor,
      limit: 1000,
    });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

/**
 * Streams one object from `from` into `to`, hashing on the way, then reads the copy back and compares.
 * Returns the bytes copied, or 0 if the source object is gone (deleted while the photo was moving).
 */
export async function copyVerified(from: ObjectStore, to: ObjectStore, key: string): Promise<number> {
  const src = await from.get(key);
  if (!src) return 0;
  const { stream, result } = hashing(src.body);
  await to.put(key, stream, { contentType: src.contentType ?? 'application/octet-stream', length: src.size });
  const source = await result;
  if (source.bytes !== src.size) throw new StoreError('source_size');
  const back = await to.get(key);
  if (!back) throw new StoreError('verify_missing');
  const copy = await digestOf(back.body);
  if (copy.bytes !== source.bytes) throw new StoreError('verify_size');
  if (copy.digest !== source.digest) throw new StoreError('hash_mismatch');
  return source.bytes;
}

/** Copies and verifies every object of one photo. Re-lists until a pass finds nothing new. */
export async function copyPhoto(env: Env, item: MigrationItem): Promise<number> {
  const from = photoStore(env, item.from);
  const to = photoStore(env, item.to);
  const prefix = photoPrefix(item.ownerId, item.photoId);
  const done = new Set<string>();
  let bytes = 0;
  for (let pass = 0; pass < MIGRATION_LIMITS.passes; pass++) {
    const fresh = (await listAll(from, prefix)).filter((k) => !done.has(k));
    if (!fresh.length) break;
    for (const key of fresh) {
      bytes += await copyVerified(from, to, key);
      done.add(key);
    }
  }
  return bytes;
}

async function mark(
  env: Env,
  migration: string,
  photo: string,
  state: ItemState,
  bytes: number,
  error: string | null,
  retryAfterS: number | null = null,
) {
  await rpc(env, 'storage_item_mark', {
    p_migration: migration,
    p_photo: photo,
    p_state: state,
    p_bytes: bytes,
    p_error: error,
    p_retry_after_s: retryAfterS,
  });
}

/** One item, end to end: verified, back to pending with a backoff, or failed after the last attempt. */
export async function migrateItem(env: Env, migration: string, item: MigrationItem): Promise<ItemState> {
  try {
    const bytes = await copyPhoto(env, item);
    await mark(env, migration, item.photoId, 'verified', bytes, null);
    return 'verified';
  } catch (err) {
    const code = codeOf(err);
    logError('storage', `migrate_item ${item.from}->${item.to}`, err);
    const attempts = (Number.isInteger(item.attempts) ? item.attempts : 0) + 1;
    if (attempts >= MIGRATION_LIMITS.attempts) {
      await mark(env, migration, item.photoId, 'failed', 0, code);
      return 'failed';
    }
    await mark(env, migration, item.photoId, 'pending', 0, code, backoffSeconds(attempts));
    return 'pending';
  }
}

/** Claims and copies one batch. Returns how many items it claimed (a full batch means there may be more). */
export async function runMigrationBatch(env: Env, migration: string): Promise<number> {
  if (!UUID.test(migration)) return 0;
  const items = await rpc<MigrationItem[]>(env, 'storage_migration_batch', {
    p_migration: migration,
    p_limit: MIGRATION_LIMITS.batch,
  });
  for (const item of items ?? []) await migrateItem(env, migration, item);
  if ((items ?? []).length >= MIGRATION_LIMITS.batch) {
    await env.STORAGE_QUEUE.send({ t: 'migrate', migration });
  }
  return (items ?? []).length;
}

/** The zephyr-storage queue consumer. A batch that can't reach the database is retried by the queue. */
export async function handleStorageBatch(batch: MessageBatch<StorageMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body as Partial<StorageMessage> | null;
    if (body?.t !== 'migrate' || typeof body.migration !== 'string') {
      msg.ack();
      continue;
    }
    try {
      await runMigrationBatch(env, body.migration);
      msg.ack();
    } catch (err) {
      logError('storage', 'migrate_batch', err);
      msg.retry({ delaySeconds: 60 });
    }
  }
}

/**
 * Deletes the old copy of one photo. Every object on the old store is first checked on the new one; one
 * that's missing there (written to the old store during the flip) is copied and verified before anything
 * is deleted.
 */
export async function deleteOldCopy(env: Env, item: OldCopyItem): Promise<number> {
  const from = photoStore(env, item.from);
  const to = photoStore(env, item.to);
  if (from.id === to.id) return 0;
  const keys = await listAll(from, photoPrefix(item.ownerId, item.photoId));
  for (const key of keys) {
    const there = await to.head(key);
    if (!there) await copyVerified(from, to, key);
  }
  for (let i = 0; i < keys.length; i += 1000) await from.delete(keys.slice(i, i + 1000));
  return keys.length;
}

/** The 5-minute cron's migration part: keep a copying migration moving, and delete old copies once due. */
export async function runMigrationCron(env: Env): Promise<{ enqueued: boolean; oldCopiesDeleted: number }> {
  let enqueued = false;
  try {
    const status = await rpc<{ migration: { id: string; state: string } | null } | null>(
      env,
      'storage_status',
    );
    const m = status?.migration;
    if (m && (m.state === 'copying' || m.state === 'rolling_back')) {
      await env.STORAGE_QUEUE.send({ t: 'migrate', migration: m.id });
      enqueued = true;
    }
  } catch (err) {
    logError('cron', 'storage_reenqueue', err);
  }
  let oldCopiesDeleted = 0;
  try {
    const due = await rpc<OldCopyItem[]>(env, 'storage_old_copies_due', {
      p_limit: MIGRATION_LIMITS.oldCopies,
    });
    for (const item of due ?? []) {
      try {
        const n = await deleteOldCopy(env, item);
        await mark(env, item.migrationId, item.photoId, 'deleted', 0, null);
        oldCopiesDeleted += n;
      } catch (err) {
        logError('cron', `storage_old_copy ${item.from}`, err);
      }
    }
  } catch (err) {
    logError('cron', 'storage_old_copies', err);
  }
  return { enqueued, oldCopiesDeleted };
}
