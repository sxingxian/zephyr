/**
 * /admin/api/v1/retention/* (docs/phase-8.md › Retention). A year after a paid plan lapses, the oldest photos beyond
 * the Free storage move to the member's Trash (30-day undo): only after the 30- and 7-day emails, and only once
 * staff approve the batch. Held photos and photos in live galleries are skipped (in SQL).
 *
 *   GET  /retention            retention
 *   POST /retention/approve    retention · passkey · Owners emailed
 */
import { type AdminRetentionResult, adminRetentionApproveSchema } from '@zephyr/shared';
import { runRetentionBatches } from '../admin/cron';
import { background, fail, logError, readBody } from '../http';
import { rpc } from '../supabase';
import {
  type AdminRouter,
  adminWriteLimit,
  type Ctx,
  can,
  dbError,
  isDbError,
  needsReauth,
  type RequireStaff,
  reauth,
  serverError,
  staffId,
  tellOwners,
} from './admin-common';

async function retentionView(c: Ctx) {
  const out = await rpc<Omit<AdminRetentionResult, 'ok'>>(c.env, 'admin_retention', { p_staff: staffId(c) });
  if (isDbError(out)) return dbError(c, out);
  return c.json({ ok: true, ...out } satisfies AdminRetentionResult);
}

export function registerAdminRetentionRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/retention/*', requireStaff(), adminWriteLimit);

  router.get('/v1/retention', can('retention'), async (c) => {
    try {
      return await retentionView(c);
    } catch (err) {
      return serverError(c, 'admin_retention', err);
    }
  });

  router.post('/v1/retention/approve', can('retention'), async (c) => {
    const body = await readBody(c, adminRetentionApproveSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const ownerIds = [...new Set(body.ownerIds)];
    if (needsReauth(c)) return reauth(c);
    try {
      // Only items in the `ready` state are approved; the count says how many were.
      const out = await rpc<{ approved: number }>(c.env, 'admin_retention_approve', {
        p_staff: staffId(c),
        p_owner_ids: ownerIds,
        p_reason: body.reason,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out.approved > 0) {
        await tellOwners(c, { kind: 'retention_approved', libraries: out.approved }, body.reason);
        // Start now; the quarter-hour cron finishes what's left.
        const env = c.env;
        const requestId = c.get('requestId');
        await background(c, () =>
          runRetentionBatches(env).then(
            () => undefined,
            (err) => logError(requestId, 'retention_batches', err),
          ),
        );
      }
      return await retentionView(c);
    } catch (err) {
      return serverError(c, 'admin_retention_approve', err);
    }
  });
}
