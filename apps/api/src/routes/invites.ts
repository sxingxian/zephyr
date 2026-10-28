import {
  type Accepted,
  type InvitePreview,
  type InviteRow,
  inviteCodeSchema,
  invitePreviewSchema,
  inviteRedeemSchema,
  type MemberInvites,
  memberInviteSchema,
} from '@zephyr/shared';
import { type Context, Hono } from 'hono';
import { gotrue, mintSession } from '../auth/gotrue';
import { inviteTokenHash, newInviteToken } from '../crypto';
import { sendEmail } from '../email/resend';
import { inviteEmail } from '../email/templates';
import { type Env, list } from '../env';
import {
  background,
  burstOk,
  clientIp,
  fail,
  guardWrite,
  limitHit,
  logError,
  networkHash,
  rateLimited,
  readBody,
} from '../http';
import { rpc, UpstreamError } from '../supabase';
import { TURNSTILE_ACTIONS, verifyTurnstile } from '../turnstile';
import type { HonoEnv } from '../types';
import { startMemberSession } from './app-auth';
import { requireMember } from './session-helpers';

const WINDOW = 15 * 60;
export const INVITE_LIMITS = { linkPerNetwork: 20, codePerNetwork: 5 } as const;
const ACCEPTED: Accepted = { ok: true };
const INVALID = () => fail('invite_invalid');

interface PreviewRow {
  id: string;
  email: string;
  inviterName: string | null;
  expiresAt: string;
}
interface CreateResult {
  status: string;
  id?: string;
  expiresAt?: string;
}

export const inviteLink = (env: Env, token: string) => `${env.APP_URL.replace(/\/$/, '')}/join#t=${token}`;

/** Sends an invite email. The token only ever exists here and in the email. */
export async function sendInvite(
  env: Env,
  to: string,
  token: string,
  expiresAt: string,
  inviterName: string | null,
  note: string | null,
  idempotencyKey?: string,
) {
  const mail = inviteEmail({ inviterName, note, link: inviteLink(env, token), expiresAt });
  await sendEmail(env, { to, ...mail, idempotencyKey });
}

/** /api/v1/invites/*: opening invite links, invite codes and member invites. */
export const inviteRoutes = new Hono<HonoEnv>();
inviteRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS)),
);

async function linkLimitOk(c: Context<HonoEnv>) {
  if (!(await burstOk(c, 'invite_link'))) return false;
  return limitHit(c.env, 'invite_link', await networkHash(c), INVITE_LIMITS.linkPerNetwork, WINDOW);
}

/** Unknown, expired, revoked and used links all get the same 404. */
inviteRoutes.post('/preview', async (c) => {
  const body = await readBody(c, invitePreviewSchema);
  try {
    if (!(await linkLimitOk(c))) return rateLimited(c, WINDOW);
    if (!body) return c.json(INVALID(), 404);
    const row = await rpc<PreviewRow | null>(c.env, 'preview_invite', {
      p_token_hash: await inviteTokenHash(body.token),
    });
    if (!row) return c.json(INVALID(), 404);
    const out: InvitePreview = {
      ok: true,
      email: row.email,
      inviterName: row.inviterName ?? null,
      expiresAt: row.expiresAt,
    };
    return c.json(out);
  } catch (err) {
    logError(c.get('requestId'), 'invite_preview', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Opening the link proves the address, so redeeming creates the account (already confirmed) and signs
 * the person in. Confirming the account consumes every live invite for that email. An invite whose
 * email already has an account isn't redeemable: that person signs in instead. Every failure looks
 * like an invalid link.
 */
inviteRoutes.post('/redeem', async (c) => {
  const body = await readBody(c, inviteRedeemSchema);
  const requestId = c.get('requestId');
  try {
    if (!(await linkLimitOk(c))) return rateLimited(c, WINDOW);
    if (!body) return c.json(INVALID(), 404);
    const invite = await rpc<PreviewRow | null>(c.env, 'preview_invite', {
      p_token_hash: await inviteTokenHash(body.token),
    });
    if (!invite) return c.json(INVALID(), 404);
    if ((await rpc<string>(c.env, 'account_kind', { p_email: invite.email })) !== 'none') {
      return c.json(INVALID(), 404);
    }

    try {
      const user = await gotrue.adminCreateUser(c.env, invite.email, body.displayName);
      if (body.displayName) {
        await rpc(c.env, 'update_display_name', { p_user_id: user.id, p_name: body.displayName });
      }
    } catch (err) {
      // 422: someone redeemed it a moment ago (the account exists now). 403: the sign-up hook refused
      // (sign-ups paused, or the invite stopped being valid).
      if (err instanceof UpstreamError && err.status < 500) return c.json(INVALID(), 404);
      throw err;
    }

    const session = await mintSession(c.env, invite.email);
    return await startMemberSession(c, session, { isNew: true });
  } catch (err) {
    logError(requestId, 'invite_redeem', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Invite codes: a valid code plus an email sends a sign-up link to that address. The reply is the
 * same whether the code was valid, used up, unknown, the email already has an account or a live
 * invite, or already got a code invite today, and the email goes out after the response. Only a newly
 * created invite sends anything, so a known code can't be used to flood an inbox.
 */
inviteRoutes.post('/code', async (c) => {
  if (!(await burstOk(c, 'invite_code'))) return rateLimited(c, 60);
  const body = await readBody(c, inviteCodeSchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c), TURNSTILE_ACTIONS.inviteCode))) {
    return c.json(fail('verification_failed'), 403);
  }
  const requestId = c.get('requestId');
  try {
    if (!(await limitHit(c.env, 'invite_code', await networkHash(c), INVITE_LIMITS.codePerNetwork, WINDOW))) {
      return rateLimited(c, WINDOW);
    }
    const { token, hash } = await newInviteToken();
    const res = await rpc<CreateResult>(c.env, 'redeem_invite_code', {
      p_code: body.code,
      p_email: body.email,
      p_token_hash: hash,
    });
    if (res.status === 'created' && res.id && res.expiresAt) {
      const expiresAt = res.expiresAt;
      const inviteId = res.id;
      await background(c, async () => {
        try {
          await sendInvite(c.env, body.email, token, expiresAt, null, null, inviteId);
        } catch (err) {
          logError(requestId, 'invite_code_send', err);
        }
      });
    }
    return c.json(ACCEPTED, 202);
  } catch (err) {
    logError(requestId, 'invite_code', err);
    return c.json(fail('server'), 500);
  }
});

inviteRoutes.get('/mine', requireMember, async (c) => {
  try {
    const out = await rpc<Omit<MemberInvites, 'ok'>>(c.env, 'list_member_invites', {
      p_user_id: c.get('session').userId,
    });
    return c.json({ ok: true, ...out } satisfies MemberInvites);
  } catch (err) {
    logError(c.get('requestId'), 'invites_mine', err);
    return c.json(fail('server'), 500);
  }
});

const monthEndSeconds = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
};

/**
 * A member invites someone (quota per calendar month). The email carries Zephyr's wording only (no
 * free-text note). If it can't be sent, the invite is revoked so no unsent link stays live.
 */
inviteRoutes.post('/', requireMember, async (c) => {
  if (!(await burstOk(c, 'member_invite'))) return rateLimited(c, 60);
  const body = await readBody(c, memberInviteSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const s = c.get('session');
  const requestId = c.get('requestId');
  try {
    const { token, hash } = await newInviteToken();
    const res = await rpc<CreateResult>(c.env, 'create_invite', {
      p_email: body.email,
      p_token_hash: hash,
      p_source: 'member',
      p_invited_by: s.userId,
      p_code_id: null,
      p_note: null,
    });
    switch (res.status) {
      case 'created':
        break;
      case 'member_invites_disabled':
        return c.json(fail('member_invites_disabled'), 403);
      case 'signups_paused':
        return c.json(fail('signups_paused'), 403);
      case 'quota_exceeded':
        return c.json(fail('quota_exceeded', { retryAfter: monthEndSeconds() }), 429);
      case 'already_member':
        return c.json(fail('already_member'), 409);
      case 'already_invited':
        return c.json(fail('conflict'), 409);
      default:
        return c.json(fail('invalid'), 400);
    }
    if (!res.id || !res.expiresAt) throw new Error('UnexpectedResult');
    const { id, expiresAt } = res;
    const inviterName = c.get('profile').displayName ?? null;
    try {
      await sendInvite(c.env, body.email, token, expiresAt, inviterName, null, id);
    } catch (err) {
      logError(requestId, 'member_invite_send', err);
      await rpc(c.env, 'revoke_unsent_invite', { p_id: id, p_invited_by: s.userId });
      return c.json(fail('server'), 500);
    }
    const invite: InviteRow = {
      id,
      email: body.email,
      status: 'pending',
      source: 'member',
      invitedBy: inviterName ?? 'A member',
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    return c.json({ ok: true, invite }, 201);
  } catch (err) {
    logError(requestId, 'member_invite', err);
    return c.json(fail('server'), 500);
  }
});
