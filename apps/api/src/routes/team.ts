/**
 * Phase 7 Studio teams (docs/phase-7.md, TEAM_API):
 *   GET            /api/v1/libraries                    the member's own library and their team libraries
 *   DELETE         /api/v1/libraries/:ownerId           leave a team library
 *   GET/PATCH      /api/v1/team                         the owner's team (always their own library)
 *   POST           /api/v1/team/invites                 invite by email (Studio, a free seat)
 *   POST/DELETE    /api/v1/team/invites/:id             resend (new token) / revoke
 *   PATCH/DELETE   /api/v1/team/members/:memberId       change role / remove (?replaceLinks=1, phase 8)
 *   POST           /api/v1/team/invite/preview          no session: what an invite link is for
 *   POST           /api/v1/team/invite/accept           signed in with the invited email
 * Team management is personal: it ignores X-Zephyr-Library and always acts on the signed-in member's own
 * library, so an Editor can never manage the team they belong to. The database checks seats under a lock.
 */
import {
  GALLERY_LINKS_REPLACE_MAX,
  type LibrariesResult,
  type LibrarySummary,
  TEAM_REMOVE_REPLACE_LINKS_PARAM,
  type Team,
  type TeamInvitePreview,
  type TeamInvitePreviewResult,
  type TeamResult,
  type TeamRole,
  teamInviteSchema,
  teamInviteTokenSchema,
  teamMemberPatchSchema,
  teamNamePatchSchema,
} from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { inviteTokenHash, newInviteToken } from '../crypto';
import { sendEmail } from '../email/resend';
import { teamInviteEmail } from '../email/team-templates';
import { type Env, list } from '../env';
import { burstOk, fail, guardWrite, limitHit, logError, networkHash, rateLimited, readBody } from '../http';
import { expectedUser, memberHash, UUID } from '../library/storage';
import { encryptLink, newGalleryToken } from '../share/signing';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

type Ctx = Context<HonoEnv>;

/** Invite links per network (preview and accept), like phase-1 invite links. */
const LINK_WINDOW = 15 * 60;
export const TEAM_LIMITS = { linkPerNetwork: 20, invitesPerHour: 20 } as const;

export const teamInviteLink = (env: Env, token: string) =>
  `${env.APP_URL.replace(/\/$/, '')}/team/accept#token=${token}`;

interface InviteOut {
  invite: { id: string; email: string; role: TeamRole; expiresAt: string };
  existingAccount: boolean;
}
type DbError = { error: string };
const isError = (r: unknown): r is DbError =>
  typeof r === 'object' && r !== null && typeof (r as DbError).error === 'string';

/** Maps the database's {error} codes (the API code names, plus a few short aliases) to replies. */
function teamError(c: Ctx, code: string) {
  switch (code) {
    case 'plan_required':
    case 'plan':
      return c.json(fail('plan_required'), 403);
    case 'limit_reached':
    case 'seats':
    case 'limit':
      return c.json(fail('limit_reached'), 409);
    case 'already_member':
    case 'member':
    case 'invited':
    case 'self':
      return c.json(fail('already_member'), 409);
    case 'invite_invalid':
      return c.json(fail('invite_invalid'), 404);
    case 'not_found':
      return c.json(fail('not_found'), 404);
    default:
      return c.json(fail('invalid'), 400);
  }
}

const serverError = (c: Ctx, where: string, err: unknown) => {
  logError(c.get('requestId'), where, err);
  return c.json(fail('server'), 500);
};

const self = (c: Ctx) => c.get('session').userId;

async function teamOf(c: Ctx): Promise<Team | null> {
  return rpc<Team | null>(c.env, 'team_get', { p_owner: self(c) });
}
async function teamReply(c: Ctx, status: 200 | 201 = 200) {
  const team = await teamOf(c);
  if (!team) return c.json(fail('not_found'), 404);
  return c.json({ ok: true, team } satisfies TeamResult, status);
}
async function librariesReply(c: Ctx) {
  const libraries = await rpc<LibrarySummary[] | null>(c.env, 'list_libraries', { p_member: self(c) });
  return c.json({ ok: true, libraries: libraries ?? [] } satisfies LibrariesResult);
}

/** Team writes: the shared-device check, then the per-member billing/team limit (BILLING_LIMITER). */
const writes: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!(await c.env.BILLING_LIMITER.limit({ key: `team:${self(c)}` })).success) return rateLimited(c, 60);
  return expectedUser(c, next);
};
/** Sending invite email: a tight binding limit plus a durable hourly one, keyed by an HMAC of the member. */
const inviteLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!(await c.env.TEAM_INVITE_LIMITER.limit({ key: `team-invite:${self(c)}` })).success)
    return rateLimited(c, 60);
  const key = await memberHash(c.env, self(c));
  if (!(await limitHit(c.env, 'team_invite', key, TEAM_LIMITS.invitesPerHour, 3600)))
    return rateLimited(c, 3600);
  await next();
};
/** Invite links (preview and accept) per network: tokens are 256-bit, this only stops noise. */
async function linkLimitOk(c: Ctx) {
  if (!(await burstOk(c, 'team_invite_link'))) return false;
  return limitHit(c.env, 'team_invite_link', await networkHash(c), TEAM_LIMITS.linkPerNetwork, LINK_WINDOW);
}

/** Sends the invite. The raw token only ever exists here and in the email. */
async function sendTeamInvite(c: Ctx, out: InviteOut, token: string, tokenHash: string, teamName: string) {
  const mail = teamInviteEmail({
    teamName,
    inviterName: c.get('profile').displayName ?? null,
    role: out.invite.role,
    link: teamInviteLink(c.env, token),
    expiresAt: out.invite.expiresAt,
    needsAccount: !out.existingAccount,
  });
  // Keyed by the invite and its token, so a retry of the same send is de-duplicated but a resend isn't.
  await sendEmail(c.env, {
    to: out.invite.email,
    ...mail,
    idempotencyKey: `team-invite:${out.invite.id}:${tokenHash.slice(2, 18)}`,
  });
}

// ================================================================ /api/v1/libraries
export const librariesRoutes = new Hono<HonoEnv>();
librariesRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS)),
  requireMember,
  writes,
);

librariesRoutes.get('/', async (c) => {
  try {
    return await librariesReply(c);
  } catch (err) {
    return serverError(c, 'libraries_list', err);
  }
});

librariesRoutes.delete('/:ownerId', async (c) => {
  const owner = (c.req.param('ownerId') ?? '').toLowerCase();
  if (!UUID.test(owner) || owner === self(c)) return c.json(fail('not_found'), 404);
  try {
    const ok = await rpc<boolean | null>(c.env, 'team_leave', { p_member: self(c), p_owner: owner });
    if (!ok) return c.json(fail('not_found'), 404);
    return await librariesReply(c);
  } catch (err) {
    return serverError(c, 'team_leave', err);
  }
});

// ================================================================ /api/v1/team
export const teamRoutes = new Hono<HonoEnv>();
teamRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS)),
);
// The invite preview needs no session (the person may not have an account yet); everything else does.
teamRoutes.use('*', async (c, next) =>
  c.req.path.endsWith('/invite/preview') ? next() : requireMember(c, next),
);
teamRoutes.use('*', async (c, next) => (c.req.path.endsWith('/invite/preview') ? next() : writes(c, next)));

teamRoutes.post('/invite/preview', async (c) => {
  const body = await readBody(c, teamInviteTokenSchema);
  try {
    if (!(await linkLimitOk(c))) return rateLimited(c, LINK_WINDOW);
    if (!body) return c.json(fail('invite_invalid'), 404);
    const invite = await rpc<TeamInvitePreview | null>(c.env, 'team_invite_preview', {
      p_token_hash: await inviteTokenHash(body.token),
    });
    if (!invite) return c.json(fail('invite_invalid'), 404);
    const out: TeamInvitePreviewResult = {
      ok: true,
      invite: {
        teamName: invite.teamName,
        ownerName: invite.ownerName,
        role: invite.role,
        emailHint: invite.emailHint,
        needsAccount: Boolean(invite.needsAccount),
      },
    };
    return c.json(out);
  } catch (err) {
    return serverError(c, 'team_invite_preview', err);
  }
});

teamRoutes.post('/invite/accept', async (c) => {
  const body = await readBody(c, teamInviteTokenSchema);
  try {
    if (!(await linkLimitOk(c))) return rateLimited(c, LINK_WINDOW);
    if (!body) return c.json(fail('invite_invalid'), 404);
    const res = await rpc<{ ownerId?: string } | DbError | null>(c.env, 'team_invite_accept', {
      p_member: self(c),
      p_email: c.get('session').email,
      p_token_hash: await inviteTokenHash(body.token),
    });
    // Wrong account, expired, revoked, used: all the same 404. A full team is the one thing worth saying.
    if (!res) return c.json(fail('invite_invalid'), 404);
    if (isError(res)) {
      return res.error === 'limit_reached' || res.error === 'seats'
        ? c.json(fail('limit_reached'), 409)
        : c.json(fail('invite_invalid'), 404);
    }
    return await librariesReply(c);
  } catch (err) {
    return serverError(c, 'team_invite_accept', err);
  }
});

teamRoutes.get('/', async (c) => {
  try {
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_get', err);
  }
});

teamRoutes.patch('/', async (c) => {
  const body = await readBody(c, teamNamePatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<unknown>(c.env, 'team_set_name', { p_owner: self(c), p_name: body.name });
    if (isError(res)) return teamError(c, res.error);
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_set_name', err);
  }
});

teamRoutes.post('/invites', inviteLimit, async (c) => {
  const body = await readBody(c, teamInviteSchema);
  if (!body) return c.json(fail('invalid'), 400);
  // Cheap refusal before minting anything: a member can't invite their own address.
  if (body.email === c.get('session').email.toLowerCase()) return c.json(fail('already_member'), 409);
  try {
    const { token, hash } = await newInviteToken();
    const res = await rpc<InviteOut | DbError | null>(c.env, 'team_invite_create', {
      p_owner: self(c),
      p_email: body.email,
      p_role: body.role,
      p_token_hash: hash,
    });
    if (!res) return c.json(fail('invalid'), 400);
    if (isError(res)) return teamError(c, res.error);
    const team = await teamOf(c);
    try {
      await sendTeamInvite(c, res, token, hash, team?.name ?? '');
    } catch (err) {
      // No unsent link stays live (and the seat is freed): revoke, then report.
      logError(c.get('requestId'), 'team_invite_send', err);
      await rpc(c.env, 'team_invite_revoke', { p_owner: self(c), p_id: res.invite.id });
      return c.json(fail('server'), 500);
    }
    return await teamReply(c, 201);
  } catch (err) {
    return serverError(c, 'team_invite_create', err);
  }
});

teamRoutes.post('/invites/:id', inviteLimit, async (c) => {
  const id = (c.req.param('id') ?? '').toLowerCase();
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const { token, hash } = await newInviteToken();
    const res = await rpc<InviteOut | DbError | null>(c.env, 'team_invite_resend', {
      p_owner: self(c),
      p_id: id,
      p_token_hash: hash,
    });
    if (!res) return c.json(fail('not_found'), 404);
    if (isError(res)) return teamError(c, res.error);
    const team = await teamOf(c);
    try {
      await sendTeamInvite(c, res, token, hash, team?.name ?? '');
    } catch (err) {
      // The old link was already replaced; the owner can resend again.
      logError(c.get('requestId'), 'team_invite_resend_send', err);
      return c.json(fail('server'), 500);
    }
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_invite_resend', err);
  }
});

teamRoutes.delete('/invites/:id', async (c) => {
  const id = (c.req.param('id') ?? '').toLowerCase();
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const ok = await rpc<boolean | null>(c.env, 'team_invite_revoke', { p_owner: self(c), p_id: id });
    if (!ok) return c.json(fail('not_found'), 404);
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_invite_revoke', err);
  }
});

teamRoutes.patch('/members/:memberId', async (c) => {
  const member = (c.req.param('memberId') ?? '').toLowerCase();
  if (!UUID.test(member) || member === self(c)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, teamMemberPatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const ok = await rpc<boolean | DbError | null>(c.env, 'team_member_set_role', {
      p_owner: self(c),
      p_member: member,
      p_role: body.role,
    });
    if (isError(ok)) return teamError(c, ok.error);
    if (!ok) return c.json(fail('not_found'), 404);
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_member_set_role', err);
  }
});

/**
 * Phase 8: `?replaceLinks=1` also replaces the link of every live or paused gallery in the library (the removed
 * member may have copied them). All of them, in chunks of GALLERY_LINKS_REPLACE_MAX (one transaction each,
 * `gallery_links_replace`), before the removal: if any chunk fails the member stays in place to retry (the chunks
 * already done have only cost their old links). Nothing is ever skipped silently.
 */
async function replaceLiveLinks(c: Ctx) {
  const owner = self(c);
  const ids = (await rpc<string[] | null>(c.env, 'live_gallery_ids', { p_owner: owner })) ?? [];
  for (let at = 0; at < ids.length; at += GALLERY_LINKS_REPLACE_MAX) {
    const links = await Promise.all(
      ids.slice(at, at + GALLERY_LINKS_REPLACE_MAX).map(async (id) => {
        const { token, hash } = await newGalleryToken();
        const link = await encryptLink(c.env, id, token);
        return { id, tokenHash: hash, linkHint: token.slice(0, 8), ciphertext: link.ciphertext, iv: link.iv };
      }),
    );
    await rpc(c.env, 'gallery_links_replace', { p_owner: owner, p_actor: owner, p_links: links });
  }
}

teamRoutes.delete('/members/:memberId', async (c) => {
  const member = (c.req.param('memberId') ?? '').toLowerCase();
  if (!UUID.test(member) || member === self(c)) return c.json(fail('not_found'), 404);
  const replace = c.req.query(TEAM_REMOVE_REPLACE_LINKS_PARAM);
  if (replace !== undefined && replace !== '0' && replace !== '1') return c.json(fail('invalid'), 400);
  try {
    if (replace === '1') await replaceLiveLinks(c);
    const ok = await rpc<boolean | null>(c.env, 'team_member_remove', { p_owner: self(c), p_member: member });
    if (!ok) return c.json(fail('not_found'), 404);
    return await teamReply(c);
  } catch (err) {
    return serverError(c, 'team_member_remove', err);
  }
});
