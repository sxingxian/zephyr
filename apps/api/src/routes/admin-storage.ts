import {
  type AdminStorageResult,
  adminStorageAbandonSchema,
  adminStorageGiveUpSchema,
  adminStorageMigrationSchema,
  adminStorageSwitchSchema,
  STAFF_CAN,
  STORAGE_FREE_ALERT,
  type StaffRole,
  type StorageMigration,
  type StoreCheck,
  type StoreHealth,
  type StoreStatus,
  storeIdSchema,
} from '@zephyr/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { sendEmail } from '../email/resend';
import {
  storageAbandonEmail,
  storageGiveUpEmail,
  storageRollbackEmail,
  storageSwitchEmail,
} from '../email/storage-templates';
import { background, fail, logError, readBody } from '../http';
import { storeConfigError, storeConfigs } from '../storage/config';
import { checkOk, checkStore, recordCheck, reevaluateWriteStore } from '../storage/health';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv } from '../types';

type RequireStaff = (opts?: { allowEnrol?: boolean; write?: boolean }) => MiddlewareHandler<HonoEnv>;
type Ctx = Context<HonoEnv>;

const STORAGE_ROLES: ReadonlySet<StaffRole> = new Set(STAFF_CAN.storage);
/** A store must have passed a check this recently before photos are switched onto it. */
export const SWITCH_CHECK_MAX_AGE_MS = 24 * 3600 * 1000;
/** Latency above this marks a store degraded. */
const SLOW_MS = 2000;

/** What `admin_storage(p_staff)` returns: the database half of Admin › Storage. */
interface StorageDb {
  writeStore: string;
  migration: StorageMigration | null;
  usage: { storeId: string; objects: number; bytes: number }[];
  checks: { storeId: string; result: StoreCheck }[];
  autoReadOnly: boolean;
  oldCopies?: { storeId: string; copies: number; endsRollback?: boolean }[];
  followups?: { pending: number; dropped30d: number };
}

const canStorage: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!STORAGE_ROLES.has(c.get('staff').role)) return c.json(fail('forbidden'), 403);
  await next();
};

export function healthOf(check: StoreCheck | null): StoreHealth {
  if (!check) return 'unknown';
  if (!check.reachable) return 'unreachable';
  const lowSpace =
    check.freeBytes !== null &&
    check.capacityBytes !== null &&
    check.capacityBytes > 0 &&
    check.freeBytes / check.capacityBytes < STORAGE_FREE_ALERT;
  if (!check.roundTrip || (check.latencyMs ?? 0) > SLOW_MS || lowSpace) return 'degraded';
  return 'healthy';
}

/**
 * Admin › Storage: the deployment's stores (config.ts) joined with what the database knows (usage, last
 * checks, the migration). Never includes endpoints, buckets, bindings or keys.
 */
export async function storageOverview(c: Ctx): Promise<AdminStorageResult> {
  const db = await rpc<StorageDb | null>(c.env, 'admin_storage', { p_staff: c.get('staff').id });
  if (!db) throw new UpstreamError('admin_storage', 403);
  const usage = new Map((db.usage ?? []).map((u) => [u.storeId, u]));
  const checks = new Map((db.checks ?? []).map((k) => [k.storeId, k.result]));
  const configError = storeConfigError(c.env);
  const configured = storeConfigs(c.env);
  const stores: StoreStatus[] = configured.map((s) => {
    const last = checks.get(s.id) ?? null;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      connection: s.connection,
      costPerTbMonthUsd: s.costPerTbMonthUsd ?? null,
      egressNote: s.egressNote ?? null,
      encryptionAtRest: s.encryptionAtRest,
      health: healthOf(last),
      lastCheck: last,
      objects: usage.get(s.id)?.objects ?? 0,
      bytes: usage.get(s.id)?.bytes ?? 0,
      current: s.id === db.writeStore,
    };
  });
  // Photos on a store the deployment no longer declares (or a config that doesn't parse): shown, unreachable.
  for (const [id, u] of usage) {
    if (configured.some((s) => s.id === id)) continue;
    stores.push({
      id,
      name: id,
      kind: 's3',
      connection: 'https',
      costPerTbMonthUsd: null,
      egressNote: null,
      encryptionAtRest: false,
      health: 'unreachable',
      lastCheck: {
        at: new Date().toISOString(),
        reachable: false,
        latencyMs: null,
        roundTrip: false,
        uploadMBps: null,
        freeBytes: null,
        capacityBytes: null,
        error: configError ?? 'unknown_store',
      },
      objects: u.objects,
      bytes: u.bytes,
      current: id === db.writeStore,
    });
  }
  return {
    ok: true,
    writeStore: db.writeStore,
    stores,
    migration: db.migration ?? null,
    totals: {
      photos: stores.reduce((n, s) => n + s.objects, 0),
      bytes: stores.reduce((n, s) => n + s.bytes, 0),
    },
    autoReadOnly: Boolean(db.autoReadOnly),
    oldCopies: (db.oldCopies ?? []).map((o) => ({
      storeId: o.storeId,
      copies: Number(o.copies) || 0,
      endsRollback: o.endsRollback === true,
    })),
    followups: {
      pending: Number(db.followups?.pending) || 0,
      dropped30d: Number(db.followups?.dropped30d) || 0,
    },
  };
}

function failed(c: Ctx, where: string, err: unknown) {
  logError(c.get('requestId'), where, err);
  if (err instanceof UpstreamError && err.status === 403) return c.json(fail('forbidden'), 403);
  if (err instanceof UpstreamError && err.status === 400) return c.json(fail('invalid'), 400);
  return c.json(fail('server'), 500);
}

/** Maps a database refusal (`{ error }`) to a response. */
function refused(c: Ctx, error: string) {
  if (error === 'forbidden') return c.json(fail('forbidden'), 403);
  if (error === 'not_found') return c.json(fail('not_found'), 404);
  if (error === 'invalid') return c.json(fail('invalid'), 400);
  return c.json(fail('conflict'), 409);
}

const actorOf = (c: Ctx) => c.get('staff').displayName?.trim() || 'A staff member';
const adminUrl = (c: Ctx) => `${(c.env.ADMIN_ORIGINS.split(',')[0] ?? '').trim()}/admin/storage`;

/** Emails every Owner after the response. Store ids only. */
async function tellOwners(c: Ctx, mail: { subject: string; html: string; text: string }, where: string) {
  const requestId = c.get('requestId');
  const env = c.env;
  await background(c, async () => {
    try {
      const owners = await rpc<string[]>(env, 'ai_alert_recipients', { p_who: 'owners' });
      for (const to of owners ?? []) await sendEmail(env, { to, ...mail });
    } catch (err) {
      logError(requestId, where, err);
    }
  });
}

/** Starts (or continues) the copy: the cron would pick it up within 5 minutes anyway. */
async function kick(c: Ctx, migration: string | null | undefined) {
  if (!migration) return;
  try {
    await c.env.STORAGE_QUEUE.send({ t: 'migrate', migration });
  } catch (err) {
    logError(c.get('requestId'), 'storage_enqueue', err);
  }
}

/**
 * /admin/api/v1/storage/*: Admin › Storage (docs/phase-8.md). Owner and Admin only. The switch and a rollback
 * need a passkey sign-in in the last 10 minutes and email every Owner; pause and resume save at once.
 * Abandoning old copies on a dead store is Owner only, with a passkey, and emails every Owner. Every change is
 * audited by its database function, with the reason.
 */
export function registerAdminStorageRoutes(router: Hono<HonoEnv>, requireStaff: RequireStaff) {
  router.get('/v1/storage', requireStaff(), canStorage, async (c) => {
    try {
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage', err);
    }
  });

  router.post('/v1/storage/stores/:id/check', requireStaff({ write: true }), canStorage, async (c) => {
    const id = storeIdSchema.safeParse(c.req.param('id'));
    if (!id.success || !storeConfigs(c.env).some((s) => s.id === id.data)) {
      return c.json(fail('not_found'), 404);
    }
    try {
      const status = await rpc<{ writeStore: string } | null>(c.env, 'storage_status');
      const check = await checkStore(c.env, id.data, true);
      await recordCheck(c.env, id.data, check, id.data === (status?.writeStore || 'r2'));
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage_check', err);
    }
  });

  router.post('/v1/storage/switch', requireStaff({ write: true }), canStorage, async (c) => {
    const body = await readBody(c, adminStorageSwitchSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (!c.get('staff').recentPasskey) return c.json(fail('reauth_required'), 403);
    const target = storeConfigs(c.env).find((s) => s.id === body.to);
    if (!target) return c.json(fail('not_found'), 404);
    // NFR-SEC-02: photos only move to a store the deployment declares encrypted at rest.
    if (!target.encryptionAtRest) return c.json(fail('invalid'), 400);
    try {
      const before = await storageOverview(c);
      if (before.writeStore === body.to) return c.json(fail('conflict'), 409);
      // The target must have passed a full check recently (Admin runs one before offering the switch).
      const last = before.stores.find((s) => s.id === body.to)?.lastCheck ?? null;
      if (!last || !checkOk(last) || Date.now() - Date.parse(last.at) > SWITCH_CHECK_MAX_AGE_MS) {
        return c.json(fail('conflict'), 409);
      }
      const res = await rpc<{ migrationId?: string; from?: string; to?: string; error?: string }>(
        c.env,
        'storage_switch',
        { p_staff: c.get('staff').id, p_to: body.to, p_reason: body.reason },
      );
      if (res?.error) return refused(c, res.error);
      await kick(c, res?.migrationId);
      await tellOwners(
        c,
        storageSwitchEmail({
          actor: actorOf(c),
          from: res?.from ?? before.writeStore,
          to: body.to,
          adminUrl: adminUrl(c),
        }),
        'storage_switch_notify',
      );
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage_switch', err);
    }
  });

  router.post('/v1/storage/migration', requireStaff({ write: true }), canStorage, async (c) => {
    const body = await readBody(c, adminStorageMigrationSchema);
    if (!body) return c.json(fail('invalid'), 400);
    // Pausing lowers risk and saves at once; resuming continues an approved switch. A rollback moves
    // photos again and changes where uploads go, so it is high-risk.
    if (body.action === 'rollback' && !c.get('staff').recentPasskey) {
      return c.json(fail('reauth_required'), 403);
    }
    try {
      const res = await rpc<{ migrationId?: string; from?: string; to?: string; error?: string }>(
        c.env,
        'storage_migration_action',
        { p_staff: c.get('staff').id, p_action: body.action, p_reason: body.reason },
      );
      if (res?.error) return refused(c, res.error);
      if (body.action !== 'pause') await kick(c, res?.migrationId);
      if (body.action === 'rollback') {
        await tellOwners(
          c,
          storageRollbackEmail({
            actor: actorOf(c),
            from: res?.from ?? '',
            to: res?.to ?? '',
            adminUrl: adminUrl(c),
          }),
          'storage_rollback_notify',
        );
      }
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage_migration', err);
    }
  });

  // Abandoning old copies on a store that's gone: Owner only, passkey, every Owner emailed. Only for a store
  // that fails a health check run now, or one a cleanly parsed config no longer declares (on a healthy store
  // the cron just deletes them). A config that doesn't parse leaves only R2 declared, so nothing is abandoned
  // then. Finishing a migration that could still be rolled back needs acknowledgeRollbackEnds.
  router.post('/v1/storage/abandon', requireStaff({ write: true }), canStorage, async (c) => {
    if (c.get('staff').role !== 'owner') return c.json(fail('forbidden'), 403);
    const body = await readBody(c, adminStorageAbandonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (!c.get('staff').recentPasskey) return c.json(fail('reauth_required'), 403);
    if (storeConfigError(c.env)) return c.json(fail('conflict'), 409);
    try {
      const configured = storeConfigs(c.env).some((s) => s.id === body.store);
      if (configured) {
        // A fresh check, recorded (and counted for auto read-only if it's the write store): a store that answers
        // now keeps its copies, whatever an older check said.
        const status = await rpc<{ writeStore: string } | null>(c.env, 'storage_status');
        const check = await checkStore(c.env, body.store, false);
        await recordCheck(c.env, body.store, check, body.store === (status?.writeStore || 'r2'));
        if (checkOk(check)) return c.json(fail('conflict'), 409);
      }
      const res = await rpc<{ store?: string; copies?: number; migrations?: number; error?: string }>(
        c.env,
        'storage_abandon_old_copies',
        {
          p_staff: c.get('staff').id,
          p_store: body.store,
          p_reason: body.reason,
          p_ack: body.acknowledgeRollbackEnds === true,
        },
      );
      if (res?.error) return refused(c, res.error);
      await tellOwners(
        c,
        storageAbandonEmail({
          actor: actorOf(c),
          store: body.store,
          copies: Number(res?.copies) || 0,
          adminUrl: adminUrl(c),
        }),
        'storage_abandon_notify',
      );
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage_abandon', err);
    }
  });

  // Giving up a failed rollback (its store is gone for good): Owner only, passkey, every Owner emailed. Uploads
  // go back to the store the photos had moved to, and read-only mode is re-evaluated against it straight away.
  router.post('/v1/storage/rollback/give-up', requireStaff({ write: true }), canStorage, async (c) => {
    if (c.get('staff').role !== 'owner') return c.json(fail('forbidden'), 403);
    const body = await readBody(c, adminStorageGiveUpSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (!c.get('staff').recentPasskey) return c.json(fail('reauth_required'), 403);
    try {
      const res = await rpc<{
        migrationId?: string;
        from?: string;
        to?: string;
        photos?: number;
        error?: string;
      }>(c.env, 'storage_rollback_give_up', { p_staff: c.get('staff').id, p_reason: body.reason });
      if (res?.error) return refused(c, res.error);
      try {
        if (res?.to) await reevaluateWriteStore(c.env, res.to);
      } catch (err) {
        // The cron re-checks the write store within 5 minutes anyway.
        logError('admin', 'admin_storage_give_up_check', err);
      }
      await tellOwners(
        c,
        storageGiveUpEmail({
          actor: actorOf(c),
          from: res?.from ?? '',
          to: res?.to ?? '',
          photos: Number(res?.photos) || 0,
          adminUrl: adminUrl(c),
        }),
        'storage_give_up_notify',
      );
      return c.json(await storageOverview(c));
    } catch (err) {
      return failed(c, 'admin_storage_give_up', err);
    }
  });
}
