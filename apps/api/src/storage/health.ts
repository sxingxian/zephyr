/**
 * Store health checks (docs/phase-8.md › Health check).
 *
 * - Every 5 minutes (cron), the write store: reachability (a one-key list), a signed write/read/delete round
 *   trip of a random object under `_health/`, and latency.
 * - On demand from Admin, any store: the same plus upload speed (a 4 MB object) and free space (declared
 *   capacity minus what the database counts on that store).
 * - Three failed cron checks in a row on the write store turn read-only mode on automatically and email the
 *   Owners; two good ones turn it off again. The database only ever turns off a read-only it turned on
 *   itself (`read_only_auto`), never a manual one.
 */
import type { StoreCheck } from '@zephyr/shared';
import { sendEmail } from '../email/resend';
import { readOnlyAutoEmail } from '../email/storage-templates';
import type { Env } from '../env';
import { logError } from '../http';
import { rpc } from '../supabase';
import { storeConfig, storeFor } from './config';
import { hex } from './hash';
import { StoreError } from './types';

export const HEALTH = {
  failuresToReadOnly: 3,
  successesToRecover: 2,
  probeBytes: 1024,
  speedBytes: 4 * 1024 * 1024,
} as const;

const nonce = () => hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
const codeOf = (err: unknown) => (err instanceof StoreError ? err.code : 'error');
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

/** Bytes the database counts on each store (`storage_usage()`). */
export async function usageByStore(env: Env): Promise<Map<string, { objects: number; bytes: number }>> {
  const rows = await rpc<{ storeId: string; objects: number; bytes: number }[]>(env, 'storage_usage');
  return new Map((rows ?? []).map((r) => [r.storeId, { objects: r.objects, bytes: r.bytes }]));
}

/** Runs a check against one store. Never throws: failures are in the result as short codes. */
export async function checkStore(env: Env, storeId: string, full: boolean): Promise<StoreCheck> {
  const result: StoreCheck = {
    at: new Date().toISOString(),
    reachable: false,
    latencyMs: null,
    roundTrip: false,
    uploadMBps: null,
    freeBytes: null,
    capacityBytes: storeConfig(env, storeId)?.capacityBytes ?? null,
    error: null,
  };
  let store: ReturnType<typeof storeFor>;
  try {
    store = storeFor(env, storeId);
  } catch (err) {
    result.error = codeOf(err);
    return result;
  }
  try {
    const t0 = Date.now();
    await store.list('_health/', { limit: 1 });
    result.latencyMs = Date.now() - t0;
    result.reachable = true;

    const key = `_health/${nonce()}`;
    const probe = random(HEALTH.probeBytes);
    try {
      await store.put(key, probe, { contentType: 'application/octet-stream' });
      const back = await store.get(key);
      const bytes = back ? await back.bytes() : null;
      if (!bytes || !equal(bytes, probe)) throw new StoreError('round_trip_mismatch');
      result.roundTrip = true;
    } finally {
      await store.delete([key]).catch(() => undefined);
    }

    if (full) {
      const speedKey = `_health/${nonce()}`;
      const payload = random(HEALTH.speedBytes);
      try {
        const t1 = Date.now();
        await store.put(speedKey, payload, { contentType: 'application/octet-stream' });
        const s = Math.max(1, Date.now() - t1) / 1000;
        result.uploadMBps = Math.round((HEALTH.speedBytes / (1024 * 1024) / s) * 10) / 10;
      } finally {
        await store.delete([speedKey]).catch(() => undefined);
      }
    }
  } catch (err) {
    result.error = codeOf(err);
  }
  if (full && result.capacityBytes !== null) {
    try {
      const used = (await usageByStore(env)).get(storeId)?.bytes ?? 0;
      result.freeBytes = Math.max(0, result.capacityBytes - used);
    } catch (err) {
      logError('storage', 'health_usage', err);
    }
  }
  return result;
}

/** A check counts as good only if the store answered and the round trip worked. */
export const checkOk = (c: StoreCheck) => c.reachable && c.roundTrip;

interface Recorded {
  failStreak: number;
  okStreak: number;
  autoReadOnly: boolean;
}

async function emailOwners(env: Env, on: boolean, store: string, error: string | null) {
  let to: string[] = [];
  try {
    to = await rpc<string[]>(env, 'ai_alert_recipients', { p_who: 'owners' });
  } catch (err) {
    logError('cron', 'storage_owner_recipients', err);
    return;
  }
  const adminUrl = `${(env.ADMIN_ORIGINS.split(',')[0] ?? '').trim()}/admin/storage`;
  const mail = readOnlyAutoEmail({ on, store, error, adminUrl });
  const stamp = new Date().toISOString().slice(0, 16);
  for (const addr of to ?? []) {
    try {
      await sendEmail(env, {
        to: addr,
        ...mail,
        idempotencyKey: `storage-ro-${on ? 'on' : 'off'}-${stamp}-${addr}`,
      });
    } catch (err) {
      logError('cron', 'storage_owner_email', err);
    }
  }
}

/** Records a check and applies the auto read-only rule (write store only). */
export async function recordCheck(
  env: Env,
  storeId: string,
  check: StoreCheck,
  isWriteStore: boolean,
): Promise<{ readOnly: 'on' | 'off' | null }> {
  const rec = await rpc<Recorded>(env, 'storage_check_record', { p_store: storeId, p_result: check });
  if (!isWriteStore || !rec) return { readOnly: null };
  if (!checkOk(check) && rec.failStreak >= HEALTH.failuresToReadOnly && !rec.autoReadOnly) {
    const r = await rpc<{ changed: boolean }>(env, 'read_only_auto', {
      p_on: true,
      p_reason: 'storage_unreachable',
    });
    if (r?.changed) {
      await emailOwners(env, true, storeId, check.error);
      return { readOnly: 'on' };
    }
  }
  if (checkOk(check) && rec.okStreak >= HEALTH.successesToRecover && rec.autoReadOnly) {
    const r = await rpc<{ changed: boolean }>(env, 'read_only_auto', {
      p_on: false,
      p_reason: 'storage_recovered',
    });
    if (r?.changed) {
      await emailOwners(env, false, storeId, null);
      return { readOnly: 'off' };
    }
  }
  return { readOnly: null };
}

/**
 * After the write store changed by an Owner's action (giving up a rollback): checks the new write store now and,
 * when it answers and read-only mode was turned on automatically (for the store that stopped answering), turns it
 * off at once. The two-success rule is for one store flapping; this is a different store. Otherwise the cron's
 * rule applies as usual.
 */
export async function reevaluateWriteStore(env: Env, storeId: string): Promise<StoreCheck> {
  const check = await checkStore(env, storeId, false);
  const rec = await rpc<Recorded>(env, 'storage_check_record', { p_store: storeId, p_result: check });
  if (checkOk(check) && rec?.autoReadOnly) {
    const r = await rpc<{ changed: boolean }>(env, 'read_only_auto', {
      p_on: false,
      p_reason: 'storage_recovered',
    });
    if (r?.changed) await emailOwners(env, false, storeId, null);
  }
  return check;
}

/** The 5-minute cron's health part: check the write store and apply the auto read-only rule. */
export async function runHealthCron(env: Env): Promise<{ store: string; ok: boolean } | null> {
  try {
    const status = await rpc<{ writeStore: string } | null>(env, 'storage_status');
    const store = status?.writeStore || 'r2';
    const check = await checkStore(env, store, false);
    await recordCheck(env, store, check, true);
    return { store, ok: checkOk(check) };
  } catch (err) {
    logError('cron', 'storage_health', err);
    return null;
  }
}
