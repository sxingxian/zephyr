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
import { deleteKeys, photoKey } from '../library/storage';
import { rpc } from '../supabase';
import { encodeMask, MaskError, readMask, resizeMask, sameAspect } from './png';
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
  | { status: 'go'; ownerId: string; photoId: string; attempts: number; alerts?: SpendAlert[] }
  | { status: 'wait'; until: string; alerts?: SpendAlert[] }
  | { status: 'skip' | 'failed' };

export type BgOutcome = 'completed' | 'failed' | 'waiting' | 'skipped';

/** One background-removal item, end to end. Throws only when the database can't be reached (retry the message). */
export async function processBgItem(env: Env, itemId: string): Promise<BgOutcome> {
  if (!UUID.test(itemId)) return 'skipped';
  const s = await aiSettings(env);
  const begin = await rpc<Begin>(env, 'ai_item_begin', {
    p_item: itemId,
    p_estimate: providerEstimate(s, s.bgProvider),
  });
  if (begin.status === 'wait') {
    await sendSpendAlerts(env, begin.alerts, s.atCap);
    return 'waiting';
  }
  if (begin.status !== 'go') return begin.status === 'failed' ? 'failed' : 'skipped';
  await sendSpendAlerts(env, begin.alerts, s.atCap);
  const { ownerId, photoId } = begin;
  const calls: CallLog[] = [];
  const failed = async (error: AiItemError, cost = 0) => {
    await rpc(env, 'ai_item_failed', { p_item: itemId, p_error: error, p_cost: cost, p_calls: calls });
    return 'failed' as const;
  };

  // The untouched preview (≤ 2048 px). Never the original file.
  const obj = await env.PHOTOS.get(photoKey(ownerId, photoId, 'preview'));
  if (!obj || !('body' in obj)) return failed('no_preview');
  const preview = new Uint8Array(await obj.arrayBuffer());
  const info = imageInfo(preview);
  if (!info) return failed('no_preview');
  const mime = info.format === 'jpeg' ? 'image/jpeg' : 'image/webp';

  const plan: { provider: BgProvider; role: 'primary' | 'fallback' }[] = [];
  for (let k = 0; k < PRIMARY_ATTEMPTS; k++) plan.push({ provider: s.bgProvider, role: 'primary' });
  if (s.bgFallback !== 'none' && s.bgFallback !== s.bgProvider)
    plan.push({ provider: s.bgFallback, role: 'fallback' });

  let last: ProviderError = 'provider_error';
  let spent = 0;
  for (const step of plan) {
    const t0 = Date.now();
    try {
      const r = await cutoutCall(step.provider)(env, s, preview, mime);
      const cost = r.costMicros ?? providerEstimate(s, step.provider);
      spent += cost;
      let mask: { width: number; height: number; data: Uint8Array };
      try {
        mask = readMask(r.png, MASK_LIMITS.providerMaxBytes);
      } catch (err) {
        throw new ProviderFailure('bad_output', err instanceof MaskError ? err.reason : 'png');
      }
      if (!sameAspect(mask, info, MASK_LIMITS.aspectTolerance))
        throw new ProviderFailure('bad_output', 'aspect');
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
      await env.PHOTOS.put(key, png, { httpMetadata: { contentType: 'image/png' } });
      let done: { status: string; deleteKeys?: string[] };
      try {
        done = await rpc<{ status: string; deleteKeys?: string[] }>(env, 'ai_item_complete', {
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
        });
      } catch (err) {
        // The orphan sweep removes the mask if no row records it.
        await deleteKeys(env.PHOTOS, [key]).catch(() => undefined);
        throw err;
      }
      const drop = (done.deleteKeys ?? []).filter(
        (k) => typeof k === 'string' && k.startsWith(`u/${ownerId}/p/`),
      );
      if (drop.length)
        await deleteKeys(env.PHOTOS, drop).catch((err) => logError('queue', 'ai_mask_drop', err));
      return done.status === 'ok' ? 'completed' : 'failed';
    } catch (err) {
      if (!(err instanceof ProviderFailure)) throw err;
      last = err.reason;
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
  | { status: 'go'; alerts?: SpendAlert[] }
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
  const done = (scenes: unknown, calls: CallLog[]) =>
    rpc(env, 'ai_scene_done', {
      p_owner: owner,
      p_photo: photo,
      p_scenes: scenes,
      p_reserved: estimate,
      p_cost: calls.length ? estimate : 0,
      p_calls: calls,
    });
  const obj = await env.PHOTOS.get(photoKey(owner, photo, 'thumb'));
  if (!obj || !('body' in obj)) {
    await done('retry', []);
    return 'waiting';
  }
  const thumb = new Uint8Array(await obj.arrayBuffer());
  const t0 = Date.now();
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
