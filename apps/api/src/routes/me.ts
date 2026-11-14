import {
  type DeleteAccountResult,
  deleteAccountSchema,
  passkeyRenameSchema,
  passkeyVerifySchema,
  profilePatchSchema,
  type SessionResponse,
  type Usage,
} from '@zephyr/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { gotrue } from '../auth/gotrue';
import { appendCookies, clearCookies, recentlyAuthenticated } from '../auth/session';
import { ceremonyMatches } from '../auth/webauthn';
import { cancelForDeletion, undoCancelForDeletion } from '../billing/deletion';
import { notifyAccountDeletion, notifyPasskeyChange } from '../email/notify';
import { list } from '../env';
import { background, burstOk, fail, guardWrite, logError, rateLimited, readBody } from '../http';
import { libraryContext, ownerOf } from '../library/context';
import { rpc, UpstreamError } from '../supabase';
import type { HonoEnv } from '../types';
import { getProfile, requireMember, sessionUser, toPasskey } from './session-helpers';

const PASSKEY_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** /api/v1/me/*: the signed-in member's profile, passkeys, storage usage and account deletion. */
export const meRoutes = new Hono<HonoEnv>();
meRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS), 20 * 1024),
);
meRoutes.use('*', requireMember);

/**
 * Adding or removing a passkey, or deleting the account, needs a sign-in in the last 10 minutes, so a
 * stolen or left-open session can't quietly add its own key, remove the owner's or delete everything.
 */
const requireRecentAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!recentlyAuthenticated(c.get('session').claims)) return c.json(fail('reauth_required'), 403);
  await next();
};

meRoutes.patch('/', async (c) => {
  const body = await readBody(c, profilePatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const s = c.get('session');
  try {
    await rpc(c.env, 'update_display_name', { p_user_id: s.userId, p_name: body.displayName ?? '' });
    const profile = { ...c.get('profile'), displayName: body.displayName };
    return c.json({ ok: true, user: await sessionUser(c, s, profile) } satisfies SessionResponse);
  } catch (err) {
    logError(c.get('requestId'), 'me_patch', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.get('/passkeys', async (c) => {
  try {
    const items = await gotrue.listPasskeys(c.env, c.get('session').accessToken);
    return c.json({ ok: true, passkeys: items.map(toPasskey) });
  } catch (err) {
    logError(c.get('requestId'), 'passkeys_list', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.post('/passkeys/options', requireRecentAuth, async (c) => {
  if (!(await burstOk(c, 'passkey_reg'))) return rateLimited(c, 60);
  try {
    const ch = await gotrue.passkeyRegisterOptions(c.env, c.get('session').accessToken);
    return c.json({ challengeId: ch.challenge_id, options: ch.options });
  } catch (err) {
    logError(c.get('requestId'), 'passkey_reg_options', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.post('/passkeys/verify', requireRecentAuth, async (c) => {
  const body = await readBody(c, passkeyVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!ceremonyMatches(c, body.credential, 'webauthn.create', list(c.env.APP_ORIGINS))) {
    return c.json(fail('passkey_failed'), 400);
  }
  try {
    const pk = await gotrue.passkeyRegisterVerify(
      c.env,
      c.get('session').accessToken,
      body.challengeId,
      body.credential,
    );
    const passkey = toPasskey(pk);
    await notifyPasskeyChange(c, c.get('session').email, 'added', passkey.friendlyName, 'Zephyr');
    return c.json({ ok: true, passkey }, 201);
  } catch (err) {
    if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return c.json(fail('passkey_failed'), 400);
    }
    logError(c.get('requestId'), 'passkey_reg_verify', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.patch('/passkeys/:id', async (c) => {
  const id = c.req.param('id');
  if (!PASSKEY_ID.test(id)) return c.json(fail('invalid'), 400);
  const body = await readBody(c, passkeyRenameSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const pk = await gotrue.renamePasskey(c.env, c.get('session').accessToken, id, body.friendlyName);
    return c.json({ ok: true, passkey: toPasskey(pk) });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return c.json(fail('not_found'), 404);
    logError(c.get('requestId'), 'passkey_rename', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.delete('/passkeys/:id', requireRecentAuth, async (c) => {
  const id = c.req.param('id');
  if (!PASSKEY_ID.test(id)) return c.json(fail('invalid'), 400);
  try {
    await gotrue.deletePasskey(c.env, c.get('session').accessToken, id);
    await notifyPasskeyChange(c, c.get('session').email, 'removed', null, 'Zephyr');
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return c.json(fail('not_found'), 404);
    logError(c.get('requestId'), 'passkey_delete', err);
    return c.json(fail('server'), 500);
  }
});

// Phase 7: the open library's storage (the sidebar meter of a team library shows the owner's usage).
meRoutes.get('/usage', libraryContext, async (c) => {
  try {
    const usage = await rpc<Omit<Usage, 'ok'> | null>(c.env, 'get_usage', {
      p_owner: ownerOf(c),
    });
    if (!usage) return c.json(fail('not_found'), 404);
    return c.json({ ok: true, ...usage } satisfies Usage);
  } catch (err) {
    logError(c.get('requestId'), 'usage', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Schedules the account for deletion in 30 days, signs out every session (all devices) and emails the
 * account. Signing in again shows the Restore screen until the purge job runs.
 */
meRoutes.post('/delete', requireRecentAuth, async (c) => {
  const body = await readBody(c, deleteAccountSchema);
  if (!body) return c.json(fail('invalid'), 400);
  const s = c.get('session');
  try {
    // Phase 7: the answer may also carry the Stripe subscription id (renewal stops while deletion is pending).
    const scheduled = await rpc<string | { purgeAt?: string; stripeSubscriptionId?: string | null } | null>(
      c.env,
      'request_account_deletion',
      { p_owner: s.userId },
    );
    const purgeAt = typeof scheduled === 'string' ? scheduled : (scheduled?.purgeAt ?? null);
    if (!purgeAt) return c.json(fail('forbidden'), 403);
    await background(c, () =>
      cancelForDeletion(c.env, s.userId, scheduled).catch((err) =>
        logError(c.get('requestId'), 'deletion_billing_cancel', err),
      ),
    );
    try {
      await gotrue.logoutEverywhere(c.env, s.accessToken);
    } catch (err) {
      // The pending-deletion gate still refuses every other route for any session left.
      logError(c.get('requestId'), 'delete_logout', err);
    }
    appendCookies(c, clearCookies('app'));
    c.header('Clear-Site-Data', '"cache"');
    await notifyAccountDeletion(c, s.email, purgeAt);
    return c.json({ ok: true, purgeAt } satisfies DeleteAccountResult);
  } catch (err) {
    logError(c.get('requestId'), 'account_delete', err);
    return c.json(fail('server'), 500);
  }
});

meRoutes.post('/restore', async (c) => {
  const s = c.get('session');
  try {
    const restoredRes = await rpc<
      boolean | { restored?: boolean; stripeSubscriptionId?: string | null } | null
    >(c.env, 'restore_account', { p_owner: s.userId });
    const restored =
      typeof restoredRes === 'object' && restoredRes ? restoredRes.restored === true : restoredRes;
    if (!restored) return c.json(fail('conflict'), 409);
    await background(c, () =>
      undoCancelForDeletion(c.env, s.userId, restoredRes).catch((err) =>
        logError(c.get('requestId'), 'restore_billing_resume', err),
      ),
    );
    const profile = await getProfile(c.env, s.userId);
    if (!profile) return c.json(fail('server'), 500);
    return c.json({ ok: true, user: await sessionUser(c, s, profile) } satisfies SessionResponse);
  } catch (err) {
    logError(c.get('requestId'), 'account_restore', err);
    return c.json(fail('server'), 500);
  }
});
