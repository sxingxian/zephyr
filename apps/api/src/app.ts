import {
  INVITE_REQUEST_ACCEPTED,
  type InviteRequestErrorBody,
  inviteRequestSchema,
  type PublicConfig,
} from '@zephyr/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { hashIp, toPgBytea } from './crypto';
import { isDisposable } from './disposable';
import { type Env, list } from './env';
import { networkKey } from './ip';
import { rpc, UpstreamError } from './supabase';
import { verifyTurnstile } from './turnstile';

type AppEnv = { Bindings: Env; Variables: { requestId: string } };

const MAX_BODY_BYTES = 4 * 1024;
const RETRY_AFTER_SECONDS = 15 * 60;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

const fail = (error: InviteRequestErrorBody['error'], extra: Partial<InviteRequestErrorBody> = {}) =>
  ({ ok: false, error, ...extra }) satisfies InviteRequestErrorBody;

/** Logs without personal data: never emails, IPs, tokens or request bodies. */
function logError(requestId: string, where: string, err: unknown) {
  const detail =
    err instanceof UpstreamError ? `${err.where} ${err.status}` : err instanceof Error ? err.name : 'unknown';
  console.error(JSON.stringify({ level: 'error', requestId, where, detail }));
}

export const app = new Hono<AppEnv>().basePath('/api');

// ---- Global middleware -------------------------------------------------------------------------
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  if (!ALLOWED_METHODS.has(c.req.method)) {
    const res = c.json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, POST' });
    applyHeaders(res.headers, c.req.method, requestId);
    return res;
  }
  await next();
  applyHeaders(c.res.headers, c.req.method, requestId);
});

function applyHeaders(h: Headers, method: string, requestId: string) {
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('X-Request-Id', requestId);
  // Only explicitly cacheable GETs (public config) may be cached.
  if ((method !== 'GET' && method !== 'HEAD') || !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
}

// ---- Routes ------------------------------------------------------------------------------------
app.get('/health', (c) => c.json({ ok: true }));

app.get('/v1/public/config', async (c) => {
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
    // Fail closed: a made-up default could claim requests are open while they're paused. The form
    // shows a "try again" state instead.
    logError(c.get('requestId'), 'public_config', err);
    return c.json(fail('server'), 503);
  }
});

app.post(
  '/v1/invite-requests',
  // Only our own pages may submit. Browsers always send Origin on a cross-site or same-origin POST.
  async (c, next) => {
    const origin = c.req.header('Origin');
    if (!origin || !list(c.env.ALLOWED_ORIGINS).includes(origin)) return c.json(fail('invalid'), 403);
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(fail('invalid'), 415);
    }
    await next();
  },
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(fail('invalid'), 413) }),
  async (c) => {
    const requestId = c.get('requestId');
    const ip = c.req.header('CF-Connecting-IP') ?? null;
    // Limits apply per network (IPv4 address or IPv6 /64), not per address.
    const network = networkKey(ip) ?? 'unknown';

    const burst = await c.env.BURST_LIMITER.limit({ key: `invite:${network}` });
    if (!burst.success) {
      c.header('Retry-After', '60');
      return c.json(fail('rate_limited', { retryAfter: 60 }), 429);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(fail('invalid'), 400);
    }
    const parsed = inviteRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json(fail('invalid'), 400);
    const { email, useCase, turnstileToken } = parsed.data;

    if (!(await verifyTurnstile(c.env, turnstileToken, ip))) return c.json(fail('verification_failed'), 403);

    try {
      const ipHash = await hashIp(network, c.env.IP_HASH_SECRET);
      const result = await rpc<string>(c.env, 'submit_invite_request', {
        p_email: email,
        p_use_case: useCase ?? null,
        p_ip_hash: toPgBytea(ipHash),
        p_disposable: isDisposable(email),
      });
      switch (result) {
        case 'accepted':
          return c.json(INVITE_REQUEST_ACCEPTED, 202);
        case 'rate_limited':
          c.header('Retry-After', String(RETRY_AFTER_SECONDS));
          return c.json(fail('rate_limited', { retryAfter: RETRY_AFTER_SECONDS }), 429);
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

app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));
app.onError((err, c) => {
  logError(c.get('requestId') ?? 'none', 'unhandled', err);
  return c.json(fail('server'), 500);
});
