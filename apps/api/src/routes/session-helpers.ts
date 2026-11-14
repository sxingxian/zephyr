import type { Passkey, SessionUser } from '@zephyr/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { type GoTruePasskey, gotrue } from '../auth/gotrue';
import { type ActiveSession, endSession, resolveSession } from '../auth/session';
import type { Env } from '../env';
import { fail, logError } from '../http';
import { rpc } from '../supabase';
import type { HonoEnv, SessionProfile } from '../types';

export const toPasskey = (p: GoTruePasskey): Passkey => ({
  id: p.id,
  friendlyName: p.friendly_name ?? null,
  createdAt: p.created_at,
  lastUsedAt: p.last_used_at ?? null,
});

export async function passkeyCount(env: Env, jwt: string, requestId: string): Promise<number> {
  try {
    return (await gotrue.listPasskeys(env, jwt)).length;
  } catch (err) {
    logError(requestId, 'passkey_count', err);
    return 0;
  }
}

export const getProfile = (env: Env, userId: string) =>
  rpc<SessionProfile | null>(env, 'get_session_profile', { p_user_id: userId });

/**
 * Phase 8: is the account suspended by staff? Read from the session profile when it carries the flag, else one
 * `member_suspended` call (once per request: requireMember runs once).
 */
export async function isSuspended(env: Env, userId: string, profile: SessionProfile): Promise<boolean> {
  if (typeof profile.suspended === 'boolean') return profile.suspended;
  return (await rpc<boolean | null>(env, 'member_suspended', { p_user: userId })) === true;
}

export async function sessionUser(
  c: Context<HonoEnv>,
  s: ActiveSession,
  p: SessionProfile,
): Promise<SessionUser> {
  return {
    id: s.userId,
    email: s.email,
    displayName: p.displayName ?? null,
    plan: p.plan ?? 'free',
    passkeyCount: await passkeyCount(c.env, s.accessToken, c.get('requestId')),
    createdAt: p.createdAt,
    ...(p.deletionDue ? { pendingDeletion: { purgeAt: p.deletionDue } } : {}),
    // Phase 8: from get_session_profile; passed through only when the database sends it.
    ...(p.retention !== undefined ? { retention: p.retention } : {}),
  };
}

/** While an account is scheduled for deletion only these routes work (plus sign-out, which needs no member). */
const PENDING_DELETION_ALLOWED = new Set([
  'GET /api/v1/auth/session',
  'HEAD /api/v1/auth/session',
  'POST /api/v1/me/restore',
]);

/**
 * App routes that need a member. Staff accounts are separate and can't use the app: their session is
 * ended here. Deleted accounts are signed out too, and accounts scheduled for deletion get 403
 * account_pending_deletion everywhere but the session and restore routes.
 */
export const requireMember: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const s = await resolveSession(c, 'app');
  if (!s) return c.json(fail('unauthenticated'), 401);
  let profile: SessionProfile | null;
  let suspended = false;
  try {
    profile = await getProfile(c.env, s.userId);
    if (profile && !profile.deleted && !profile.isStaff)
      suspended = await isSuspended(c.env, s.userId, profile);
  } catch (err) {
    logError(c.get('requestId'), 'session_profile', err);
    return c.json(fail('server'), 500);
  }
  if (!profile || profile.deleted) {
    await endSession(c, 'app', s.accessToken);
    return c.json(fail('unauthenticated'), 401);
  }
  if (profile.isStaff) {
    await endSession(c, 'app', s.accessToken);
    return c.json(fail('forbidden'), 403);
  }
  // Phase 8: the database already ended the account's sessions in Auth; this clears the cookies too.
  if (suspended) {
    await endSession(c, 'app', s.accessToken);
    return c.json(fail('account_suspended'), 403);
  }
  if (profile.deletionDue && !PENDING_DELETION_ALLOWED.has(`${c.req.method} ${c.req.path}`)) {
    return c.json(fail('account_pending_deletion'), 403);
  }
  c.set('session', s);
  c.set('profile', profile);
  await next();
};
