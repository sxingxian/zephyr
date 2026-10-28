/**
 * Test harness: a mocked fetch that plays Supabase (PostgREST RPCs, GoTrue, JWKS), Cloudflare
 * (Turnstile, Access certs) and Resend, plus real ES256/RS256 keys so tokens are genuinely verified.
 */
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';

export const SB = 'https://db.test';
export const APP = 'https://zephyrapp.midnightpoetry.studio';
export const LANDING = 'https://zephyr.midnightpoetry.studio';
export const TEAM = 'zephyr.cloudflareaccess.com';
export const AUD = 'access-aud-123';

export let limiterOk = true;
export const setLimiter = (ok: boolean) => {
  limiterOk = ok;
};
export const limiterKeys: string[] = [];

export const env: Env = {
  ENVIRONMENT: 'test',
  SUPABASE_URL: SB,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  ALLOWED_ORIGINS: LANDING,
  APP_ORIGINS: APP,
  ADMIN_ORIGINS: LANDING,
  APP_URL: APP,
  TURNSTILE_EXPECTED_HOSTNAMES: 'zephyr.midnightpoetry.studio,zephyrapp.midnightpoetry.studio',
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  EMAIL_FROM: 'Zephyr <hello@zephyr.midnightpoetry.studio>',
  RESEND_API_KEY: 're_test',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  IP_HASH_SECRET: 'ip-hash-secret',
  SESSION_HMAC_SECRET: 'session-hmac-secret',
  BURST_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      limiterKeys.push(key);
      return { success: limiterOk };
    },
  } as unknown as RateLimit,
};

// ---- keys --------------------------------------------------------------------------------------------
type Keys = { privateKey: CryptoKey; jwk: JWK };
let sbKeys: Keys;
let cfKeys: Keys;
let otherKeys: Keys;
export async function initKeys() {
  if (sbKeys) return;
  const mk = async (alg: 'ES256' | 'RS256', kid: string): Promise<Keys> => {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
    return { privateKey: privateKey as CryptoKey, jwk };
  };
  sbKeys = await mk('ES256', 'sb-1');
  cfKeys = await mk('RS256', 'cf-1');
  otherKeys = await mk('ES256', 'sb-1'); // same kid, wrong key: a forged token
}

export interface TokenOpts {
  sub: string;
  email: string;
  amr?: string[];
  expIn?: number;
  forged?: boolean;
  aud?: string;
}
export async function sbToken(o: TokenOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const keys = o.forged ? otherKeys : sbKeys;
  return new SignJWT({
    email: o.email,
    role: 'authenticated',
    amr: (o.amr ?? ['otp']).map((method) => ({ method, timestamp: now })),
    session_id: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'sb-1' })
    .setSubject(o.sub)
    .setIssuer(`${SB}/auth/v1`)
    .setAudience(o.aud ?? 'authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + (o.expIn ?? 3600))
    .sign(keys.privateKey);
}
export async function accessToken(email: string, o: { aud?: string; iss?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'cf-1' })
    .setIssuer(o.iss ?? `https://${TEAM}`)
    .setAudience(o.aud ?? AUD)
    .setSubject('access-user')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(cfKeys.privateKey);
}

// ---- fake services ----------------------------------------------------------------------------------
export interface User {
  id: string;
  email: string;
  staff?: 'owner' | 'admin' | 'finance' | 'safety' | 'support';
  passkeys?: number;
  displayName?: string | null;
}
export interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}
export interface World {
  users: User[];
  turnstile: { success: boolean; hostname?: string; action?: string };
  /** Overrides for RPCs: return a value (JSON) or a Response. */
  rpc: Record<string, (args: Record<string, unknown>) => unknown>;
  calls: Call[];
  emails: { to: string; subject: string; html: string; text: string }[];
  resendStatus: number;
  /** The email code GoTrue accepts. */
  code: string;
  /** Next passkey assertion signs in this user (or fails if null). */
  passkeyUser: User | null;
  /** Refresh tokens GoTrue accepts → user. */
  refresh: Map<string, User>;
  createUserStatus: number;
}
export const world: World = {} as World;

export function resetWorld() {
  Object.assign(world, {
    users: [
      {
        id: '20000000-0000-0000-0000-000000000001',
        email: 'mei@example.com',
        displayName: 'Mei Lin',
        passkeys: 1,
      },
      { id: '10000000-0000-0000-0000-000000000001', email: 'owner@zephyr.test', staff: 'owner', passkeys: 1 },
      { id: '10000000-0000-0000-0000-000000000002', email: 'admin@zephyr.test', staff: 'admin', passkeys: 1 },
      {
        id: '10000000-0000-0000-0000-000000000003',
        email: 'support@zephyr.test',
        staff: 'support',
        passkeys: 1,
      },
      {
        id: '10000000-0000-0000-0000-000000000004',
        email: 'new.staff@zephyr.test',
        staff: 'admin',
        passkeys: 0,
      },
    ],
    turnstile: { success: true, hostname: 'zephyrapp.midnightpoetry.studio', action: 'email_start' },
    rpc: {},
    calls: [],
    emails: [],
    resendStatus: 200,
    code: '123456',
    passkeyUser: null,
    refresh: new Map(),
    createUserStatus: 200,
  } satisfies World);
  limiterOk = true;
  limiterKeys.length = 0;
}

const byEmail = (e: string) => world.users.find((u) => u.email === String(e).toLowerCase());
const byId = (id: string) => world.users.find((u) => u.id === id);

export async function sessionFor(u: User, amr: string[] = ['otp']) {
  const rt = `rt-${crypto.randomUUID()}`;
  world.refresh.set(rt, u);
  return {
    access_token: await sbToken({ sub: u.id, email: u.email, amr }),
    refresh_token: rt,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: u.id, email: u.email },
  };
}

// Default RPC behaviour, close enough to the SQL for routing tests. Tests override as needed.
const defaultRpc: Record<string, (a: Record<string, unknown>) => unknown> = {
  get_public_config: () => ({
    signupMode: 'invite_only',
    acceptingInviteRequests: true,
    signupsPaused: false,
  }),
  submit_invite_request: () => 'accepted',
  get_signup_overview: () => ({
    settings: {
      signupMode: 'invite_only',
      acceptInviteRequests: true,
      signupsPaused: false,
      memberInvitesEnabled: true,
      memberInvitesPerMonth: 3,
      inviteTtlDays: 7,
    },
    pendingRequests: 0,
    pendingInvites: 0,
    codes: [],
  }),
  rate_limit_hit: () => true,
  rate_limit_count: () => 0,
  rate_limit_record: () => null,
  account_kind: (a) => {
    const u = byEmail(String(a.p_email));
    return !u ? 'none' : u.staff ? 'staff' : 'member';
  },
  user_id_by_email: (a) => byEmail(String(a.p_email))?.id ?? null,
  is_staff: (a) => Boolean(byId(String(a.p_user_id))?.staff),
  staff_lookup: (a) => {
    const u = byId(String(a.p_user_id));
    return u?.staff ? { role: u.staff, email: u.email, displayName: u.displayName ?? null } : null;
  },
  get_session_profile: (a) => {
    const u = byId(String(a.p_user_id));
    return u
      ? {
          isStaff: Boolean(u.staff),
          displayName: u.displayName ?? null,
          plan: 'free',
          createdAt: '2026-10-01T00:00:00Z',
          deleted: false,
        }
      : null;
  },
  update_display_name: (a) => {
    const u = byId(String(a.p_user_id));
    if (u) u.displayName = String(a.p_name);
    return null;
  },
};

function json(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function gotrueHandler(
  method: string,
  path: string,
  body: Record<string, unknown>,
  h: Headers,
): Promise<Response> {
  const bearer = (h.get('Authorization') ?? '').replace(/^Bearer /, '');
  const userFromBearer = () => {
    try {
      const payload = JSON.parse(atob(bearer.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? ''));
      return byId(payload.sub);
    } catch {
      return undefined;
    }
  };
  if (path === '/.well-known/jwks.json') return json({ keys: [sbKeys.jwk] });
  if (method === 'POST' && path === '/otp') return json({});
  if (method === 'POST' && path === '/verify') {
    if (body.type === 'email') {
      const u = byEmail(String(body.email));
      if (!u || body.token !== world.code) return json({ error_code: 'otp_expired' }, 403);
      return json(await sessionFor(u, ['otp']));
    }
    const u = world.users.find((x) => `hashed-${x.email}` === body.token_hash);
    if (!u) return json({ error_code: 'otp_expired' }, 403);
    return json(await sessionFor(u, ['magiclink']));
  }
  if (method === 'POST' && path.startsWith('/token')) {
    const u = world.refresh.get(String(body.refresh_token));
    if (!u) return json({ error_code: 'refresh_token_not_found' }, 400);
    world.refresh.delete(String(body.refresh_token));
    return json(await sessionFor(u));
  }
  if (method === 'POST' && path.startsWith('/logout')) return new Response(null, { status: 204 });
  if (method === 'GET' && path === '/user') return json(userFromBearer() ?? {}, userFromBearer() ? 200 : 401);
  if (method === 'POST' && path === '/passkeys/authentication/options') {
    return json({ challenge_id: 'ch-auth', options: { challenge: 'abc', rpId: 'midnightpoetry.studio' } });
  }
  if (method === 'POST' && path === '/passkeys/authentication/verify') {
    if (!world.passkeyUser || body.challenge_id !== 'ch-auth')
      return json({ error_code: 'webauthn_verification_failed' }, 400);
    return json(await sessionFor(world.passkeyUser, ['passkey']));
  }
  if (method === 'POST' && path === '/passkeys/registration/options') {
    if (!userFromBearer()) return json({}, 401);
    return json({ challenge_id: 'ch-reg', options: { challenge: 'xyz' } });
  }
  if (method === 'POST' && path === '/passkeys/registration/verify') {
    const u = userFromBearer();
    if (!u || body.challenge_id !== 'ch-reg')
      return json({ error_code: 'webauthn_verification_failed' }, 400);
    u.passkeys = (u.passkeys ?? 0) + 1;
    return json({ id: 'pk-new', friendly_name: 'iCloud Keychain', created_at: '2026-10-28T00:00:00Z' });
  }
  if (method === 'GET' && path === '/passkeys') {
    const u = userFromBearer();
    return json(
      Array.from({ length: u?.passkeys ?? 0 }, (_, i) => ({
        id: `pk-${i}`,
        friendly_name: `Key ${i}`,
        created_at: '2026-10-01T00:00:00Z',
      })),
    );
  }
  if (method === 'PATCH' && path.startsWith('/passkeys/')) {
    return json({
      id: path.split('/')[2],
      friendly_name: body.friendly_name,
      created_at: '2026-10-01T00:00:00Z',
    });
  }
  if (method === 'DELETE' && path.startsWith('/passkeys/')) return new Response(null, { status: 204 });
  if (method === 'POST' && path === '/admin/users') {
    if (world.createUserStatus !== 200) return json({ error_code: 'x' }, world.createUserStatus);
    if (byEmail(String(body.email))) return json({ error_code: 'email_exists' }, 422);
    const u: User = { id: crypto.randomUUID(), email: String(body.email).toLowerCase(), passkeys: 0 };
    world.users.push(u);
    return json({ id: u.id, email: u.email });
  }
  if (method === 'POST' && path === '/admin/generate_link') {
    const u = byEmail(String(body.email));
    if (!u) return json({ error_code: 'user_not_found' }, 404);
    return json({
      id: u.id,
      email: u.email,
      hashed_token: `hashed-${u.email}`,
      verification_type: 'magiclink',
    });
  }
  const m = path.match(/^\/admin\/users\/([^/]+)\/passkeys$/);
  if (method === 'GET' && m) {
    const u = byId(decodeURIComponent(m[1] ?? ''));
    return json(
      Array.from({ length: u?.passkeys ?? 0 }, (_, i) => ({
        id: `pk-${i}`,
        created_at: '2026-10-01T00:00:00Z',
      })),
    );
  }
  return json({ error_code: 'not_mocked' }, 500);
}

export function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      world.calls.push({ url, method, body, headers });
      if (url.startsWith('https://challenges.cloudflare.com/')) return json(world.turnstile);
      if (url === `https://${TEAM}/cdn-cgi/access/certs`) return json({ keys: [cfKeys.jwk] });
      if (url.startsWith('https://api.resend.com/')) {
        const b = body as { to: string[]; subject: string; html: string; text: string };
        if (world.resendStatus === 200)
          world.emails.push({ to: b.to[0] ?? '', subject: b.subject, html: b.html, text: b.text });
        return json({ id: 'email-1' }, world.resendStatus);
      }
      if (url.startsWith(`${SB}/rest/v1/rpc/`)) {
        const fn = url.slice(`${SB}/rest/v1/rpc/`.length);
        const handler = world.rpc[fn] ?? defaultRpc[fn];
        if (!handler) return json({ message: `rpc ${fn} not mocked` }, 500);
        const out = handler((body ?? {}) as Record<string, unknown>);
        return out instanceof Response ? out : json(out ?? null);
      }
      if (url.startsWith(`${SB}/auth/v1`)) {
        const path = url.slice(`${SB}/auth/v1`.length);
        return gotrueHandler(
          method,
          path.split('?')[0] === '/token' ? path : (path.split('?')[0] ?? ''),
          (body ?? {}) as Record<string, unknown>,
          headers,
        );
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  );
}

// ---- requests -------------------------------------------------------------------------------------
export interface Jar {
  cookies: Map<string, string>;
}
export const jar = (): Jar => ({ cookies: new Map() });

export function absorb(j: Jar, res: Response) {
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const i = pair?.indexOf('=') ?? -1;
    if (!pair || i < 0) continue;
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (/Max-Age=0/i.test(sc)) j.cookies.delete(name);
    else j.cookies.set(name, value);
  }
}

export interface ReqOpts {
  method?: string;
  body?: unknown;
  origin?: string | null;
  jar?: Jar;
  ip?: string;
  access?: string | null;
  headers?: Record<string, string>;
}
export async function call(path: string, o: ReqOpts = {}): Promise<Response> {
  const method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
  const h: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? '203.0.113.7', ...o.headers };
  const defaultOrigin = path.startsWith('/admin') ? LANDING : APP;
  if (method !== 'GET' && o.origin !== null) h.Origin = o.origin ?? defaultOrigin;
  if (o.body !== undefined) h['Content-Type'] = 'application/json';
  if (o.jar?.cookies.size) h.Cookie = [...o.jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (o.access) h['Cf-Access-Jwt-Assertion'] = o.access;
  const host = path.startsWith('/admin') ? 'https://zephyr.midnightpoetry.studio' : APP;
  const res = await app.request(
    `${host}${path}`,
    {
      method,
      headers: h,
      body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
    },
    env,
  );
  if (o.jar) absorb(o.jar, res);
  return res;
}

/** Response JSON for assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON shapes
export const read = async (r: Response): Promise<any> => r.json();

/** Narrows away null/undefined in tests, failing loudly. */
export function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}
