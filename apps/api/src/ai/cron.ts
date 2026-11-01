/**
 * Zephyr AI's part of the 15-minute Cron Trigger: re-enqueue due and stuck background-removal items,
 * backfill scene tags, handle face data of members whose plan lost people grouping, and prune old rows.
 */
import { faceLapseEmail } from '../email/ai-templates';
import { sendEmail } from '../email/resend';
import type { Env } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';
import { enqueue } from './consumer';

export const AI_CRON_LIMITS = { dueItems: 500, sceneBackfill: 500, faceLapses: 50 } as const;

export interface AiCronCounts {
  itemsEnqueued: number;
  scenesEnqueued: number;
  faceNotices: number;
}

interface Lapse {
  ownerId: string;
  email: string | null;
  kind: 'stopped' | 'warning' | 'deleted';
  deleteOn: string | null;
}

export async function runAiCron(env: Env, requestId = 'cron'): Promise<AiCronCounts> {
  const counts: AiCronCounts = { itemsEnqueued: 0, scenesEnqueued: 0, faceNotices: 0 };
  try {
    const ids = await rpc<string[]>(env, 'ai_due_items', { p_limit: AI_CRON_LIMITS.dueItems });
    if (ids.length) {
      await enqueue(
        env,
        ids.map((item) => ({ t: 'bg', item })),
      );
      counts.itemsEnqueued = ids.length;
    }
  } catch (err) {
    logError(requestId, 'ai_due_items', err);
  }
  try {
    const due = await rpc<{ photo: string; owner: string }[]>(env, 'ai_scene_backfill', {
      p_limit: AI_CRON_LIMITS.sceneBackfill,
    });
    if (due.length) {
      await enqueue(
        env,
        due.map((d) => ({ t: 'scene', photo: d.photo, owner: d.owner })),
      );
      counts.scenesEnqueued = due.length;
    }
  } catch (err) {
    logError(requestId, 'ai_scene_backfill', err);
  }
  try {
    const lapses = await rpc<Lapse[]>(env, 'ai_face_lapses', { p_limit: AI_CRON_LIMITS.faceLapses });
    for (const l of lapses) {
      if (!l.email) continue;
      try {
        await sendEmail(env, {
          to: l.email,
          ...faceLapseEmail({ kind: l.kind, deleteOn: l.deleteOn, appUrl: env.APP_URL }),
          idempotencyKey: `ai-face-lapse-${l.ownerId}-${l.kind}-${l.deleteOn ?? 'done'}`,
        });
        counts.faceNotices += 1;
      } catch (err) {
        logError(requestId, 'ai_face_lapse_email', err);
      }
    }
  } catch (err) {
    logError(requestId, 'ai_face_lapses', err);
  }
  try {
    await rpc(env, 'ai_prune');
  } catch (err) {
    logError(requestId, 'ai_prune', err);
  }
  return counts;
}
