/**
 * /admin/api/v1/limits/* (docs/phase-8.md › Plan limits). One version applies to everyone on a set date. A version
 * with only increases may apply now; any decrease needs a date at least 30 days out (the database refuses sooner
 * with `notice`), and the affected members are emailed in batches by the quarter-hour cron.
 *
 *   GET    /limits                   limitsView
 *   POST   /limits/draft             limits (start a draft from a version; one draft at a time)
 *   PUT    /limits/draft             limits
 *   DELETE /limits/draft             limits
 *   POST   /limits/draft/preview     limits
 *   POST   /limits/draft/schedule    limits · passkey · Owners emailed
 *   DELETE /limits/scheduled         limits (cancelling lowers risk: saves at once)
 */
import {
  type AdminLimitsPreviewResult,
  type AdminLimitsResult,
  adminLimitsDraftSchema,
  adminLimitsFromSchema,
  adminLimitsPreviewSchema,
  adminLimitsScheduleSchema,
  adminReasonSchema,
} from '@zephyr/shared';
import { sendLimitsNotices } from '../admin/cron';
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

async function limitsView(c: Ctx) {
  const out = await rpc<Omit<AdminLimitsResult, 'ok'>>(c.env, 'admin_limits', { p_staff: staffId(c) });
  if (isDbError(out)) return dbError(c, out);
  return c.json({ ok: true, ...out } satisfies AdminLimitsResult);
}

/** Runs a limits write, then answers with the fresh limits view. */
async function write(c: Ctx, fn: string, args: Record<string, unknown>) {
  try {
    const out = await rpc<unknown>(c.env, fn, { p_staff: staffId(c), ...args });
    if (isDbError(out)) return dbError(c, out);
    return await limitsView(c);
  } catch (err) {
    return serverError(c, fn, err);
  }
}

export function registerAdminLimitsRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/limits/*', requireStaff(), adminWriteLimit);

  router.get('/v1/limits', can('limitsView'), async (c) => {
    try {
      return await limitsView(c);
    } catch (err) {
      return serverError(c, 'admin_limits', err);
    }
  });

  router.post('/v1/limits/draft', can('limits'), async (c) => {
    const body = await readBody(c, adminLimitsFromSchema);
    if (!body) return c.json(fail('invalid'), 400);
    return write(c, 'admin_limits_draft_create', { p_from: body.fromVersion });
  });

  router.put('/v1/limits/draft', can('limits'), async (c) => {
    const body = await readBody(c, adminLimitsDraftSchema);
    if (!body) return c.json(fail('invalid'), 400);
    return write(c, 'admin_limits_draft_save', { p_limits: body.limits });
  });

  router.delete('/v1/limits/draft', can('limits'), (c) => write(c, 'admin_limits_draft_delete', {}));

  router.post('/v1/limits/draft/preview', can('limits'), async (c) => {
    const body = await readBody(c, adminLimitsPreviewSchema);
    if (!body) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<Omit<AdminLimitsPreviewResult, 'ok'>>(c.env, 'admin_limits_preview', {
        p_staff: staffId(c),
        p_effective_at: body.effectiveAt,
      });
      if (isDbError(out)) return dbError(c, out);
      return c.json({ ok: true, ...out } satisfies AdminLimitsPreviewResult);
    } catch (err) {
      return serverError(c, 'admin_limits_preview', err);
    }
  });

  router.post('/v1/limits/draft/schedule', can('limits'), async (c) => {
    const body = await readBody(c, adminLimitsScheduleSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (body.effectiveAt && Date.parse(body.effectiveAt) <= Date.now()) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    try {
      const out = await rpc<{ version: number; effectiveAt: string | null; decreases: boolean }>(
        c.env,
        'admin_limits_schedule',
        { p_staff: staffId(c), p_effective_at: body.effectiveAt, p_reason: body.reason },
      );
      if (isDbError(out)) return dbError(c, out);
      await tellOwners(
        c,
        {
          kind: 'limits_scheduled',
          version: out.version,
          effectiveAt: out.effectiveAt,
          decreases: out.decreases,
        },
        body.reason,
      );
      if (out.decreases) {
        // First batch now; the quarter-hour cron sends the rest.
        const env = c.env;
        const requestId = c.get('requestId');
        await background(c, () =>
          sendLimitsNotices(env).then(
            () => undefined,
            (err) => logError(requestId, 'limits_notices', err),
          ),
        );
      }
      return await limitsView(c);
    } catch (err) {
      return serverError(c, 'admin_limits_schedule', err);
    }
  });

  router.delete('/v1/limits/scheduled', can('limits'), async (c) => {
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    return write(c, 'admin_limits_cancel', { p_reason: body.reason });
  });
}
