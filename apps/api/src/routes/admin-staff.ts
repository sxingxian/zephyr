/**
 * /admin/api/v1/staff/* (docs/phase-8.md › Staff). Owner only. There's always at least one Owner (the database
 * answers `last_owner`). Invites are email-bound, single-use, stored as a SHA-256, 72 hours, and still behind
 * Cloudflare Access.
 *
 *   GET    /staff                  staff
 *   POST   /staff/invites          staff · passkey · Owners emailed (the invitee gets the link)
 *   DELETE /staff/invites/:id      staff (revoking lowers risk: saves at once)
 *   PATCH  /staff/:userId          staff · passkey · Owners emailed
 *   DELETE /staff/:userId          staff · passkey · Owners emailed (the database ends their admin sessions)
 *   POST   /staff/invite/accept    no staff session: the Access identity must be the invited address
 *
 * Accepting creates the staff auth user the way supabase/README.md creates the first Owner (an auto-confirmed
 * auth user, then the staff row); the normal admin email-code sign-in and passkey enrolment follow.
 */
import {
  type AdminStaffResult,
  adminReasonSchema,
  adminStaffInviteSchema,
  adminStaffPatchSchema,
  staffInviteTokenSchema,
} from '@zephyr/shared';
import { except } from 'hono/combine';
import { gotrue } from '../auth/gotrue';
import { inviteTokenHash, newInviteToken } from '../crypto';
import { staffInviteEmail } from '../email/admin-templates';
import { sendEmail } from '../email/resend';
import { burstOk, fail, logError, rateLimited, readBody } from '../http';
import { rpc, UpstreamError } from '../supabase';
import {
  type AdminRouter,
  adminOrigin,
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

export const STAFF_ACCEPT_PATH = '/v1/staff/invite/accept';
/** The admin app's accept page; the token rides in the fragment so it never reaches a server log. */
export const staffInviteLink = (origin: string, token: string) => `${origin}/admin/staff-invite#t=${token}`;

async function staffView(c: Ctx) {
  const out = await rpc<Omit<AdminStaffResult, 'ok'>>(c.env, 'admin_staff', { p_staff: staffId(c) });
  if (isDbError(out)) return dbError(c, out);
  return c.json({ ok: true, ...out } satisfies AdminStaffResult);
}

export function registerAdminStaffRoutes(router: AdminRouter, requireStaff: RequireStaff) {
  router.use(
    '/v1/staff/*',
    except((c) => c.req.path.endsWith(STAFF_ACCEPT_PATH), requireStaff(), adminWriteLimit),
  );

  router.get('/v1/staff', can('staff'), async (c) => {
    try {
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff', err);
    }
  });

  router.post('/v1/staff/invites', can('staff'), async (c) => {
    const body = await readBody(c, adminStaffInviteSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    const { token, hash } = await newInviteToken();
    try {
      const out = await rpc<{ id: string; expiresAt: string }>(c.env, 'admin_staff_invite', {
        p_staff: staffId(c),
        p_email: body.email,
        p_role: body.role,
        p_token_hash: hash,
        p_reason: body.reason,
      });
      if (isDbError(out)) return dbError(c, out);
      try {
        await sendEmail(c.env, {
          to: body.email,
          ...staffInviteEmail({
            role: body.role,
            link: staffInviteLink(adminOrigin(c), token),
            expiresAt: out.expiresAt,
          }),
          idempotencyKey: `staff-invite:${out.id}`,
        });
      } catch (err) {
        // An invite nobody received is revoked, so a later one isn't blocked by it.
        logError(c.get('requestId'), 'staff_invite_email', err);
        await rpc(c.env, 'admin_staff_invite_revoke', { p_staff: staffId(c), p_invite: out.id }).catch((e) =>
          logError(c.get('requestId'), 'staff_invite_revoke', e),
        );
        return c.json(fail('server'), 502);
      }
      await tellOwners(c, { kind: 'staff_invited', role: body.role }, body.reason);
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff_invite', err);
    }
  });

  router.delete('/v1/staff/invites/:id', can('staff'), async (c) => {
    const id = idParam(c);
    if (!id) return c.json(fail('not_found'), 404);
    try {
      const out = await rpc<unknown>(c.env, 'admin_staff_invite_revoke', {
        p_staff: staffId(c),
        p_invite: id,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff_invite_revoke', err);
    }
  });

  router.patch('/v1/staff/:userId', can('staff'), async (c) => {
    const user = idParam(c, 'userId');
    if (!user) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminStaffPatchSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    try {
      const out = await rpc<unknown>(c.env, 'admin_staff_set_role', {
        p_staff: staffId(c),
        p_user: user,
        p_role: body.role,
        p_reason: body.reason,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      await tellOwners(c, { kind: 'staff_role', userId: user, role: body.role }, body.reason);
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff_set_role', err);
    }
  });

  router.delete('/v1/staff/:userId', can('staff'), async (c) => {
    const user = idParam(c, 'userId');
    if (!user) return c.json(fail('not_found'), 404);
    const body = await readBody(c, adminReasonSchema);
    if (!body) return c.json(fail('invalid'), 400);
    if (needsReauth(c)) return reauth(c);
    try {
      const out = await rpc<unknown>(c.env, 'admin_staff_remove', {
        p_staff: staffId(c),
        p_user: user,
        p_reason: body.reason,
      });
      if (isDbError(out)) return dbError(c, out);
      if (out === null || out === false) return c.json(fail('not_found'), 404);
      await tellOwners(c, { kind: 'staff_removed', userId: user }, body.reason);
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff_remove', err);
    }
  });

  /**
   * The invite link. Cloudflare Access has already checked the identity (admin.ts); it must be the invited address.
   * `staff_invite_accept` only checks the token (live, unused, unrevoked) and refuses addresses that already have
   * an account; `staff_invite_complete` uses it up and adds the staff row in one transaction.
   */
  router.post(STAFF_ACCEPT_PATH, async (c) => {
    if (!(await burstOk(c, 'staff_invite'))) return rateLimited(c, 60);
    const body = await readBody(c, staffInviteTokenSchema);
    if (!body) return c.json(fail('invite_invalid'), 400);
    const invalid = () => c.json(fail('invite_invalid'), 400);
    try {
      const invite = await rpc<{ inviteId: string; email: string; role: string } | null>(
        c.env,
        'staff_invite_accept',
        {
          p_token_hash: await inviteTokenHash(body.token),
        },
      );
      if (!invite) return invalid();
      if (isDbError(invite)) {
        if (invite.error === 'member_account' || invite.error === 'already_staff')
          return c.json(fail('conflict'), 409);
        return invalid();
      }
      const email = invite.email.toLowerCase();
      if (email !== c.get('accessEmail')) return c.json(fail('forbidden'), 403);
      let userId: string;
      try {
        userId = (await gotrue.adminCreateUser(c.env, email)).id;
      } catch (err) {
        if (err instanceof UpstreamError && (err.status === 422 || err.status === 409)) {
          return c.json(fail('conflict'), 409);
        }
        throw err;
      }
      const done = await rpc<unknown>(c.env, 'staff_invite_complete', {
        p_invite_id: invite.inviteId,
        p_user_id: userId,
      });
      if (!done || isDbError(done)) {
        // Lost a race (used or revoked meanwhile): don't leave an orphan auth user behind.
        await gotrue
          .adminDeleteUser(c.env, userId)
          .catch((e) => logError(c.get('requestId'), 'staff_orphan', e));
        return invalid();
      }
      return c.json({ ok: true, email });
    } catch (err) {
      return serverError(c, 'staff_invite_accept', err);
    }
  });
}
