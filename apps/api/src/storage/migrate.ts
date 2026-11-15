/**
 * The storage migration pipeline (docs/phase-8.md › Migration). A photo moves as one unit: every object
 * under `u/<owner>/p/<photo>/` is streamed from the old store into the new one with its SHA-256 computed on
 * the way, read back from the new store and hashed again, and only when every object matches is the item
 * marked verified (which flips `photos.store_id` in the database, under the photo's row lock).
 *
 * - Queue `zephyr-storage`: each message says "claim and copy the next batch of this migration" (20 photos,
 *   leased by storage_migration_batch, each with its own token). A full batch enqueues the next one. Each item's
 *   lease is renewed (storage_item_touch) just before it's copied, and only the holder of the current token can
 *   report it, so a slow consumer whose lease was taken over can't flip a photo.
 * - A copy counts only if it includes every key the database records for the photo (the original, its
 *   variants, edited variants and masks) and weighs at least the original.
 * - Failures go back to pending with a backoff; the fifth attempt becomes `failed` (shown in Admin, retryable).
 * - The 5-minute cron re-enqueues a batch for a migration that's copying, rolling back, verifying or holding
 *   (expired leases are reclaimed; late arrivals are queued) and deletes old copies once
 *   storage_old_copies_due says the hold has passed. Each deletion is claimed first (from then on the move
 *   can't be rolled back); for a photo that moved, any object missing on its store is copied there first.
 * - Writers that store an object under a photo's prefix call `followMove` after recording it, so an object
 *   written to the old store while the photo was being flipped ends up on the new store too. A copy that fails
 *   is recorded (storage_followups) and retried by the 5-minute cron (for at most 7 days); until then the orphan
 *   sweep leaves copies away from their photo's store alone. A writer that can't tell whether its record
 *   committed records the follow-up anyway (followUnknown), and a retried write that finds its object recorded
 *   makes sure it followed (followRecorded).
 *
 * Nothing here logs keys, endpoints or error bodies: only store ids and short StoreError codes.
 */
import type { Env, StorageMessage } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';
import { allStores, photoStore } from './config';
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
  /** Follow-up copies per cron run. */
  followups: 50,
  /** Re-lists of the source prefix to pick up objects written while a photo was being copied. */
  passes: 3,
} as const;

export interface MigrationItem {
  photoId: string;
  ownerId: string;
  from: string;
  to: string;
  /** This claim's attempt number (1 on the first claim). */
  attempts: number;
  /** The lease's token: reports without it are refused. */
  token: string;
}
/** storage_item_touch: what the copy must include. */
export interface ItemLease {
  keys: string[];
  minBytes: number;
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
 * Returns the bytes copied, or null if the source object is gone (deleted while the photo was moving).
 */
export async function copyVerified(from: ObjectStore, to: ObjectStore, key: string): Promise<number | null> {
  const src = await from.get(key);
  if (!src) return null;
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

/**
 * After copying `keys` to `to` for a photo (a copy forward: old-copy deletion, a follow-up, followMove, the orphan
 * sweep's rescue), the photo's store is read again, because a purge (or a move) can run between reading where the
 * photo is and finishing the copy. 'ok': still there. 'gone': the photo is gone or being purged, so the copy just
 * made is deleted again (nothing points at it, and the sweep could take months to reach it). 'moved': the photo
 * is on another store now; the copy is kept (the move may already have listed it), and the caller must not treat
 * the object as safely at its photo's store. Throws when the photo's store can't be read: the caller keeps
 * everything and tries again later.
 */
export async function afterCopy(
  env: Env,
  photoId: string,
  to: ObjectStore,
  keys: string[],
): Promise<'ok' | 'gone' | 'moved'> {
  const now = await rpc<string | null>(env, 'storage_photo_store', { p_photo: photoId });
  if (now === to.id) return 'ok';
  if (now) return 'moved';
  for (let i = 0; i < keys.length; i += 1000) await to.delete(keys.slice(i, i + 1000));
  return 'gone';
}

/**
 * Copies and verifies every object of one photo. Re-lists until a pass finds nothing new. Throws
 * `source_incomplete` unless the original was copied from the source, every other key in `lease.keys` was
 * copied or is already on the destination (an object a writer stored on the old store whose follow-up copy
 * hadn't reached the new one, met again by a rollback; keys never change content), and the copy weighs at
 * least `lease.minBytes`: an empty or partial listing never counts as a copy.
 */
export async function copyPhoto(env: Env, item: MigrationItem, lease: ItemLease): Promise<number> {
  const from = photoStore(env, item.from);
  const to = photoStore(env, item.to);
  const prefix = photoPrefix(item.ownerId, item.photoId);
  const done = new Set<string>();
  let bytes = 0;
  for (let pass = 0; pass < MIGRATION_LIMITS.passes; pass++) {
    const fresh = (await listAll(from, prefix)).filter((k) => !done.has(k));
    if (!fresh.length) break;
    for (const key of fresh) {
      const n = await copyVerified(from, to, key);
      if (n === null) continue;
      bytes += n;
      done.add(key);
    }
  }
  const original = `${prefix}original`;
  if (!done.has(original)) throw new StoreError('source_incomplete');
  const required = new Set([original, ...lease.keys.filter((k) => k.startsWith(prefix))]);
  for (const key of required) {
    if (done.has(key)) continue;
    const there = await to.head(key);
    if (!there) throw new StoreError('source_incomplete');
    bytes += there.size;
    done.add(key);
  }
  if (bytes <= 0 || bytes < lease.minBytes) throw new StoreError('source_incomplete');
  return bytes;
}

async function mark(
  env: Env,
  migration: string,
  photo: string,
  state: ItemState,
  bytes: number,
  error: string | null,
  extra: { retryAfterS?: number | null; token?: string | null; store?: string | null } = {},
) {
  await rpc(env, 'storage_item_mark', {
    p_migration: migration,
    p_photo: photo,
    p_state: state,
    p_bytes: bytes,
    p_error: error,
    p_retry_after_s: extra.retryAfterS ?? null,
    p_token: extra.token ?? null,
    p_store: extra.store ?? null,
  });
}

/**
 * One item, end to end: renew its lease, copy, then verified, back to pending with a backoff, or failed on
 * the last attempt. 'skipped' when the lease was taken over (or the item was rolled back) before it started.
 */
export async function migrateItem(
  env: Env,
  migration: string,
  item: MigrationItem,
): Promise<ItemState | 'skipped'> {
  const lease = await rpc<ItemLease | null>(env, 'storage_item_touch', {
    p_migration: migration,
    p_photo: item.photoId,
    p_token: item.token,
  });
  if (!lease) return 'skipped';
  try {
    const bytes = await copyPhoto(env, item, lease);
    await mark(env, migration, item.photoId, 'verified', bytes, null, { token: item.token });
    return 'verified';
  } catch (err) {
    const code = codeOf(err);
    logError('storage', `migrate_item ${item.from}->${item.to}`, err);
    // The claim already counted this attempt.
    const attempts = Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 1;
    if (attempts >= MIGRATION_LIMITS.attempts) {
      await mark(env, migration, item.photoId, 'failed', 0, code, { token: item.token });
      return 'failed';
    }
    await mark(env, migration, item.photoId, 'pending', 0, code, {
      token: item.token,
      retryAfterS: backoffSeconds(attempts),
    });
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
 * Deletes the old copy of one photo, once storage_old_copy_claim has claimed it (which also re-checks that
 * the photo isn't on that store now). For a photo that moved and still exists (`copyTo`), every object on the
 * old store is first checked on the photo's store; one that's missing there is copied and verified before
 * anything is deleted. A photo that's gone, or a partial copy that was never used, is just deleted: nothing is
 * copied back. Returns how many objects were deleted, or null when the copy wasn't due any more.
 */
export async function deleteOldCopy(env: Env, item: OldCopyItem): Promise<number | null> {
  const claim = await rpc<{ copyTo: string | null } | null>(env, 'storage_old_copy_claim', {
    p_migration: item.migrationId,
    p_photo: item.photoId,
    p_store: item.from,
  });
  if (!claim) return null;
  const from = photoStore(env, item.from);
  const keys = await listAll(from, photoPrefix(item.ownerId, item.photoId));
  if (claim.copyTo && claim.copyTo !== item.from) {
    const to = photoStore(env, claim.copyTo);
    const copied: string[] = [];
    for (const key of keys) {
      const there = await to.head(key);
      if (!there && (await copyVerified(from, to, key)) !== null) copied.push(key);
    }
    // A photo purged while this ran: what was just copied goes again (the old copy goes below). A photo that
    // moved meanwhile (it can't while old copies wait, but never assume): keep the old copy and retry later.
    if (copied.length && (await afterCopy(env, item.photoId, to, copied)) === 'moved') {
      throw new StoreError('photo_moved');
    }
  }
  for (let i = 0; i < keys.length; i += 1000) await from.delete(keys.slice(i, i + 1000));
  return keys.length;
}

/**
 * After a writer recorded an object it stored under a photo's prefix on `wrote` (the store it read before
 * writing): if the photo has moved since, the object is copied to the photo's store now. The flip and the
 * record are serialised by the photo's row, and the record changes the photo's stamp, so either the copy that
 * was being made is refused (and redone with this object), or the photo had already moved and this copies the
 * object after it. The copy is recorded as a follow-up first and cleared once it's done, so a copy that fails
 * (or a Worker that stops half-way) is retried by the cron. If the photo's store can't even be read, the
 * follow-up is recorded anyway: the cron works out where the photo is.
 */
export async function followMove(env: Env, photoId: string, wrote: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  let now: string | null;
  try {
    now = await rpc<string | null>(env, 'storage_photo_store', { p_photo: photoId });
  } catch (err) {
    logError('storage', 'follow_move_store', err);
    await recordFollowup(env, photoId, wrote, keys);
    return;
  }
  if (!now || now === wrote) return;
  const recorded = await recordFollowup(env, photoId, wrote, keys);
  try {
    const from = photoStore(env, wrote);
    const to = photoStore(env, now);
    const copied: string[] = [];
    for (const key of keys) if ((await copyVerified(from, to, key)) !== null) copied.push(key);
    if (copied.length) {
      const after = await afterCopy(env, photoId, to, copied);
      // Moved again meanwhile: the follow-up stays, and the cron copies the object to wherever it is then.
      if (after === 'moved') return;
      // Purged meanwhile: what this request wrote on the old store is garbage too.
      if (after === 'gone') await from.delete(keys);
    }
  } catch (err) {
    logError('storage', 'follow_move', err);
    return;
  }
  if (recorded) for (const key of keys) await followupDone(env, photoId, key, wrote, true);
}

/**
 * A writer stored `keys` on `wrote` but doesn't know whether its record committed (the call threw, or its reply
 * was lost). The keys are recorded as follow-ups anyway: the cron copies them to the photo's store if the photo
 * moved meanwhile, and clears them when there's nothing to copy (same store, photo gone, object gone). A copy of
 * an object that was never recorded is an orphan on the new store, which the sweep removes. Never throws.
 */
export async function followUnknown(env: Env, photoId: string, wrote: string, keys: string[]): Promise<void> {
  if (keys.length) await recordFollowup(env, photoId, wrote, keys);
}

/**
 * An object is recorded for the photo, but this request didn't write it (a retried PUT that finds its variant
 * recorded by an earlier attempt whose reply was lost): if the photo's store doesn't have it, it's copied there
 * from whichever configured store does, through a follow-up. Best effort; never throws.
 */
export async function followRecorded(env: Env, photoId: string, key: string): Promise<void> {
  try {
    const now = await rpc<string | null>(env, 'storage_photo_store', { p_photo: photoId });
    if (!now) return;
    if (await photoStore(env, now).head(key)) return;
    for (const store of allStores(env).stores) {
      if (store.id === now) continue;
      if (!(await store.head(key))) continue;
      await followMove(env, photoId, store.id, [key]);
      return;
    }
  } catch (err) {
    logError('storage', 'follow_recorded', err);
  }
}

async function recordFollowup(env: Env, photoId: string, from: string, keys: string[]): Promise<boolean> {
  try {
    for (let i = 0; i < keys.length; i += 20) {
      await rpc(env, 'storage_followup_add', {
        p_photo: photoId,
        p_from: from,
        p_keys: keys.slice(i, i + 20),
      });
    }
    return true;
  } catch (err) {
    logError('storage', 'follow_move_record', err);
    return false;
  }
}

async function followupDone(
  env: Env,
  photoId: string,
  key: string,
  from: string,
  ok: boolean,
): Promise<void> {
  try {
    await rpc(env, 'storage_followup_done', { p_photo: photoId, p_key: key, p_from: from, p_ok: ok });
  } catch (err) {
    // Listed again later: a copy that's already there is just cleared then.
    logError('storage', 'follow_move_done', err);
  }
}

export interface FollowupItem {
  photoId: string;
  key: string;
  from: string;
  /** The photo's store now, or null once it's gone. */
  to: string | null;
}

/**
 * Retries follow-up copies: each object goes from the store it was written to to wherever its photo is now
 * (unless it's already there, or the photo is gone or back on that store). Follow-ups older than 7 days are
 * dropped (a store that's gone for good would otherwise keep the orphan sweep off for ever). Returns how many
 * were copied.
 */
export async function runFollowups(env: Env): Promise<number> {
  // Follow-ups older than 7 days are dropped first (audited; Admin › Storage shows the count).
  try {
    await rpc<number>(env, 'storage_followups_expire');
  } catch (err) {
    logError('cron', 'storage_followups_expire', err);
  }
  const due = await rpc<FollowupItem[]>(env, 'storage_followups_due', {
    p_limit: MIGRATION_LIMITS.followups,
  });
  let copied = 0;
  for (const item of due ?? []) {
    try {
      const from = photoStore(env, item.from);
      if (!item.to) {
        // The photo is gone (or being purged): the object it left on the old store goes now, not whenever the
        // sweep's cursor reaches it.
        await from.delete([item.key]);
      } else if (item.to !== item.from) {
        const to = photoStore(env, item.to);
        if (!(await to.head(item.key))) {
          const n = await copyVerified(from, to, item.key);
          if (n !== null) {
            const after = await afterCopy(env, item.photoId, to, [item.key]);
            if (after === 'moved') {
              // Listed again with the photo's new store, after the usual backoff.
              await followupDone(env, item.photoId, item.key, item.from, false);
              continue;
            }
            if (after === 'gone') await from.delete([item.key]);
            else copied++;
          }
        }
      }
      await followupDone(env, item.photoId, item.key, item.from, true);
    } catch (err) {
      logError('cron', `storage_followup ${item.from}`, err);
      await followupDone(env, item.photoId, item.key, item.from, false);
    }
  }
  return copied;
}

/** The 5-minute cron's migration part: keep a migration moving, delete old copies once due, retry follow-ups. */
export async function runMigrationCron(
  env: Env,
): Promise<{ enqueued: boolean; oldCopiesDeleted: number; followupsCopied: number }> {
  let enqueued = false;
  try {
    const status = await rpc<{ migration: { id: string; state: string } | null } | null>(
      env,
      'storage_status',
    );
    const m = status?.migration;
    // Holding and verifying migrations get a batch too: it queues late arrivals (at most every 2 minutes).
    if (m && ['copying', 'rolling_back', 'verifying', 'holding'].includes(m.state)) {
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
        if (n === null) continue;
        await mark(env, item.migrationId, item.photoId, 'deleted', 0, null, { store: item.from });
        oldCopiesDeleted += n;
      } catch (err) {
        logError('cron', `storage_old_copy ${item.from}`, err);
      }
    }
  } catch (err) {
    logError('cron', 'storage_old_copies', err);
  }
  let followupsCopied = 0;
  try {
    followupsCopied = await runFollowups(env);
  } catch (err) {
    logError('cron', 'storage_followups', err);
  }
  return { enqueued, oldCopiesDeleted, followupsCopied };
}
