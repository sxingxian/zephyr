/**
 * The zephyr-ai queue consumer (docs/phase-6.md, Cloud work). Messages carry ids only; everything is read
 * again from Postgres, which also decides whether to go, wait (cap or admin pause: the cron re-enqueues
 * later, nothing refunded) or skip. A provider is called only after the day's spend was reserved under the
 * database lock, so parallel consumers can't pass a cap.
 */
import {
  type AiItemError,
  type AiSettings,
  type BgProvider,
  MASK_LIMITS,
  SCENE_MIN_SCORE,
  sceneForLabels,
} from '@zephyr/shared';
import { capAlertEmail } from '../email/ai-templates';
import { sendEmail } from '../email/resend';
import type { AiMessage, Env } from '../env';
import { logError } from '../http';
import { imageInfo } from '../library/files';
import { photoKey } from '../library/storage';
import { deleteEverywhere } from '../storage';
import { photoStore, storeIdOf } from '../storage/config';
import { rpc } from '../supabase';
import { encodeMask, MaskError, readMask, resizeMask } from './png';
import {
  type CallLog,
  classifyScene,
  cutoutCall,
  type ProviderError,
  ProviderFailure,
  providerEstimate,
} from './providers';
import { aiSettings } from './settings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Attempts on the primary provider before the fallback gets one. */
export const PRIMARY_ATTEMPTS = 2;

/** The calls one item may make: the primary up to PRIMARY_ATTEMPTS times, then the fallback once. */
export function bgPlan(s: AiSettings): { provider: BgProvider; role: 'primary' | 'fallback' }[] {
  const plan: { provider: BgProvider; role: 'primary' | 'fallback' }[] = [];
  for (let k = 0; k < PRIMARY_ATTEMPTS; k++) plan.push({ provider: s.bgProvider, role: 'primary' });
  if (s.bgFallback !== 'none' && s.bgFallback !== s.bgProvider)
    plan.push({ provider: s.bgFallback, role: 'fallback' });
  return plan;
}
/**
 * What one item can cost at most: every call in its plan. This is what's reserved before the first call,
 * so whatever the calls end up costing stays inside the caps.
 */
export const bgWorstCase = (s: AiSettings) =>
  bgPlan(s).reduce((n, step) => n + providerEstimate(s, step.provider), 0);

export interface SpendAlert {
  scope: string;
  threshold: number;
  usedUsd: number;
  capUsd: number;
}

/** Emails a spend alert (each one is returned by the database only once) to the Owners (and Finance). */
export async function sendSpendAlerts(
  env: Env,
  alerts: SpendAlert[] | undefined,
  atCap: AiSettings['atCap'],
) {
  if (!alerts?.length) return;
  let to: string[] = [];
  try {
    to = await rpc<string[]>(env, 'ai_alert_recipients');
  } catch (err) {
    logError('queue', 'ai_alert_recipients', err);
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const adminUrl = `${(env.ADMIN_ORIGINS.split(',')[0] ?? '').trim()}/admin/ai`;
  for (const a of alerts) {
    const mail = capAlertEmail({ ...a, day, atCap, adminUrl });
    for (const addr of to) {
      try {
        await sendEmail(env, {
          to: addr,
          ...mail,
          idempotencyKey: `ai-cap-${day}-${a.scope}-${a.threshold}-${addr}`,
        });
      } catch (err) {
        logError('queue', 'ai_alert_email', err);
      }
    }
  }
}

type Begin =
  | {
      status: 'go';
      ownerId: string;
      photoId: string;
      attempts: number;
      alerts?: SpendAlert[];
      storeId?: string | null;
    }
  | { status: 'wait'; until: string; alerts?: SpendAlert[] }
  | { status: 'skip' | 'failed' };

export type BgOutcome = 'completed' | 'failed' | 'waiting' | 'skipped';

/** One background-removal item, end to end. Throws only when the database can't be reached (retry the message). */
export async function processBgItem(env: Env, itemId: string): Promise<BgOutcome> {
  if (!UUID.test(itemId)) return 'skipped';
  const s = await aiSettings(env);
  const begin = await rpc<Begin>(env, 'ai_item_begin', {
    p_item: itemId,
    p_estimate: bgWorstCase(s),
  });
  if (begin.status === 'wait') {
    await sendSpendAlerts(env, begin.alerts, s.atCap);
    return 'waiting';
  }
  if (begin.status !== 'go') return begin.status === 'failed' ? 'failed' : 'skipped';
  await sendSpendAlerts(env, begin.alerts, s.atCap);
  const { ownerId, photoId } = begin;
  const store = photoStore(env, storeIdOf(begin));
  // This run's attempt number: a late report from a run taken over as stuck is ignored by the database.
  const attempt = Number.isInteger(begin.attempts) ? begin.attempts : null;
  const calls: CallLog[] = [];
  const failed = async (error: AiItemError, cost = 0) => {
    await rpc(env, 'ai_item_failed', {
      p_item: itemId,
      p_error: error,
      p_cost: cost,
      p_calls: calls,
      p_attempt: attempt,
    });
    return 'failed' as const;
  };

  // The untouched preview (≤ 2048 px). Never the original file.
  const obj = await store.get(photoKey(ownerId, photoId, 'preview'));
  if (!obj) return failed('no_preview');
  const preview = await obj.bytes();
  const info = imageInfo(preview);
  if (!info) return failed('no_preview');
  const mime = info.format === 'jpeg' ? 'image/jpeg' : 'image/webp';

  const plan = bgPlan(s);
  let last: ProviderError = 'provider_error';
  let spent = 0;
  /** A provider whose output we rejected isn't asked again: the same photo would most likely fail the same way. */
  const rejected = new Set<BgProvider>();
  for (const step of plan) {
    if (rejected.has(step.provider)) continue;
    const t0 = Date.now();
    try {
      const r = await cutoutCall(step.provider)(env, s, preview, mime);
      const cost = r.costMicros ?? providerEstimate(s, step.provider);
      spent += cost;
      let mask: { width: number; height: number; data: Uint8Array };
      try {
        // Bounded by the preview's own size, checked before anything is inflated.
        mask = readMask(r.png, MASK_LIMITS.providerMaxBytes, {
          width: info.width,
          height: info.height,
          aspectTolerance: MASK_LIMITS.aspectTolerance,
        });
      } catch (err) {
        throw new ProviderFailure('bad_output', err instanceof MaskError ? err.reason : 'png');
      }
      const scale = Math.min(1, MASK_LIMITS.maxEdge / Math.max(info.width, info.height));
      const out = resizeMask(
        mask,
        Math.max(1, Math.round(info.width * scale)),
        Math.max(1, Math.round(info.height * scale)),
      );
      const png = encodeMask(out);
      if (png.byteLength > MASK_LIMITS.maxBytes) throw new ProviderFailure('bad_output', 'mask_size');
      calls.push({ provider: step.provider, role: step.role, ok: true, ms: Date.now() - t0 });

      const maskId = crypto.randomUUID();
      const key = `u/${ownerId}/p/${photoId}/m/${maskId}.png`;
      await store.put(key, png, { contentType: 'image/png' });
      // If this call fails (or its answer is lost after it committed), the mask is left in place: the
      // orphan sweep removes it later if no row records it. Deleting it here could break a recipe that does.
      const done = await rpc<{ status: string; deleteKeys?: string[] }>(env, 'ai_item_complete', {
        p_item: itemId,
        p_mask: maskId,
        p_key: key,
        p_bytes: png.byteLength,
        p_width: out.width,
        p_height: out.height,
        p_provider: step.provider,
        p_cost: spent,
        p_latency_ms: Date.now() - t0,
        p_calls: calls,
        p_attempt: attempt,
      });
      const drop = (done.deleteKeys ?? []).filter(
        (k) => typeof k === 'string' && k.startsWith(`u/${ownerId}/p/`),
      );
      // Replaced masks go on every store: the photo may be mid-move, with a copy on both.
      if (drop.length)
        await deleteEverywhere(env, drop).catch((err) => logError('queue', 'ai_mask_drop', err));
      return done.status === 'ok' ? 'completed' : 'failed';
    } catch (err) {
      if (!(err instanceof ProviderFailure)) throw err;
      last = err.reason;
      if (err.reason === 'bad_output') rejected.add(step.provider);
      calls.push({
        provider: step.provider,
        role: step.role,
        ok: false,
        ms: Date.now() - t0,
        error: err.code.slice(0, 40),
      });
    }
  }
  return failed(last, spent);
}

type SceneBegin =
  | { status: 'go'; day?: string; run?: string; alerts?: SpendAlert[]; storeId?: string | null }
  | { status: 'wait'; alerts?: SpendAlert[] }
  | { status: 'skip' };

/** Scene tags for one photo, from its original 512 px thumbnail. */
export async function processScene(
  env: Env,
  photo: string,
  owner: string,
): Promise<'done' | 'failed' | 'waiting' | 'skipped'> {
  if (!UUID.test(photo) || !UUID.test(owner)) return 'skipped';
  const s = await aiSettings(env);
  const estimate = s.costs.sceneMicros;
  const begin = await rpc<SceneBegin>(env, 'ai_scene_begin', {
    p_owner: owner,
    p_photo: photo,
    p_estimate: estimate,
  });
  await sendSpendAlerts(env, begin.status === 'skip' ? undefined : begin.alerts, s.atCap);
  if (begin.status === 'wait') return 'waiting';
  if (begin.status !== 'go') return 'skipped';
  // Settled on the day the reservation was made (a run can cross midnight UTC).
  const day = typeof begin.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(begin.day) ? begin.day : null;
  // The run token: the database settles this run once, so a repeated report (say, after a lost reply) is a no-op.
  const run = typeof begin.run === 'string' && UUID.test(begin.run) ? begin.run : null;
  const done = (scenes: unknown, calls: CallLog[]) =>
    rpc(env, 'ai_scene_done', {
      p_owner: owner,
      p_photo: photo,
      p_scenes: scenes,
      p_reserved: estimate,
      p_cost: calls.length ? estimate : 0,
      p_calls: calls,
      p_day: day,
      p_run: run,
    });
  let called = false;
  const t0 = Date.now();
  try {
    const store = photoStore(env, begin.status === 'go' ? storeIdOf(begin) : 'r2');
    const obj = await store.get(photoKey(owner, photo, 'thumb'));
    if (!obj) {
      await done('retry', []);
      return 'waiting';
    }
    const thumb = await obj.bytes();
    called = true;
    try {
      const labels = await classifyScene(env, s, thumb);
      const scenes = sceneForLabels(labels)
        .filter((x) => x.scene !== 'night' && x.score >= SCENE_MIN_SCORE)
        .slice(0, 5);
      await done(scenes, [{ provider: 'workers_ai', role: 'primary', ok: true, ms: Date.now() - t0 }]);
      return 'done';
    } catch (err) {
      if (!(err instanceof ProviderFailure)) throw err;
      await done(null, [
        { provider: 'workers_ai', role: 'primary', ok: false, ms: Date.now() - t0, error: err.code },
      ]);
      return 'failed';
    }
  } catch (err) {
    // Anything unexpected after the reservation (R2, the database): settle it and let the backfill try
    // again in an hour, so reservations never pile up against the caps. Then retry the message as usual.
    await done(
      'retry',
      called
        ? [{ provider: 'workers_ai', role: 'primary', ok: false, ms: Date.now() - t0, error: 'run' }]
        : [],
    ).catch(() => undefined);
    throw err;
  }
}

/** The Worker's queue() handler body. */
export async function handleAiBatch(batch: MessageBatch<AiMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as AiMessage | null;
    try {
      if (body?.t === 'bg' && typeof body.item === 'string') await processBgItem(env, body.item);
      else if (body?.t === 'scene' && typeof body.photo === 'string' && typeof body.owner === 'string')
        await processScene(env, body.photo, body.owner);
      m.ack();
    } catch (err) {
      logError('queue', 'ai_message', err);
      // The database couldn't be reached (or R2 failed): try again a little later.
      m.retry({ delaySeconds: Math.min(300, 30 * 2 ** Math.min(m.attempts, 3)) });
    }
  }
}

/** Sends messages in batches of 100 (the queue's limit per call). */
export async function enqueue(env: Env, messages: AiMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    await env.AI_QUEUE.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
  }
}
