/**
 * Phase 8 admin jobs on the existing scheduled handler (docs/phase-8.md › Crons):
 * - every 15 minutes: scheduled plan limits become active, the decrease notices go out in batches, plan
 *   overrides past their end date end, and approved retention batches move photos to Trash;
 * - daily at 02:20 UTC: the retention sweep and its 30/7-day notices, and the sponsored cards' status
 *   (scheduled → live → ended).
 * The storage jobs (health checks, migration upkeep, old-copy deletion) belong to the storage fork.
 *
 * Every "due" function claims its rows in the database before returning them, so a row is emailed once even if
 * two runs overlap; a send that fails is logged (no addresses) and not retried by this run.
 */
import { type LimitsChangeLine, limitsDecreaseEmail, retentionNoticeEmail } from '../email/admin-templates';
import { sendEmail } from '../email/resend';
import type { Env } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';

export const ADMIN_DAILY_CRON = '20 2 * * *';
export const ADMIN_CRON_LIMITS = {
  notices: 100,
  retentionOwners: 20,
  retentionPhotos: 500,
} as const;

interface LimitsNotice {
  userId: string;
  email: string;
  version: number;
  effectiveAt: string;
  changes: LimitsChangeLine[];
}
interface RetentionNotice {
  ownerId: string;
  email: string;
  dueAt: string;
  photos: number;
  notice: 'd30' | 'd7';
}

const mute = (where: string) => (err: unknown) => {
  logError('cron', where, err);
  return null;
};

/** One batch of plan-limits decrease notices. Returns how many were sent. */
export async function sendLimitsNotices(
  env: Env,
  limit: number = ADMIN_CRON_LIMITS.notices,
): Promise<number> {
  const due = (await rpc<LimitsNotice[] | null>(env, 'limits_notices_due', { p_limit: limit })) ?? [];
  let sent = 0;
  for (const n of due) {
    try {
      await sendEmail(env, {
        to: n.email,
        ...limitsDecreaseEmail({ effectiveAt: n.effectiveAt, changes: n.changes, appUrl: env.APP_URL }),
        idempotencyKey: `limits:${n.version}:${n.userId}`,
      });
      sent++;
    } catch (err) {
      logError('cron', 'limits_notice', err);
    }
  }
  return sent;
}

/** One batch of retention notices (30 and 7 days before the clean-up). */
export async function sendRetentionNotices(
  env: Env,
  limit: number = ADMIN_CRON_LIMITS.notices,
): Promise<number> {
  const due = (await rpc<RetentionNotice[] | null>(env, 'retention_notices_due', { p_limit: limit })) ?? [];
  let sent = 0;
  for (const n of due) {
    try {
      await sendEmail(env, {
        to: n.email,
        ...retentionNoticeEmail({ dueAt: n.dueAt, photos: n.photos, appUrl: env.APP_URL }),
        idempotencyKey: `retention:${n.notice}:${n.ownerId}:${n.dueAt.slice(0, 10)}`,
      });
      sent++;
    } catch (err) {
      logError('cron', 'retention_notice', err);
    }
  }
  return sent;
}

/** Approved retention items: trash the oldest photos beyond the Free storage, a bounded batch per library. */
export async function runRetentionBatches(env: Env): Promise<number> {
  const owners =
    (await rpc<string[] | null>(env, 'retention_approved_due', {
      p_limit: ADMIN_CRON_LIMITS.retentionOwners,
    })) ?? [];
  let trashed = 0;
  for (const owner of owners) {
    try {
      const r = await rpc<{ trashed: number; done: boolean } | null>(env, 'retention_trash_batch', {
        p_owner: owner,
        p_limit: ADMIN_CRON_LIMITS.retentionPhotos,
      });
      trashed += r?.trashed ?? 0;
    } catch (err) {
      logError('cron', 'retention_batch', err);
    }
  }
  return trashed;
}

export interface AdminCronCounts {
  limitsActivated: number | null;
  limitsNotices: number | null;
  overridesEnded: number | null;
  retentionTrashed: number | null;
}

/** Every 15 minutes. Each step runs even if an earlier one failed. */
export async function runAdminCron(env: Env): Promise<AdminCronCounts> {
  const limitsActivated = await rpc<number>(env, 'limits_activate_due', {}).catch(mute('limits_activate'));
  const limitsNotices = await sendLimitsNotices(env).catch(mute('limits_notices'));
  const overridesEnded = await rpc<number>(env, 'admin_overrides_expire', {}).catch(mute('overrides_expire'));
  const retentionTrashed = await runRetentionBatches(env).catch(mute('retention_batches'));
  return { limitsActivated, limitsNotices, overridesEnded, retentionTrashed };
}

export interface AdminDailyCounts {
  retention: unknown;
  retentionNotices: number;
  ads: unknown;
}

/** Daily at 02:20 UTC. */
export async function runAdminDailyCron(env: Env): Promise<AdminDailyCounts> {
  const retention = await rpc<unknown>(env, 'retention_sweep', {}).catch(mute('retention_sweep'));
  // Up to 10 batches: a notice that slips a day still leaves the member 29 (or 6) days.
  let retentionNotices = 0;
  for (let i = 0; i < 10; i++) {
    const n = await sendRetentionNotices(env).catch(mute('retention_notices'));
    if (n === null) break;
    retentionNotices += n;
    if (n < ADMIN_CRON_LIMITS.notices) break;
  }
  const ads = await rpc<unknown>(env, 'ad_status_tick', {}).catch(mute('ad_status'));
  return { retention, retentionNotices, ads };
}
