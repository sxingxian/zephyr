import { INVITE_REQUEST_ACCEPTED, inviteRequestSchema, type PublicConfig } from '@zephyr/shared';
import { Hono } from 'hono';
import { isDisposable } from '../disposable';
import { list } from '../env';
import { burstOk, fail, guardWrite, logError, networkHash, rateLimited, readBody } from '../http';
import { rpc } from '../supabase';
import { TURNSTILE_ACTIONS, verifyTurnstile } from '../turnstile';
import type { HonoEnv } from '../types';

const RETRY_AFTER_SECONDS = 15 * 60;

/** Phase 1 routes used by the landing page. */
export const publicRoutes = new Hono<HonoEnv>();

publicRoutes.get('/health', (c) => c.json({ ok: true }));

publicRoutes.get('/v1/public/config', async (c) => {
  try {
    const cfg = await rpc<PublicConfig>(c.env, 'get_public_config');
    const body: PublicConfig = {
      signupMode: cfg.signupMode === 'open' ? 'open' : 'invite_only',
      acceptingInviteRequests: cfg.acceptingInviteRequests === true,
      signupsPaused: cfg.signupsPaused === true,
    };
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(body);
  } catch (err) {
    // Fail closed: a made-up default could claim requests are open while they're paused.
    logError(c.get('requestId'), 'public_config', err);
    return c.json(fail('server'), 503);
  }
});

publicRoutes.post(
  '/v1/invite-requests',
  // Only our own pages may submit. Browsers always send Origin on a POST.
  guardWrite((env) => list(env.ALLOWED_ORIGINS)),
  async (c) => {
    const requestId = c.get('requestId');
    if (!(await burstOk(c, 'invite'))) return rateLimited(c, 60);

    const body = await readBody(c, inviteRequestSchema);
    if (!body) return c.json(fail('invalid'), 400);
    const { email, useCase, turnstileToken } = body;

    const ip = c.req.header('CF-Connecting-IP') ?? null;
    if (!(await verifyTurnstile(c.env, turnstileToken, ip, TURNSTILE_ACTIONS.inviteRequest))) {
      return c.json(fail('verification_failed'), 403);
    }

    try {
      const result = await rpc<string>(c.env, 'submit_invite_request', {
        p_email: email,
        p_use_case: useCase ?? null,
        p_ip_hash: await networkHash(c),
        p_disposable: isDisposable(email),
      });
      switch (result) {
        case 'accepted':
          return c.json(INVITE_REQUEST_ACCEPTED, 202);
        case 'rate_limited':
          return rateLimited(c, RETRY_AFTER_SECONDS);
        case 'not_accepting':
          return c.json(fail('not_accepting'), 409);
        default:
          logError(requestId, 'invite_request', new Error('UnexpectedResult'));
          return c.json(fail('server'), 500);
      }
    } catch (err) {
      logError(requestId, 'invite_request', err);
      return c.json(fail('server'), 500);
    }
  },
);
