import {
  type Accepted,
  ADS_DOC_COOKIE,
  emailStartSchema,
  emailVerifySchema,
  type PasskeyOptions,
  PLANS,
  passkeyVerifySchema,
  type SessionResponse,
  verifyAdsCookie,
} from '@zephyr/shared';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  CODE_WINDOW,
  padReply,
  reserveCodeAttempt,
  resetCodeAttempts,
  takeFreeAttempt,
} from '../auth/code-limits';
import { type GoTrueSession, gotrue } from '../auth/gotrue';
import {
  adsDocCookie,
  adsSeenCookie,
  appendCookies,
  clearCookies,
  endSession,
  resolveSession,
  sessionCookies,
  verifyAccessToken,
} from '../auth/session';
import { ceremonyMatches } from '../auth/webauthn';
import { list } from '../env';
import {
  background,
  burstOk,
  clientIp,
  clientNetwork,
  emailHash,
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
import { getProfile, isSuspended, requireMember, sessionUser } from './session-helpers';

const WINDOW = 15 * 60;
const DAY = 24 * 60 * 60;
export const LIMITS = {
  emailStartPerNetwork: 5,
  emailStartPerAddress: 3,
  /** Codes per address per day: with ≤25 guesses per code, ≤250 guesses a day against 10⁶ codes. */
  emailStartPerAddressPerDay: 10,
  emailVerifyPerNetwork: 20,
  passkeyPerNetwork: 30,
} as const;
const ACCEPTED: Accepted = { ok: true };

/** /api/v1/auth/*: sign-in for members (email codes and passkeys). */
export const appAuthRoutes = new Hono<HonoEnv>();
appAuthRoutes.use(
  '*',
  guardWrite((env) => list(env.APP_ORIGINS), 20 * 1024),
);

/**
 * Sends a sign-in code to an existing member. The reply is identical for unknown emails and staff
 * accounts (which get nothing), and the email goes out after the response, so timing doesn't tell
 * them apart either. A new code clears the address's guess counters (see auth/code-limits.ts).
 */
appAuthRoutes.post('/email/start', async (c) => {
  if (!(await burstOk(c, 'email_start'))) return rateLimited(c, 60);
  const body = await readBody(c, emailStartSchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c), TURNSTILE_ACTIONS.emailStart))) {
    return c.json(fail('verification_failed'), 403);
  }
  const requestId = c.get('requestId');
  try {
    if (!(await limitHit(c.env, 'email_start', await networkHash(c), LIMITS.emailStartPerNetwork, WINDOW))) {
      return rateLimited(c, WINDOW);
    }
    const addr = await emailHash(c.env, body.email);
    if (!(await limitHit(c.env, 'email_start_addr', addr, LIMITS.emailStartPerAddress, WINDOW))) {
      return rateLimited(c, WINDOW);
    }
    if (!(await limitHit(c.env, 'email_start_day', addr, LIMITS.emailStartPerAddressPerDay, DAY))) {
      return rateLimited(c, WINDOW);
    }
    const network = clientNetwork(c);
    await background(c, async () => {
      try {
        if ((await rpc<string>(c.env, 'account_kind', { p_email: body.email })) !== 'member') return;
        await gotrue.sendEmailCode(c.env, body.email);
        await resetCodeAttempts(c.env, 'app', body.email, network);
      } catch (err) {
        logError(requestId, 'email_start_send', err);
      }
    });
    return c.json(ACCEPTED, 202);
  } catch (err) {
    logError(requestId, 'email_start', err);
    return c.json(fail('server'), 500);
  }
});

/**
 * Checks a code. Each attempt is reserved before Auth sees it (see auth/code-limits.ts); only members
 * reach Auth at all, and wrong-code replies take the same minimum time either way.
 */
appAuthRoutes.post('/email/verify', async (c) => {
  const startedAt = Date.now();
  if (!(await burstOk(c, 'email_verify'))) return rateLimited(c, 60);
  const body = await readBody(c, emailVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  const requestId = c.get('requestId');
  const wrongCode = async () => {
    await padReply(startedAt);
    return c.json(fail('invalid_code'), 400);
  };
  try {
    if (
      !(await limitHit(c.env, 'email_verify', await networkHash(c), LIMITS.emailVerifyPerNetwork, WINDOW))
    ) {
      return rateLimited(c, WINDOW);
    }
    if (body.turnstileToken) {
      if (!(await verifyTurnstile(c.env, body.turnstileToken, clientIp(c), TURNSTILE_ACTIONS.emailVerify))) {
        return c.json(fail('verification_failed'), 403);
      }
    } else if (!(await takeFreeAttempt(c, 'app', body.email))) {
      return c.json(fail('verification_failed'), 403);
    }
    if (!(await reserveCodeAttempt(c, 'app', body.email))) return rateLimited(c, CODE_WINDOW);
    if ((await rpc<string>(c.env, 'account_kind', { p_email: body.email })) !== 'member') return wrongCode();

    let session: GoTrueSession;
    try {
      session = await gotrue.verifyEmailCode(c.env, body.email, body.code);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return wrongCode();
      }
      throw err;
    }
    return await startMemberSession(c, session);
  } catch (err) {
    logError(requestId, 'email_verify', err);
    return c.json(fail('server'), 500);
  }
});

appAuthRoutes.post('/passkey/options', async (c) => {
  if (!(await burstOk(c, 'passkey'))) return rateLimited(c, 60);
  try {
    if (!(await limitHit(c.env, 'passkey', await networkHash(c), LIMITS.passkeyPerNetwork, WINDOW))) {
      return rateLimited(c, WINDOW);
    }
    const ch = await gotrue.passkeyAuthOptions(c.env);
    return c.json({ challengeId: ch.challenge_id, options: ch.options } satisfies PasskeyOptions);
  } catch (err) {
    logError(c.get('requestId'), 'passkey_options', err);
    return c.json(fail('server'), 500);
  }
});

appAuthRoutes.post('/passkey/verify', async (c) => {
  if (!(await burstOk(c, 'passkey'))) return rateLimited(c, 60);
  const body = await readBody(c, passkeyVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  if (!ceremonyMatches(c, body.credential, 'webauthn.get', list(c.env.APP_ORIGINS))) {
    return c.json(fail('passkey_failed'), 400);
  }
  try {
    let session: GoTrueSession;
    try {
      session = await gotrue.passkeyAuthVerify(c.env, body.challengeId, body.credential);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return c.json(fail('passkey_failed'), 400);
      }
      throw err;
    }
    return await startMemberSession(c, session);
  } catch (err) {
    logError(c.get('requestId'), 'passkey_verify', err);
    return c.json(fail('server'), 500);
  }
});

appAuthRoutes.get('/session', requireMember, async (c) => {
  const body: SessionResponse = { ok: true, user: await sessionUser(c, c.get('session'), c.get('profile')) };
  // Phase 8: an AdSense cookie that isn't this member's, isn't valid, or belongs to a plan without ads goes now
  // (GET /ads, which only Free members call, would otherwise be the only thing to clear it).
  const raw = getCookie(c, ADS_DOC_COOKIE);
  if (raw !== undefined) {
    const owner = await verifyAdsCookie(c.env.ADS_COOKIE_SECRET, raw);
    const ads = PLANS.find((p) => p.id === body.user.plan)?.limits.ads === true;
    if (owner !== body.user.id || !ads) appendCookies(c, [await adsDocCookie(c.env, null)]);
  }
  return c.json(body);
});

appAuthRoutes.post('/sign-out', async (c) => {
  const s = await resolveSession(c, 'app');
  await endSession(c, 'app', s?.accessToken);
  // Private images may sit in the browser cache (revalidated, but still stored): drop them. Phase 8: also every
  // storage area (local and session storage, IndexedDB, Cache Storage, the service worker), so nothing a page
  // script wrote (Google's AdSense script runs in Free members' library pages) survives into the next session.
  c.header('Clear-Site-Data', '"cache", "storage"');
  appendCookies(c, [adsSeenCookie(false)]);
  return c.body(null, 204);
});

/**
 * Turns a fresh GoTrue session into a member session: verifies the token, refuses staff accounts
 * (they belong in /admin), sets the cookies and returns the user.
 */
export async function startMemberSession(
  c: Context<HonoEnv>,
  session: GoTrueSession,
  extra: { isNew?: boolean } = {},
) {
  const claims = await verifyAccessToken(c.env, session.access_token);
  if (!claims) throw new UpstreamError('auth:token', 502, 'unverifiable');
  const profile = await getProfile(c.env, claims.sub);
  const suspended =
    !!profile && !profile.isStaff && !profile.deleted && (await isSuspended(c.env, claims.sub, profile));
  if (!profile || profile.isStaff || profile.deleted || suspended) {
    try {
      await gotrue.logout(c.env, session.access_token);
    } catch {
      /* ignore */
    }
    if (suspended) {
      // Phase 8: a suspended account can't sign in; any old session cookies go too.
      appendCookies(c, clearCookies('app'));
      return c.json(fail('account_suspended'), 403);
    }
    return c.json(fail('forbidden'), 403);
  }
  appendCookies(c, sessionCookies('app', session));
  // Phase 8: a new sign-in never inherits an AdSense cookie (GET /ads sets a fresh one for this member if any).
  appendCookies(c, [await adsDocCookie(c.env, null)]);
  const active = {
    userId: claims.sub,
    email: (claims.email ?? '').toLowerCase(),
    claims,
    accessToken: session.access_token,
  };
  const body: SessionResponse = { ok: true, user: await sessionUser(c, active, profile), ...extra };
  return c.json(body);
}
