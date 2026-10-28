import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { env as baseEnv } from './helpers';

const ORIGIN = 'https://zephyr.midnightpoetry.studio';
const EMAIL = 'aisha.r@example.com';

let limiterOk = true;
const limiterKeys: string[] = [];
const env: Env = {
  ...baseEnv,
  BURST_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      limiterKeys.push(key);
      return { success: limiterOk };
    },
  } as unknown as RateLimit,
};

type Turnstile = { success: boolean; hostname?: string; action?: string };
let turnstile: Turnstile;
let rpcResult: { status: number; body: unknown };
let rpcCalls: { fn: string; args: Record<string, unknown>; headers: Headers }[];

beforeEach(() => {
  limiterOk = true;
  limiterKeys.length = 0;
  turnstile = { success: true, hostname: 'zephyr.midnightpoetry.studio', action: 'invite_request' };
  rpcResult = { status: 200, body: 'accepted' };
  rpcCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://challenges.cloudflare.com/')) return Response.json(turnstile);
      if (url.startsWith('https://db.test/rest/v1/rpc/')) {
        rpcCalls.push({
          fn: url.split('/').pop() ?? '',
          args: JSON.parse(String(init?.body ?? '{}')),
          headers: new Headers(init?.headers),
        });
        return Response.json(rpcResult.body, { status: rpcResult.status });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(
    '/api/v1/invite-requests',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.7',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
const good = { email: EMAIL, useCase: 'portraits', turnstileToken: 'tok' };

describe('POST /api/v1/invite-requests', () => {
  it('accepts a valid request with 202 and calls the RPC with a hashed IP', async () => {
    const res = await post(good);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpcCalls).toHaveLength(1);
    const [call] = rpcCalls;
    if (!call) throw new Error('no rpc call');
    expect(call.fn).toBe('submit_invite_request');
    expect(call.args.p_email).toBe(EMAIL);
    expect(call.args.p_use_case).toBe('portraits');
    expect(call.args.p_ip_hash).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(JSON.stringify(call.args)).not.toContain('203.0.113.7');
    expect(call.headers.get('apikey')).toBe('sb_secret_test');
    // New-style secret keys aren't JWTs, so they never go in Authorization.
    expect(call.headers.get('Authorization')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('gives a duplicate the identical reply', async () => {
    const a = await post(good);
    const b = await post({ ...good, email: 'Aisha.R@Example.com' });
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
  });

  it('limits IPv6 clients per /64, so rotating addresses inside it does not help', async () => {
    await post(good, { 'CF-Connecting-IP': '2001:db8:1:2::1' });
    await post(good, { 'CF-Connecting-IP': '2001:db8:1:2:dead:beef:0:7' });
    await post(good, { 'CF-Connecting-IP': '2001:db8:1:3::1' });
    expect(limiterKeys).toEqual([
      'invite:2001:db8:1:2::/64',
      'invite:2001:db8:1:2::/64',
      'invite:2001:db8:1:3::/64',
    ]);
    const [a, b, c] = rpcCalls.map((r) => r.args.p_ip_hash);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('treats an IPv4-mapped address as the IPv4 address', async () => {
    await post(good, { 'CF-Connecting-IP': '203.0.113.7' });
    await post(good, { 'CF-Connecting-IP': '::ffff:203.0.113.7' });
    expect(limiterKeys).toEqual(['invite:203.0.113.7', 'invite:203.0.113.7']);
    expect(rpcCalls[0]?.args.p_ip_hash).toBe(rpcCalls[1]?.args.p_ip_hash);
  });

  it('flags disposable domains', async () => {
    await post({ ...good, email: 'x@mailinator.com' });
    expect(rpcCalls[0]?.args.p_disposable).toBe(true);
  });

  it('rejects a foreign or missing Origin with 403', async () => {
    expect((await post(good, { Origin: 'https://evil.example' })).status).toBe(403);
    const res = await app.request(
      '/api/v1/invite-requests',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good) },
      env,
    );
    expect(res.status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it('rejects a non-JSON content type with 415', async () => {
    expect((await post('email=a', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  it('rejects malformed JSON and invalid fields with 400', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ ...good, email: 'nope' })).status).toBe(400);
    expect((await post({ ...good, useCase: 'hacking' })).status).toBe(400);
    expect((await post({ email: EMAIL })).status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('rejects bodies over 4 KB with 413', async () => {
    const res = await post({ ...good, pad: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('returns 403 when Turnstile fails, or the hostname or action is wrong', async () => {
    turnstile = { success: false };
    expect((await post(good)).status).toBe(403);
    turnstile = { success: true, hostname: 'evil.example', action: 'invite_request' };
    expect((await post(good)).status).toBe(403);
    turnstile = { success: true, hostname: 'zephyr.midnightpoetry.studio', action: 'login' };
    const res = await post(good);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'verification_failed' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('maps rate_limited to 429 with Retry-After 900', async () => {
    rpcResult = { status: 200, body: 'rate_limited' };
    const res = await post(good);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited', retryAfter: 900 });
  });

  it('returns 429 when the burst limiter trips, before verifying anything', async () => {
    limiterOk = false;
    const res = await post(good);
    expect(res.status).toBe(429);
    expect(rpcCalls).toHaveLength(0);
  });

  it('maps not_accepting to 409', async () => {
    rpcResult = { status: 200, body: 'not_accepting' };
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'not_accepting' });
  });

  it('returns 500 without leaking internals or personal data when the database fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpcResult = {
      status: 500,
      body: { message: 'relation "invite_requests" does not exist', hint: 'secret' },
    };
    const res = await post(good);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('{"ok":false,"error":"server"}');
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).not.toContain('sb_secret_test');
    expect(logged).toContain('rpc:submit_invite_request 500');
  });
});

describe('GET /api/v1/public/config', () => {
  it('returns the public config with a 60-second cache', async () => {
    rpcResult = {
      status: 200,
      body: { signupMode: 'invite_only', acceptingInviteRequests: true, signupsPaused: false, extra: 1 },
    };
    const res = await app.request('/api/v1/public/config', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({
      signupMode: 'invite_only',
      acceptingInviteRequests: true,
      signupsPaused: false,
    });
  });

  it('fails closed with 503 when the database is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rpcResult = { status: 502, body: {} };
    const res = await app.request('/api/v1/public/config', {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('everything else', () => {
  it('serves health', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('returns JSON 404 for unknown paths', async () => {
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('rejects other methods with 405', async () => {
    const res = await app.request('/api/v1/invite-requests', { method: 'OPTIONS' }, env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
  });
});
