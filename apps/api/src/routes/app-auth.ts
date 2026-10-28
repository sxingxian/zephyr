import {
  type Accepted,
  emailStartSchema,
  emailVerifySchema,
  type PasskeyOptions,
  passkeyVerifySchema,
  type SessionResponse,
} from '@zephyr/shared';
import { type Context, Hono } from 'hono';
import { type GoTrueSession, gotrue } from '../auth/gotrue';
import {
  appendCookies,
  endSession,
  resolveSession,
  sessionCookies,
  verifyAccessToken,
} from '../auth/session';
import { list } from '../env';
import {
  background,
  burstOk,
  clientIp,
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
import { getProfile, requireMember, sessionUser } from './session-helpers';

const WINDOW = 15 * 60;
export const LIMITS = {
  emailStartPerNetwork: 5,
  emailStartPerAddress: 3,
  emailVerifyPerNetwork: 20,
  emailVerifyFailuresPerAddress: 5,
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
 * them apart either.
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
    if (
      !(await limitHit(
        c.env,
        'email_start_addr',
        await emailHash(c.env, body.email),
        LIMITS.emailStartPerAddress,
        WINDOW,
      ))
    ) {
      return rateLimited(c, WINDOW);
    }
    await background(c, async () => {
      try {
        if ((await rpc<string>(c.env, 'account_kind', { p_email: body.email })) === 'member') {
          await gotrue.sendEmailCode(c.env, body.email);
        }
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

appAuthRoutes.post('/email/verify', async (c) => {
  if (!(await burstOk(c, 'email_verify'))) return rateLimited(c, 60);
  const body = await readBody(c, emailVerifySchema);
  if (!body) return c.json(fail('invalid'), 400);
  const requestId = c.get('requestId');
  try {
    if (
      !(await limitHit(c.env, 'email_verify', await networkHash(c), LIMITS.emailVerifyPerNetwork, WINDOW))
    ) {
      return rateLimited(c, WINDOW);
    }
    const addr = await emailHash(c.env, body.email);
    const failures = await rpc<number>(c.env, 'rate_limit_count', {
      p_kind: 'email_verify_fail',
      p_key: addr,
      p_window_seconds: WINDOW,
    });
    if (failures >= LIMITS.emailVerifyFailuresPerAddress) return rateLimited(c, WINDOW);

    let session: GoTrueSession;
    try {
      session = await gotrue.verifyEmailCode(c.env, body.email, body.code);
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        await rpc(c.env, 'rate_limit_record', { p_kind: 'email_verify_fail', p_key: addr });
        return c.json(fail('invalid_code'), 400);
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
  return c.json(body);
});

appAuthRoutes.post('/sign-out', async (c) => {
  const s = await resolveSession(c, 'app');
  await endSession(c, 'app', s?.accessToken);
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
  if (!profile || profile.isStaff || profile.deleted) {
    try {
      await gotrue.logout(c.env, session.access_token);
    } catch {
      /* ignore */
    }
    return c.json(fail('forbidden'), 403);
  }
  appendCookies(c, sessionCookies('app', session));
  const active = {
    userId: claims.sub,
    email: (claims.email ?? '').toLowerCase(),
    claims,
    accessToken: session.access_token,
  };
  const body: SessionResponse = { ok: true, user: await sessionUser(c, active, profile), ...extra };
  return c.json(body);
}
