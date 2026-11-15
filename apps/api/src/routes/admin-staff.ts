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
      // They're former staff now (account_kind refuses them on both sides); the ban also stops any sign-in path
      // and refresh token at Auth itself. A failed ban is logged; the database already shut them out.
      await gotrue
        .adminSetBanned(c.env, user, true)
        .catch((e) => logError(c.get('requestId'), 'staff_ban', e));
      await tellOwners(c, { kind: 'staff_removed', userId: user }, body.reason);
      return await staffView(c);
    } catch (err) {
      return serverError(c, 'admin_staff_remove', err);
    }
  });

  /**
   * The invite link. Cloudflare Access has already checked the identity (admin.ts); it must be the invited address.
   * `staff_invite_accept` only checks the token (live, unused, unrevoked) and refuses addresses that belong to a
   * member or to current staff (409 conflict); `staff_invite_complete` uses it up and adds the staff row in one
   * transaction.
   *
   * A former staff member coming back keeps their auth user (`existingUserId`). It stays banned until
   * `staff_invite_complete` has succeeded, and only then is it unbanned, so a second accept of the same link (two
   * tabs, a retry) that loses the race changes nothing at Auth and can never re-ban someone who is staff again.
   * A staff row whose auth user is still banned (the unban failed) does no harm: signing in fails until an Owner
   * removes and re-invites them, and it's logged.
   *
   * A new address gets a fresh auth user first (staff_invite_complete needs its id). If completing fails or
   * throws, that user is deleted only while `account_kind` still says it isn't staff, so a commit whose reply was
   * lost never leaves a staff row without its auth user.
   */
  router.post(STAFF_ACCEPT_PATH, async (c) => {
    if (!(await burstOk(c, 'staff_invite'))) return rateLimited(c, 60);
    const body = await readBody(c, staffInviteTokenSchema);
    if (!body) return c.json(fail('invite_invalid'), 400);
    const invalid = () => c.json(fail('invite_invalid'), 400);
    let created: { userId: string; email: string } | null = null;
    try {
      const invite = await rpc<{
        inviteId: string;
        email: string;
        role: string;
        existingUserId?: string | null;
      } | null>(c.env, 'staff_invite_accept', {
        p_token_hash: await inviteTokenHash(body.token),
      });
      if (!invite) return invalid();
      if (isDbError(invite)) {
        if (invite.error === 'member_account' || invite.error === 'already_staff')
          return c.json(fail('conflict'), 409);
        return invalid();
      }
      const email = invite.email.toLowerCase();
      if (email !== c.get('accessEmail')) return c.json(fail('forbidden'), 403);
      const existing = invite.existingUserId ?? null;
      let userId: string;
      if (existing) {
        userId = existing;
      } else {
        try {
          userId = (await gotrue.adminCreateUser(c.env, email)).id;
        } catch (err) {
          if (err instanceof UpstreamError && (err.status === 422 || err.status === 409)) {
            return c.json(fail('conflict'), 409);
          }
          throw err;
        }
        created = { userId, email };
      }
      const done = await rpc<unknown>(c.env, 'staff_invite_complete', {
        p_invite_id: invite.inviteId,
        p_user_id: userId,
      });
      if (!done || isDbError(done)) {
        // Lost a race (used or revoked meanwhile). A former staff member was never unbanned, so there's nothing
        // to undo for them; a user created just now is removed (unless it somehow became staff).
        await dropCreated(c, created);
        return invalid();
      }
      created = null;
      // A failed unban throws to the catch below: logged, 500, and the staff row stays (harmless while banned).
      if (existing) {
        await gotrue.adminSetBanned(c.env, userId, false);
        // An Owner may have removed them again between completing and the unban (which then undid the removal's
        // ban): re-checked after unbanning, and banned again unless they're still staff.
        await rebanUnlessStaff(c, userId, email);
      }
      return c.json({ ok: true, email });
    } catch (err) {
      await dropCreated(c, created);
      return serverError(c, 'staff_invite_accept', err);
    }
  });
}

/**
 * After a returning staff member's unban: if the address isn't staff any more (removed again in between), the
 * auth user is banned again. If the check fails they stay unbanned (logged): the database still refuses a
 * former staff member on both sides, so only the extra Auth-level ban would be missing, whereas banning a
 * returning member of staff on a transient error would lock them out until they're re-invited.
 */
async function rebanUnlessStaff(c: Ctx, userId: string, email: string) {
  try {
    if ((await rpc<string>(c.env, 'account_kind', { p_email: email })) === 'staff') return;
    await gotrue.adminSetBanned(c.env, userId, true);
  } catch (err) {
    logError(c.get('requestId'), 'staff_reban', err);
  }
}

/** Deletes an auth user created for an invite that didn't complete, unless the address is staff after all. */
async function dropCreated(c: Ctx, created: { userId: string; email: string } | null) {
  if (!created) return;
  try {
    if ((await rpc<string>(c.env, 'account_kind', { p_email: created.email })) === 'staff') return;
    await gotrue.adminDeleteUser(c.env, created.userId);
  } catch (err) {
    logError(c.get('requestId'), 'staff_orphan', err);
  }
}
