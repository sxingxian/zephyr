/**
 * Clean-up jobs, run by the Cron Trigger every 15 minutes (docs/phase-3.md, Clean-up jobs). Each step
 * does a bounded amount of work, deletes R2 objects before the rows that account for them, and is safe
 * to repeat. One audit row per run that did something, with counts only.
 */
import { gotrue } from './auth/gotrue';
import type { Env } from './env';
import { logError } from './http';
import { deleteKeys, deletePrefix, type PurgeItem, parseKey } from './library/storage';
import { rpc } from './supabase';

export const JOB_LIMITS = {
  expiredUploads: 200,
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
    rateLimitRows: 0,
  };

  // 1. Uploads left unfinished for 24 hours: abort, delete any objects, then release the reservation.
  try {
    const due = await rpc<ExpiredUpload[]>(env, 'due_expired_uploads', {
      p_limit: JOB_LIMITS.expiredUploads,
    });
    if (due.length) {
      for (const u of due) if (u.r2UploadId) await abortMultipart(env, u.r2Key, u.r2UploadId);
      counts.objectsDeleted += await deleteKeys(
        env.PHOTOS,
        due.flatMap((u) => u.keys),
      );
      counts.uploadsAborted = await rpc<number>(env, 'confirm_expired_uploads', {
        p_ids: due.map((u) => u.uploadId),
      });
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
        const res = await deletePrefix(env.PHOTOS, a.prefix, JOB_LIMITS.pagesPerAccount);
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

  // 4. Orphan sweep: one page of library keys per run, resuming from the stored cursor.
  try {
    counts.orphansDeleted = await sweepOrphans(env);
  } catch (err) {
    logError(requestId, 'job_orphan_sweep', err);
  }

  // 5. Old rate-limit rows (pg_cron does this daily too).
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

interface PhotoRowState {
  id: string;
  ownerId: string;
  status: 'uploading' | 'ready' | 'trashed' | 'purging';
  activeUpload: boolean;
}

/**
 * Deletes objects nothing accounts for: keys whose photo row is gone (or belongs to someone else), and
 * staging variants of photos with no upload in progress (a late or racing variant PUT). Keys of photos
 * with an active upload, and keys that aren't library keys, are left alone.
 */
export async function sweepOrphans(env: Env): Promise<number> {
  const cursor = await rpc<string | null>(env, 'get_job_state', { p_key: 'orphan_sweep_cursor' });
  const listed = await env.PHOTOS.list({
    prefix: 'u/',
    limit: JOB_LIMITS.sweepPage,
    ...(cursor ? { cursor } : {}),
  });
  const parsed = listed.objects.map((o) => ({ key: o.key, k: parseKey(o.key) }));
  const ids = [...new Set(parsed.flatMap((p) => (p.k ? [p.k.photo] : [])))];
  const rows = ids.length ? await rpc<PhotoRowState[]>(env, 'sweep_photo_rows', { p_ids: ids }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const orphans = parsed.flatMap(({ key, k }) => {
    if (!k) return [];
    const row = byId.get(k.photo);
    if (!row || row.ownerId !== k.owner) return [key];
    if (k.kind.startsWith('staging-') && !row.activeUpload) return [key];
    return [];
  });
  if (orphans.length) await deleteKeys(env.PHOTOS, orphans);
  await rpc(env, 'set_job_state', {
    p_key: 'orphan_sweep_cursor',
    p_value: listed.truncated ? listed.cursor : null,
  });
  return orphans.length;
}
