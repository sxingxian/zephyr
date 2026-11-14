/**
 * /admin/api/v1/users/* (docs/phase-8.md › Users). Lists mask emails; the detail view shows the full address and
 * is audit-logged by the database. Staff never get photo bytes here.
 *
 *   GET    /users                        usersView
 *   GET    /users/:id                    usersView
 *   PUT    /users/:id/plan               planOverride · passkey · Owners emailed
 *   DELETE /users/:id/plan               planOverride (ends a comp; saves at once)
 *   POST   /users/:id/credits            usersAct (Support ≤ 1,000; more: Owner/Admin + passkey + Owners emailed)
 *   POST   /users/:id/sign-out           usersAct
 *   POST   /users/:id/suspension         suspend (saves at once; optional member email)
 *   DELETE /users/:id/suspension         suspend · passkey · Owners emailed
 *   DELETE /users/:id/sharing-suspension suspend · passkey · Owners emailed
 *   POST   /users/:id/deletion           deleteAccount · passkey · Owners emailed
 *   DELETE /users/:id/deletion           deleteAccount
 */
import {
  type AdminUserDetail,
  type AdminUserResult,
  type AdminUsersResult,
  adminCreditGrantSchema,
  adminPlanOverrideSchema,
  adminReasonSchema,
  adminSuspendSchema,
  adminUsersQuerySchema,
  SUPPORT_CREDIT_GRANT_MAX,
} from '@zephyr/shared';
import { cancelForDeletion, undoCancelForDeletion } from '../billing/deletion';
import { suspendedEmail } from '../email/admin-templates';
import { sendEmail } from '../email/resend';
import { background, fail, logError, readBody } from '../http';
import { rpc } from '../supabase';
import {
  type AdminRouter,
  adminWriteLimit,
  type Ctx,
  can,
  dbError,
  idParam,
  isDbError,
  needsReauth,
  type RequireStaff,
  reauth,
  serverError,
  staffId,
  tellOwners,
} from './admin-common';

const MAX_OVERRIDE_MS = 2 * 366 * 24 * 3600 * 1000;

async function detail(c: Ctx, user: string) {
  const u = await rpc<AdminUserDetail | null>(c.env, 'admin_user', { p_staff: staffId(c), p_user: user });
  return u ? c.json({ ok: true, user: u } satisfies AdminUserResult) : c.json(fail('not_found'), 404);
}

/** Runs a staff function that answers `{ error }` or anything else, then returns the fresh detail. */
async function act(c: Ctx, user: string, fn: string, args: Record<string, unknown>, where = fn) {
  try {
    const out = await rpc<unknown>(c.env, fn, { p_staff: staffId(c), p_user: user, ...args });
    if (isDbError(out)) return { res: dbError(c, out), out };
    if (out === null || out === false) return { res: c.json(fail('not_found'), 404), out };
    return { res: null, out };
  } catch (err) {
    return { res: serverError(c, where, err), out: null };
  }
}

export function registerAdminUserRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use('/v1/users/*', requireStaff(), adminWriteLimit);

  router.get('/v1/users', can('usersView'), async (c) => {
    const q = adminUsersQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json(fail('invalid'), 400);
    try {
      const out = await rpc<Omit<AdminUsersResult, 'ok'>>(c.env, 'admin_users', {
        p_staff: staffId(c),
        p_q: q.data.q?.trim() || null,
        p_plan: q.data.plan ?? null,
        p_source: q.data.source ?? null,
        p_status: q.data.status ?? null,
        p_cursor: q.data.cursor ?? null,
      });
      if (isDbError(out)) return dbError(c, out);
      return c.json({ ok: true, ...out } satisfies AdminUsersResult);
    } catch (err) {
      return serverError(c, 'admin_users', err);
    }
  });

  router.get('/v1/users/:id', can('usersView'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    try {
      return await detail(c, id);
    } catch (err) {
      return serverError(c, 'admin_user', err);
    }
  });

  router.put('/v1/users/:id/plan', can('planOverride'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminPlanOverrideSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (body.until) {
      const t = Date.parse(body.until);
      if (!(t > Date.now() && t - Date.now() <= MAX_OVERRIDE_MS)) return c.json(fail('invalid'), 400);
    }
    if (needsReauth(c)) return reauth(c);
    const { res } = await act(c, id, 'admin_user_override', {
      p_plan: body.plan,
      p_until: body.until,
      p_reason: body.reason,
    });
    if (res) return res;
    await tellOwners(
      c,
      { kind: 'plan_override', userId: id, plan: body.plan, until: body.until },
      body.reason,
    );
    return detail(c, id);
  });

  router.delete('/v1/users/:id/plan', can('planOverride'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { res } = await act(c, id, 'admin_user_override_end', { p_reason: body.reason });
    return res ?? detail(c, id);
  });

  router.post('/v1/users/:id/credits', can('usersAct'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminCreditGrantSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const role = c.get('staff').role;
    const large = body.amount > SUPPORT_CREDIT_GRANT_MAX;
    if (large && role !== 'owner' && role !== 'admin') return c.json(fail('forbidden'), 403);
    if (large && needsReauth(c)) return reauth(c);
    const { res } = await act(c, id, 'admin_user_grant_credits', {
      p_amount: body.amount,
      p_reason: body.reason,
    });
    if (res) return res;
    if (large) await tellOwners(c, { kind: 'credits', userId: id, amount: body.amount }, body.reason);
    return detail(c, id);
  });

  router.post('/v1/users/:id/sign-out', can('usersAct'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { res } = await act(c, id, 'admin_user_sign_out', { p_reason: body.reason });
    return res ?? detail(c, id);
  });

  router.post('/v1/users/:id/suspension', can('suspend'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminSuspendSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { res, out } = await act(c, id, 'admin_user_suspend', {
      p_category: body.category,
      p_note: body.note,
    });
    if (res) return res;
    // The member's own address comes back from the database only for this email; never logged.
    const email =
      typeof (out as { email?: unknown })?.email === 'string' ? (out as { email: string }).email : null;
    if (body.notify && email) {
      const env = c.env;
      const requestId = c.get('requestId');
      await background(c, async () => {
        try {
          await sendEmail(env, { to: email, ...suspendedEmail({ appUrl: env.APP_URL }) });
        } catch (err) {
          logError(requestId, 'suspended_email', err);
        }
      });
    }
    return detail(c, id);
  });

  router.delete('/v1/users/:id/suspension', can('suspend'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    const { res } = await act(c, id, 'admin_user_unsuspend', { p_reason: body.reason });
    if (res) return res;
    await tellOwners(c, { kind: 'unsuspend', userId: id }, body.reason);
    return detail(c, id);
  });

  router.delete('/v1/users/:id/sharing-suspension', can('suspend'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    const { res } = await act(c, id, 'admin_user_sharing_lift', { p_reason: body.reason });
    if (res) return res;
    await tellOwners(c, { kind: 'sharing_lift', userId: id }, body.reason);
    return detail(c, id);
  });

  router.post('/v1/users/:id/deletion', can('deleteAccount'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    const { res, out } = await act(c, id, 'admin_user_deletion_schedule', { p_reason: body.reason });
    if (res) return res;
    // Phase 7: renewal stops while the deletion is pending (same path as a member's own request).
    const env = c.env;
    const requestId = c.get('requestId');
    await background(c, () =>
      cancelForDeletion(env, id, out).catch((err) => logError(requestId, 'admin_deletion_billing', err)),
    );
    await tellOwners(c, { kind: 'deletion_scheduled', userId: id }, body.reason);
    return detail(c, id);
  });

  router.delete('/v1/users/:id/deletion', can('deleteAccount'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { res, out } = await act(c, id, 'admin_user_deletion_cancel', { p_reason: body.reason });
    if (res) return res;
    const env = c.env;
    const requestId = c.get('requestId');
    await background(c, () =>
      undoCancelForDeletion(env, id, out).catch((err) =>
        logError(requestId, 'admin_deletion_billing_undo', err),
      ),
    );
    return detail(c, id);
  });
}
