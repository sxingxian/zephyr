/**
 * Clean-up jobs, run by the Cron Trigger every 15 minutes (docs/phase-3.md, Clean-up jobs). Each step
 * does a bounded amount of work, deletes R2 objects before the rows that account for them, and is safe
 * to repeat. One audit row per run that did something, with counts only.
 */
import { gotrue } from './auth/gotrue';
import { cancelForPurge } from './billing/deletion';
import { sendEmail } from './email/resend';
import { galleryExpiringEmail, safetyReportEmail } from './email/share-templates';
import type { Env } from './env';
import { logError } from './http';
import {
  deleteKeys,
  deletePrefix,
  isNonCanonicalPhotoKey,
  LIBRARY_LIMITS,
  type PurgeItem,
  parseKey,
  photoKey,
  stagingKey,
} from './library/storage';
import { deleteAll, deleteUnder, stores } from './storage';
import { allStores, photoStore, storeIdOf } from './storage/config';
import type { ObjectStore } from './storage/types';
import { rpc } from './supabase';

export const JOB_LIMITS = {
  expiredUploads: 200,
  publishes: 100,
  photoPurges: 300,
  accountPurges: 5,
  /** 1,000-key list-and-delete rounds per account per run; the rest continues next run. */
  pagesPerAccount: 10,
  /** Objects the orphan sweep looks at per run (one R2 list page; the cursor carries over). */
  sweepPage: 1000,
  /** Galleries per sharing clean-up step, and queued object deletions per run. */
  shareCleanup: 100,
  shareDeletions: 500,
  /** Galleries with unalerted CSAM reports emailed per run. */
  safetyAlerts: 20,
} as const;

export interface CleanupCounts {
  uploadsAborted: number;
  photosPurged: number;
  accountsPurged: number;
  objectsDeleted: number;
  orphansDeleted: number;
  variantsPublished: number;
  variantsLost: number;
  rateLimitRows: number;
  galleryRenditionsPurged: number;
  galleriesDeleted: number;
  shareObjectsDeleted: number;
  expiryReminders: number;
  safetyAlerts: number;
}

interface ExpiredUpload {
  uploadId: string;
  r2Key: string;
  r2UploadId: string | null;
  keys: string[];
  storeId?: string | null;
}
interface DueAccount {
  ownerId: string;
  prefix: string;
  stagingPrefix: string;
  /** Phase 5: guest renditions and branding in zephyr-shared. */
  sharedPrefix?: string;
  uploads: { r2Key: string; r2UploadId: string; storeId?: string | null }[];
  /** Phase 7: the subscription to cancel before the account goes (when the database gives it). */
  stripeSubscriptionId?: string | null;
}

async function abortMultipart(env: Env, storeId: string, key: string, uploadId: string) {
  try {
    await photoStore(env, storeId).abortMultipart(key, uploadId);
  } catch {
    /* already aborted or completed */
  }
}

/** Groups rows by their store ('r2' when the database row has none). */
function byStore<T extends { storeId?: string | null }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const id = storeIdOf(r);
    out.set(id, [...(out.get(id) ?? []), r]);
  }
  return out;
}

export async function runCleanup(env: Env, requestId = 'cron'): Promise<CleanupCounts> {
  const counts: CleanupCounts = {
    uploadsAborted: 0,
    photosPurged: 0,
    accountsPurged: 0,
    objectsDeleted: 0,
    orphansDeleted: 0,
    variantsPublished: 0,
    variantsLost: 0,
    rateLimitRows: 0,
    galleryRenditionsPurged: 0,
    galleriesDeleted: 0,
    shareObjectsDeleted: 0,
    expiryReminders: 0,
    safetyAlerts: 0,
  };

  // 1. Uploads left unfinished for 24 hours. The database claims them first (rows and reservation go
  // under the owner's lock, so a racing complete either finished before or finds nothing); only then are
  // the R2 upload aborted and its objects deleted. Leftovers: orphan sweep (u/) and lifecycle (staging/).
  try {
    const due = await rpc<ExpiredUpload[]>(env, 'due_expired_uploads', {
      p_limit: JOB_LIMITS.expiredUploads,
    });
    counts.uploadsAborted = due.length;
    for (const u of due) if (u.r2UploadId) await abortMultipart(env, storeIdOf(u), u.r2Key, u.r2UploadId);
    for (const [id, group] of byStore(due)) {
      counts.objectsDeleted += await deleteKeys(
        photoStore(env, id),
        group.flatMap((u) => u.keys),
      );
    }
  } catch (err) {
    logError(requestId, 'job_expired_uploads', err);
  }

  // 2. Trash past its 30 days (and anything left purging): delete objects, then rows and usage.
  try {
    // Each photo's keys on its own store; a store that fails leaves only its photos for the next run.
    const due = await rpc<PurgeItem[]>(env, 'due_photo_purges', { p_limit: JOB_LIMITS.photoPurges });
    const done: string[] = [];
    for (const [id, group] of byStore(due)) {
      try {
        counts.objectsDeleted += await deleteKeys(
          photoStore(env, id),
          group.flatMap((p) => p.keys),
        );
        done.push(...group.map((p) => p.photoId));
      } catch (err) {
        logError(requestId, 'job_photo_purge_store', err);
      }
    }
    if (done.length) counts.photosPurged = await rpc<number>(env, 'confirm_photo_purges', { p_ids: done });
  } catch (err) {
    logError(requestId, 'job_photo_purges', err);
  }

  // 3. Accounts past their deletion date: every object under u/<id>/, then the Auth user (cascades).
  try {
    const due = await rpc<DueAccount[]>(env, 'due_account_purges', { p_limit: JOB_LIMITS.accountPurges });
    for (const a of due) {
      try {
        for (const u of a.uploads) await abortMultipart(env, storeIdOf(u), u.r2Key, u.r2UploadId);
        // Phase 8: the owner's prefixes on every configured store, so nothing is left on a store the
        // library moved away from. A store that can't be built (missing secret) keeps the account waiting.
        const { stores: all, broken } = allStores(env);
        const res = { deleted: 0, complete: broken.length === 0 };
        if (broken.length) logError(requestId, 'job_account_purge_store', new Error('store_unavailable'));
        for (const store of all) {
          for (const prefix of [a.prefix, a.stagingPrefix]) {
            const r = await deletePrefix(store, prefix, JOB_LIMITS.pagesPerAccount);
            res.deleted += r.deleted;
            res.complete &&= r.complete;
          }
        }
        if (a.sharedPrefix) {
          const r = await deleteUnder(stores(env).shared, a.sharedPrefix, JOB_LIMITS.pagesPerAccount);
          res.deleted += r.deleted;
          res.complete &&= r.complete;
        }
        counts.objectsDeleted += res.deleted;
        if (!res.complete) {
          // More objects than one run allows: progress, not a failure, so no hour's backoff.
          if (res.deleted > 0) await rpc(env, 'account_purge_progress', { p_owner: a.ownerId });
          continue;
        }
        // Phase 7: never delete an account Stripe would keep billing. Throws if Stripe can't be reached,
        // so the account waits for the next run.
        await cancelForPurge(env, a.ownerId, a);
        await gotrue.adminDeleteUser(env, a.ownerId);
        counts.accountsPurged += 1;
      } catch (err) {
        logError(requestId, 'job_account_purge', err);
      }
    }
  } catch (err) {
    logError(requestId, 'job_account_purges', err);
  }

  // 4. Variants counted but not confirmed copied from staging (the complete request failed midway).
  try {
    const r = await retryPublishes(env);
    counts.variantsPublished = r.published;
    counts.variantsLost = r.lost;
  } catch (err) {
    logError(requestId, 'job_publishes', err);
  }

  // 5. Orphan sweep: one page of photo keys per run, resuming from the stored cursor.
  try {
    counts.orphansDeleted = await sweepOrphans(env);
  } catch (err) {
    logError(requestId, 'job_orphan_sweep', err);
  }

  // 6. Sharing: renditions of ended galleries, gallery data 30 days after the end, old attempts and events,
  // expiry reminders (each sent once: the database marks it before returning it).
  try {
    const r = await shareCleanup(env, requestId);
    counts.galleryRenditionsPurged = r.purged;
    counts.galleriesDeleted = r.deleted;
    counts.expiryReminders = r.reminders;
  } catch (err) {
    logError(requestId, 'job_share_cleanup', err);
  }

  // 7. Queued share-object deletions (renditions, renders and branding assets whose rows went, and prefixes
  // of deleted galleries). Objects first, then the queue rows; a failure leaves them for the next run.
  try {
    counts.shareObjectsDeleted = await drainShareDeletions(env, requestId);
  } catch (err) {
    logError(requestId, 'job_share_deletions', err);
  }

  // 8. CSAM reports no alert email has covered (inside a gallery's hour, or the email failed).
  try {
    counts.safetyAlerts = await sweepSafetyAlerts(env, requestId);
  } catch (err) {
    logError(requestId, 'job_safety_alerts', err);
  }

  // 9. Old rate-limit rows (pg_cron does this daily too).
  try {
    counts.rateLimitRows = await rpc<number>(env, 'purge_rate_limits');
  } catch (err) {
    logError(requestId, 'job_rate_limits', err);
  }

  const { rateLimitRows: _routine, expiryReminders: _sent, ...library } = counts;
  if (Object.values(library).some((n) => n > 0)) {
    try {
      await rpc(env, 'record_cleanup', { p_details: counts });
    } catch (err) {
      logError(requestId, 'job_audit', err);
    }
  }
  return counts;
}

interface PendingPublish {
  photoId: string;
  ownerId: string;
  thumbBytes: number;
  previewBytes: number;
  storeId?: string | null;
}

/**
 * Finishes publishing photos left publish_pending: copies each counted variant from staging to the
 * photo's key when the staged copy has the counted size (or accepts a published copy that already does),
 * then confirms. A variant with neither is lost: finish_publish drops it and its bytes. A staged copy of
 * the wrong size (a late PUT not yet removed) is left for a later run. Staging copies of pending photos
 * are only deleted after the confirmation.
 */
export async function retryPublishes(env: Env): Promise<{ published: number; lost: number }> {
  const due = await rpc<PendingPublish[]>(env, 'due_publishes', { p_limit: JOB_LIMITS.publishes });
  let published = 0;
  let lost = 0;
  for (const p of due) {
    const store = photoStore(env, storeIdOf(p));
    const outcome: Record<'thumb' | 'preview', 'ok' | 'lost' | 'wait'> = { thumb: 'ok', preview: 'ok' };
    for (const kind of ['thumb', 'preview'] as const) {
      const counted = kind === 'thumb' ? p.thumbBytes : p.previewBytes;
      if (counted <= 0) continue;
      const staged = await store.get(stagingKey(p.ownerId, p.photoId, kind));
      if (staged && staged.size === counted) {
        const bytes = await staged.bytes();
        const type = staged.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
        await store.put(photoKey(p.ownerId, p.photoId, kind), bytes, { contentType: type });
        published += 1;
        continue;
      }
      if (staged) await staged.body.cancel().catch(() => undefined);
      const final = await store.head(photoKey(p.ownerId, p.photoId, kind));
      if (final && final.size === counted) continue;
      outcome[kind] = staged ? 'wait' : 'lost';
    }
    if (outcome.thumb === 'wait' || outcome.preview === 'wait') continue;
    await rpc(env, 'finish_publish', {
      p_owner: p.ownerId,
      p_photo: p.photoId,
      p_lost_thumb: outcome.thumb === 'lost',
      p_lost_preview: outcome.preview === 'lost',
    });
    lost += Number(outcome.thumb === 'lost') + Number(outcome.preview === 'lost');
    await deleteKeys(store, [
      stagingKey(p.ownerId, p.photoId, 'thumb'),
      stagingKey(p.ownerId, p.photoId, 'preview'),
    ]);
  }
  return { published, lost };
}

interface PhotoRowState {
  id: string;
  ownerId: string;
  status: 'uploading' | 'ready' | 'trashed' | 'purging';
  activeUpload: boolean;
  /** The edited-variant objects the photo's edit records (the only `edit-*` keys that count). */
  editThumbKey?: string | null;
  editPreviewKey?: string | null;
  /** Phase 6: the masks the photo's rows record (the only `m/` keys that count). */
  maskKeys?: string[];
  /** Phase 8: the store the photo lives on ('r2' until sweep_photo_rows returns it). */
  storeId?: string | null;
}

/** Migration states during which a photo can have a copy on a store other than its own. */
const MOVING = new Set(['copying', 'paused', 'verifying', 'holding', 'rolling_back', 'failed']);

/**
 * Deletes photo objects (`u/`) nothing accounts for: keys whose photo row is gone or belongs to someone
 * else, keys whose ids aren't spelled in canonical lower case, and, once they're over an hour old (a
 * write may be between storing the object and recording it), edited variants
 * (`edit-<version>-<kind>-<nonce>`) that aren't the object the photo's edit records and masks
 * (`m/<maskId>.png`) that no `photo_masks` row records. Keys of existing photos (including in-flight
 * uploads) and keys of any other shape are left alone; `staging/` isn't swept (an R2 lifecycle rule
 * empties it after 2 days).
 */
export async function sweepOrphans(env: Env, now = Date.now()): Promise<number> {
  // Phase 8: one page per configured store per run, each with its own cursor. A copy on a store other than
  // its photo's is left alone while a migration is moving photos (old copies are deleted only after the
  // verify-plus-hold, by the migration); with no migration under way it's a leftover and goes too.
  let moving = true;
  try {
    const status = await rpc<{ migration: { state: string } | null } | null>(env, 'storage_status');
    moving = !!status?.migration && MOVING.has(status.migration.state);
  } catch (err) {
    logError('cron', 'job_sweep_status', err);
  }
  const { stores: all } = allStores(env);
  let deleted = 0;
  for (const store of all) {
    try {
      deleted += await sweepStore(env, store, moving, now);
    } catch (err) {
      logError('cron', 'job_orphan_sweep_store', err);
    }
  }
  return deleted;
}

const cursorKey = (storeId: string) =>
  storeId === 'r2' ? 'orphan_sweep_cursor' : `orphan_sweep_cursor:${storeId}`;

async function sweepStore(env: Env, store: ObjectStore, moving: boolean, now: number): Promise<number> {
  const key = cursorKey(store.id);
  const cursor = await rpc<string | null>(env, 'get_job_state', { p_key: key });
  const listed = await store.list('u/', { limit: JOB_LIMITS.sweepPage, cursor });
  const parsed = listed.objects.map((o) => ({
    key: o.key,
    k: parseKey(o.key),
    uploaded: o.uploaded instanceof Date && o.uploaded.getTime() > 0 ? o.uploaded.getTime() : now,
  }));
  const ids = [...new Set(parsed.flatMap((p) => (p.k ? [p.k.photo] : [])))];
  const rows = ids.length ? await rpc<PhotoRowState[]>(env, 'sweep_photo_rows', { p_ids: ids }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const orphans = parsed.flatMap(({ key, k, uploaded }) => {
    // Ids spelled in another case: never recorded or counted, whatever its age.
    if (!k) return isNonCanonicalPhotoKey(key) ? [key] : [];
    const row = byId.get(k.photo);
    if (!row || row.ownerId !== k.owner) return [key];
    if (storeIdOf(row) !== store.id) {
      // A copy away from the photo's store: the migration owns it while photos are moving. Gallery renders
      // (`u/<owner>/g/…`) don't parse as photo keys, so they never get here.
      return !moving && now - uploaded > LIBRARY_LIMITS.editGraceMs ? [key] : [];
    }
    if (k.kind === 'edit') {
      // Every PUT writes its own key, so a key that isn't the recorded one is never going to be: once it's
      // older than any PUT can take between its write and its record, it goes.
      const recorded = k.variant === 'thumb' ? row.editThumbKey : row.editPreviewKey;
      if (recorded !== key && now - uploaded > LIBRARY_LIMITS.editGraceMs) return [key];
    }
    if (k.kind === 'mask') {
      // A mask is stored just before its row is written (and kept when the reply to that write is lost), so
      // one with no row is removed once it's older than that can take.
      if (!(row.maskKeys ?? []).includes(key) && now - uploaded > LIBRARY_LIMITS.editGraceMs) return [key];
    }
    return [];
  });
  if (orphans.length) await deleteKeys(store, orphans);
  try {
    await rpc(env, 'set_job_state', { p_key: key, p_value: listed.cursor });
  } catch (err) {
    // Never freeze on a cursor that can't be stored (e.g. too long): start over from the top next run.
    logError('cron', 'job_sweep_cursor', err);
    await rpc(env, 'set_job_state', { p_key: key, p_value: null });
  }
  return orphans.length;
}

interface ShareCleanup {
  reminders: { galleryId: string; ownerEmail: string | null; name: string; expiresAt: string }[];
  purged: number;
  deleted: number;
}

export async function shareCleanup(env: Env, requestId = 'cron') {
  const r = await rpc<ShareCleanup>(env, 'due_share_cleanup', { p_limit: JOB_LIMITS.shareCleanup });
  let sent = 0;
  for (const m of r.reminders) {
    if (!m.ownerEmail) continue;
    try {
      await sendEmail(env, {
        to: m.ownerEmail,
        ...galleryExpiringEmail({
          galleryName: m.name,
          galleryId: m.galleryId,
          expiresAt: m.expiresAt,
          appUrl: env.APP_URL,
        }),
        idempotencyKey: `expiring-${m.galleryId}-${m.expiresAt}`,
      });
      sent += 1;
    } catch (err) {
      logError(requestId, 'expiry_email', err);
    }
  }
  return { purged: r.purged, deleted: r.deleted, reminders: sent };
}

interface DueSafetyAlert {
  galleryId: string | null;
  ownerId: string | null;
  reportId: string;
  photoId: string | null;
  count: number;
}

/**
 * Emails Safety about CSAM reports no alert has covered yet, at most once an hour per gallery (the database
 * claims the gallery's hour before returning it). A report is marked alerted only after its email is sent,
 * so a failed send is retried by a later run once the hour allows. Without SAFETY_ALERT_EMAIL nothing is
 * claimed.
 */
export async function sweepSafetyAlerts(env: Env, requestId = 'cron'): Promise<number> {
  if (!env.SAFETY_ALERT_EMAIL) return 0;
  const due = await rpc<DueSafetyAlert[]>(env, 'due_safety_alerts', { p_limit: JOB_LIMITS.safetyAlerts });
  let sent = 0;
  for (const a of due) {
    try {
      await sendEmail(env, {
        to: env.SAFETY_ALERT_EMAIL,
        ...safetyReportEmail({
          reportId: a.reportId,
          galleryId: a.galleryId,
          ownerId: a.ownerId ?? 'unknown',
          photoId: a.photoId,
          count: a.count,
          at: new Date(),
        }),
        // The same key as the request's own alert: a send that worked but wasn't confirmed isn't repeated.
        idempotencyKey: `report-${a.reportId}`,
      });
      await rpc(env, 'confirm_safety_alert', { p_report: a.reportId });
      sent += 1;
    } catch (err) {
      logError(requestId, 'safety_alert_email', err);
    }
  }
  return sent;
}

interface QueuedDeletion {
  id: number;
  bucket: 'shared' | 'photos';
  key: string;
  prefix: boolean;
}

const SHARE_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * What the queue may delete, checked again here so no bug upstream can reach members' originals: in
 * zephyr-photos only full-size renders (`u/<owner>/g/<gallery>/…`), in zephyr-shared anything under
 * `o/<owner>/`; prefixes only a whole gallery's.
 */
const QUEUE_SHAPES = {
  photos: {
    key: new RegExp(`^u/${SHARE_ID}/g/${SHARE_ID}/${SHARE_ID}/full-[0-9]+-[0-9a-f]{32}$`),
    prefix: new RegExp(`^u/${SHARE_ID}/g/${SHARE_ID}/$`),
  },
  shared: {
    key: new RegExp(
      `^o/${SHARE_ID}/(g/${SHARE_ID}/${SHARE_ID}/(grid|view|full)|b/(logo|watermark))-[0-9a-f]{32}$`,
    ),
    prefix: new RegExp(`^o/${SHARE_ID}/g/${SHARE_ID}/$`),
  },
} as const;

export async function drainShareDeletions(env: Env, requestId = 'cron'): Promise<number> {
  const all = await rpc<QueuedDeletion[]>(env, 'due_share_deletions', { p_limit: JOB_LIMITS.shareDeletions });
  const due = all.filter((d) => {
    const shape = QUEUE_SHAPES[d.bucket];
    const ok = shape && (d.prefix ? shape.prefix : shape.key).test(d.key);
    if (!ok) logError(requestId, 'share_deletion_shape', new Error(`queue ${d.id}`));
    return ok;
  });
  if (!due.length) return 0;
  const s = stores(env);
  // 'photos' queue rows are gallery renders (`u/<owner>/g/…`), which always stay on R2.
  const target = { shared: s.shared, photos: s.galleryRenders };
  const done: number[] = [];
  let deleted = 0;
  for (const bucket of ['shared', 'photos'] as const) {
    const keys = due.filter((d) => d.bucket === bucket && !d.prefix);
    if (keys.length) {
      deleted += await deleteAll(
        target[bucket],
        keys.map((d) => d.key),
      );
      done.push(...keys.map((d) => d.id));
    }
    for (const d of due.filter((x) => x.bucket === bucket && x.prefix)) {
      const r = await deleteUnder(target[bucket], d.key, 2);
      deleted += r.deleted;
      if (r.complete) done.push(d.id);
    }
  }
  if (done.length) await rpc(env, 'confirm_share_deletions', { p_ids: done });
  return deleted;
}
