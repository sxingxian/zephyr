/**
 * Clean-up jobs, run by the Cron Trigger every 15 minutes (docs/phase-3.md, Clean-up jobs). Each step
 * does a bounded amount of work, deletes R2 objects before the rows that account for them, and is safe
 * to repeat. One audit row per run that did something, with counts only.
 */
import { gotrue } from './auth/gotrue';
import type { Env } from './env';
import { logError } from './http';
import {
  deleteKeys,
  deletePrefix,
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
        const res = {
          deleted: photos.deleted + staged.deleted,
          complete: photos.complete && staged.complete,
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

  // 6. Old rate-limit rows (pg_cron does this daily too).
  try {
    counts.rateLimitRows = await rpc<number>(env, 'purge_rate_limits');
  } catch (err) {
    logError(requestId, 'job_rate_limits', err);
  }

  const { rateLimitRows: _routine, ...library } = counts;
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
  editThumbVersion?: number | null;
  editPreviewVersion?: number | null;
}

/**
 * Deletes photo objects (`u/`) nothing accounts for: keys whose photo row is gone or belongs to someone
 * else, and edited variants (`edit-<version>-<kind>`) that aren't the version the photo's edit records,
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
    if (!k) return [];
    const row = byId.get(k.photo);
    if (!row || row.ownerId !== k.owner) return [key];
    if (k.kind === 'edit') {
      const recorded = k.variant === 'thumb' ? row.editThumbVersion : row.editPreviewVersion;
      if (recorded !== k.version && now - uploaded > LIBRARY_LIMITS.editGraceMs) return [key];
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
