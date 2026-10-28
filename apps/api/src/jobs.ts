/**
 * Clean-up jobs, run by the Cron Trigger every 15 minutes (docs/phase-3.md, Clean-up jobs). Each step
 * does a bounded amount of work, deletes R2 objects before the rows that account for them, and is safe
 * to repeat. One audit row per run that did something, with counts only.
 */
import { gotrue } from './auth/gotrue';
import type { Env } from './env';
import { logError } from './http';
import { deleteKeys, deletePrefix, type PurgeItem } from './library/storage';
import { rpc } from './supabase';

export const JOB_LIMITS = {
  expiredUploads: 200,
  photoPurges: 300,
  accountPurges: 5,
  /** 1,000-key list-and-delete rounds per account per run; the rest continues next run. */
  pagesPerAccount: 10,
} as const;

export interface CleanupCounts {
  uploadsAborted: number;
  photosPurged: number;
  accountsPurged: number;
  objectsDeleted: number;
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
        if (!res.complete) continue; // more objects than one run allows: finish next time
        await gotrue.adminDeleteUser(env, a.ownerId);
        counts.accountsPurged += 1;
      } catch (err) {
        logError(requestId, 'job_account_purge', err);
      }
    }
  } catch (err) {
    logError(requestId, 'job_account_purges', err);
  }

  // 4. Old rate-limit rows (pg_cron does this daily too).
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
