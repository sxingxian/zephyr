/**
 * Clean-up jobs, run by the Cron Trigger every 15 minutes (docs/phase-3.md, Clean-up jobs). Each step
 * does a bounded amount of work, deletes R2 objects before the rows that account for them, and is safe
 * to repeat. One audit row per run that did something, with counts only.
 */
import { gotrue } from './auth/gotrue';
import { sendEmail } from './email/resend';
import { galleryExpiringEmail } from './email/share-templates';
import type { Env } from './env';
import { logError } from './http';
import { deleteAll, deleteUnder, stores } from './library/objects';
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
}

interface ExpiredUpload {
  uploadId: string;
  r2Key: string;
  r2UploadId: string | null;
  keys: string[];
}
interface DueAccount {
  ownerId: string;
  prefix: string;
  stagingPrefix: string;
  /** Phase 5: guest renditions and branding in zephyr-shared. */
  sharedPrefix?: string;
  uploads: { r2Key: string; r2UploadId: string }[];
}

async function abortMultipart(env: Env, key: string, uploadId: string) {
  try {
    await env.PHOTOS.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    /* already aborted or completed */
  }
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
  };

  // 1. Uploads left unfinished for 24 hours. The database claims them first (rows and reservation go
  // under the owner's lock, so a racing complete either finished before or finds nothing); only then are
  // the R2 upload aborted and its objects deleted. Leftovers: orphan sweep (u/) and lifecycle (staging/).
  try {
    const due = await rpc<ExpiredUpload[]>(env, 'due_expired_uploads', {
      p_limit: JOB_LIMITS.expiredUploads,
    });
    counts.uploadsAborted = due.length;
    if (due.length) {
      for (const u of due) if (u.r2UploadId) await abortMultipart(env, u.r2Key, u.r2UploadId);
      counts.objectsDeleted += await deleteKeys(
        env.PHOTOS,
        due.flatMap((u) => u.keys),
      );
    }
  } catch (err) {
    logError(requestId, 'job_expired_uploads', err);
  }

  // 2. Trash past its 30 days (and anything left purging): delete objects, then rows and usage.
  try {
    const due = await rpc<PurgeItem[]>(env, 'due_photo_purges', { p_limit: JOB_LIMITS.photoPurges });
    if (due.length) {
      counts.objectsDeleted += await deleteKeys(
        env.PHOTOS,
        due.flatMap((p) => p.keys),
      );
      counts.photosPurged = await rpc<number>(env, 'confirm_photo_purges', {
        p_ids: due.map((p) => p.photoId),
      });
    }
  } catch (err) {
    logError(requestId, 'job_photo_purges', err);
  }

  // 3. Accounts past their deletion date: every object under u/<id>/, then the Auth user (cascades).
  try {
    const due = await rpc<DueAccount[]>(env, 'due_account_purges', { p_limit: JOB_LIMITS.accountPurges });
    for (const a of due) {
      try {
        for (const u of a.uploads) await abortMultipart(env, u.r2Key, u.r2UploadId);
        const photos = await deletePrefix(env.PHOTOS, a.prefix, JOB_LIMITS.pagesPerAccount);
        const staged = await deletePrefix(env.PHOTOS, a.stagingPrefix, JOB_LIMITS.pagesPerAccount);
        const shared = a.sharedPrefix
          ? await deleteUnder(stores(env).shared, a.sharedPrefix, JOB_LIMITS.pagesPerAccount)
          : { deleted: 0, complete: true };
        const res = {
          deleted: photos.deleted + staged.deleted + shared.deleted,
          complete: photos.complete && staged.complete && shared.complete,
        };
        counts.objectsDeleted += res.deleted;
        if (!res.complete) {
          // More objects than one run allows: progress, not a failure, so no hour's backoff.
          if (res.deleted > 0) await rpc(env, 'account_purge_progress', { p_owner: a.ownerId });
          continue;
        }
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

  // 8. Old rate-limit rows (pg_cron does this daily too).
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
    const outcome: Record<'thumb' | 'preview', 'ok' | 'lost' | 'wait'> = { thumb: 'ok', preview: 'ok' };
    for (const kind of ['thumb', 'preview'] as const) {
      const counted = kind === 'thumb' ? p.thumbBytes : p.previewBytes;
      if (counted <= 0) continue;
      const staged = await env.PHOTOS.get(stagingKey(p.ownerId, p.photoId, kind));
      if (staged && 'body' in staged && staged.size === counted) {
        const bytes = new Uint8Array(await staged.arrayBuffer());
        const type = staged.httpMetadata?.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
        await env.PHOTOS.put(photoKey(p.ownerId, p.photoId, kind), bytes, {
          httpMetadata: { contentType: type },
        });
        published += 1;
        continue;
      }
      if (staged && 'body' in staged) await staged.body.cancel().catch(() => undefined);
      const final = await env.PHOTOS.head(photoKey(p.ownerId, p.photoId, kind));
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
    await deleteKeys(env.PHOTOS, [
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
}

/**
 * Deletes photo objects (`u/`) nothing accounts for: keys whose photo row is gone or belongs to someone
 * else, keys whose ids aren't spelled in canonical lower case, and edited variants
 * (`edit-<version>-<kind>-<nonce>`) that aren't the object the photo's edit records,
 * once they're over an hour old (a variant PUT may be between its write and its record). Keys of
 * existing photos (including in-flight uploads) and keys of any other shape are left alone; `staging/`
 * isn't swept (an R2 lifecycle rule empties it after 2 days).
 */
export async function sweepOrphans(env: Env, now = Date.now()): Promise<number> {
  const cursor = await rpc<string | null>(env, 'get_job_state', { p_key: 'orphan_sweep_cursor' });
  const listed = await env.PHOTOS.list({
    prefix: 'u/',
    limit: JOB_LIMITS.sweepPage,
    ...(cursor ? { cursor } : {}),
  });
  const parsed = listed.objects.map((o) => ({
    key: o.key,
    k: parseKey(o.key),
    uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : now,
  }));
  const ids = [...new Set(parsed.flatMap((p) => (p.k ? [p.k.photo] : [])))];
  const rows = ids.length ? await rpc<PhotoRowState[]>(env, 'sweep_photo_rows', { p_ids: ids }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const orphans = parsed.flatMap(({ key, k, uploaded }) => {
    // Ids spelled in another case: never recorded or counted, whatever its age.
    if (!k) return isNonCanonicalPhotoKey(key) ? [key] : [];
    const row = byId.get(k.photo);
    if (!row || row.ownerId !== k.owner) return [key];
    if (k.kind === 'edit') {
      // Every PUT writes its own key, so a key that isn't the recorded one is never going to be: once it's
      // older than any PUT can take between its write and its record, it goes.
      const recorded = k.variant === 'thumb' ? row.editThumbKey : row.editPreviewKey;
      if (recorded !== key && now - uploaded > LIBRARY_LIMITS.editGraceMs) return [key];
    }
    return [];
  });
  if (orphans.length) await deleteKeys(env.PHOTOS, orphans);
  const next = listed.truncated ? (listed.cursor ?? null) : null;
  try {
    await rpc(env, 'set_job_state', { p_key: 'orphan_sweep_cursor', p_value: next });
  } catch (err) {
    // Never freeze on a cursor that can't be stored (e.g. too long): start over from the top next run.
    logError('cron', 'job_sweep_cursor', err);
    await rpc(env, 'set_job_state', { p_key: 'orphan_sweep_cursor', p_value: null });
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
  const done: number[] = [];
  let deleted = 0;
  for (const bucket of ['shared', 'photos'] as const) {
    const keys = due.filter((d) => d.bucket === bucket && !d.prefix);
    if (keys.length) {
      deleted += await deleteAll(
        s[bucket],
        keys.map((d) => d.key),
      );
      done.push(...keys.map((d) => d.id));
    }
    for (const d of due.filter((x) => x.bucket === bucket && x.prefix)) {
      const r = await deleteUnder(s[bucket], d.key, 2);
      deleted += r.deleted;
      if (r.complete) done.push(d.id);
    }
  }
  if (done.length) await rpc(env, 'confirm_share_deletions', { p_ids: done });
  return deleted;
}
