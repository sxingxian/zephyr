/**
 * Test harness: a mocked fetch that plays Supabase (PostgREST RPCs, GoTrue, JWKS), Cloudflare
 * (Turnstile, Access certs) and Resend, plus real ES256/RS256 keys so tokens are genuinely verified.
 */
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { vi } from 'vitest';
import { resetAppStatusCache } from '../src/admin/app-status';
import { app } from '../src/app';
import { CODE_TIMING } from '../src/auth/code-limits';
import type { Env } from '../src/env';
import { resetAdsConfigCache } from '../src/routes/ads';
import { images, imagesBinding } from './images';
import { MockR2 } from './r2';

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
/** Whether the per-member upload limiter allows the next PUT. */
export const uploadLimiter = { ok: true, keys: [] as string[] };
/** Whether the per-member edit limiter allows the next edit write. */
export const editLimiter = { ok: true, keys: [] as string[] };
/** The PHOTOS bucket binding. */
export const r2 = new MockR2();
/** The SHARED bucket binding (phase 5: guest renditions and branding). */
export const shared = new MockR2();
/** Phase 5 per-member and per-network limiters. */
export const shareLimiter = { ok: true, keys: [] as string[] };
export const guestLimiter = { ok: true, keys: [] as string[] };
export const mediaLimiter = { ok: true, keys: [] as string[] };
const fakeLimiter = (l: { ok: boolean; keys: string[] }) =>
  ({
    limit: async ({ key }: { key: string }) => {
      l.keys.push(key);
      return { success: l.ok };
    },
  }) as unknown as RateLimit;
/** Phase 6: the zephyr-ai queue (messages sent), Workers AI (scene labels) and the per-member AI limiter. */
export const aiQueue = { sent: [] as unknown[], fail: false };
export const workersAi = {
  calls: [] as { model: string; options: unknown }[],
  result: [] as unknown,
  fail: false,
};
export const aiLimiter = { ok: true, keys: [] as string[] };
export const facesLimiter = { ok: true, keys: [] as string[] };
export const aiReadLimiter = { ok: true, keys: [] as string[] };
/** Phase 7 per-member limiters. */
export const billingLimiter = { ok: true, keys: [] as string[] };
export const teamInviteLimiter = { ok: true, keys: [] as string[] };
/** Phase 8: admin writes per staff member, ad reads/events per member. */
export const adminLimiter = { ok: true, keys: [] as string[] };
export const adsLimiter = { ok: true, keys: [] as string[] };
/** Phase 8: the zephyr-storage queue (messages sent). */
export const storageQueue = { sent: [] as unknown[], fail: false };
export const MEDIA_HOST = 'media.test';
export const MEDIA_SECRET = 'media-host-secret';

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
  AD_DEDUP_SECRET: 'ad-dedup-secret',
  ADS_COOKIE_SECRET: 'ads-cookie-secret-for-tests',
  SESSION_HMAC_SECRET: 'session-hmac-secret',
  BURST_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      limiterKeys.push(key);
      return { success: limiterOk };
    },
  } as unknown as RateLimit,
  UPLOAD_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      uploadLimiter.keys.push(key);
      return { success: uploadLimiter.ok };
    },
  } as unknown as RateLimit,
  EDIT_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      editLimiter.keys.push(key);
      return { success: editLimiter.ok };
    },
  } as unknown as RateLimit,
  PHOTOS: r2 as unknown as R2Bucket,
  SHARED: shared as unknown as R2Bucket,
  IMAGES: imagesBinding,
  MEDIA_HOST,
  MEDIA_HOST_SECRET: MEDIA_SECRET,
  GALLERY_PEPPER: 'gallery-pepper',
  GALLERY_LINK_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 + 3))),
  GUEST_COOKIE_SECRET: 'guest-cookie-secret',
  MEDIA_URL_SECRET: 'media-url-secret',
  SAFETY_ALERT_EMAIL: 'safety@zephyr.test',
  SHARE_LIMITER: fakeLimiter(shareLimiter),
  GUEST_LIMITER: fakeLimiter(guestLimiter),
  MEDIA_LIMITER: fakeLimiter(mediaLimiter),
  AI: {
    run: async (model: string, _inputs: Record<string, unknown>, options?: unknown) => {
      workersAi.calls.push({ model, options });
      if (workersAi.fail) throw new Error('workers ai down');
      return workersAi.result;
    },
  },
  AI_QUEUE: {
    send: async (body: unknown) => {
      if (aiQueue.fail) throw new Error('queue down');
      aiQueue.sent.push(body);
    },
    sendBatch: async (msgs: Iterable<{ body: unknown }>) => {
      if (aiQueue.fail) throw new Error('queue down');
      for (const m of msgs) aiQueue.sent.push(m.body);
    },
  } as unknown as Queue<import('../src/env').AiMessage>,
  AI_LIMITER: fakeLimiter(aiLimiter),
  FACES_LIMITER: fakeLimiter(facesLimiter),
  AI_READ_LIMITER: fakeLimiter(aiReadLimiter),
  BILLING_LIMITER: fakeLimiter(billingLimiter),
  TEAM_INVITE_LIMITER: fakeLimiter(teamInviteLimiter),
  ADMIN_LIMITER: fakeLimiter(adminLimiter),
  ADS_LIMITER: fakeLimiter(adsLimiter),
  AI_GATEWAY_ACCOUNT_ID: 'acct123',
  AI_GATEWAY_ID: 'zephyr-test',
  AI_GATEWAY_TOKEN: 'gateway-token',
  RUNWARE_API_KEY: 'runware-key',
  FAL_KEY: 'fal-key',
  STORAGE_QUEUE: {
    send: async (body: unknown) => {
      if (storageQueue.fail) throw new Error('queue down');
      storageQueue.sent.push(body);
    },
  } as unknown as Queue<import('../src/env').StorageMessage>,
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
  /** Seconds since the sign-in (amr timestamp). Default 0. */
  authAgo?: number;
}
export async function sbToken(o: TokenOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const keys = o.forged ? otherKeys : sbKeys;
  return new SignJWT({
    email: o.email,
    role: 'authenticated',
    amr: (o.amr ?? ['otp']).map((method) => ({ method, timestamp: now - (o.authAgo ?? 0) })),
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
  /** Phase 8: staff suspended this member (the default member_suspended). */
  suspended?: boolean;
  /** Phase 8: banned in Auth (removed staff). */
  banned?: boolean;
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
  /** In-memory rate_limit_attempts: "kind|key" → attempt times (ms). Synchronous, so atomic like the SQL. */
  limits: Map<string, number[]>;
  /** Called when GoTrue's admin API deletes a user (library tests cascade their rows). */
  onUserDeleted?: (id: string) => void;
  /** Bearer tokens GoTrue was asked to sign out globally. */
  globalLogouts: string[];
  /** The media host (zephyr-shared behind Cloudflare): keys it blocks with 451, whether it's down, what was fetched. */
  media: { blocked: Set<string>; down: boolean; fetched: string[] };
  /** Phase 6: answers for other hosts (AI providers); undefined falls through to "unexpected fetch". */
  external?: (call: Call, init?: RequestInit) => Response | Promise<Response> | undefined;
  /** Phase 7: team libraries for the default library_access: owner id → member id → role. */
  teams?: Record<string, Record<string, 'editor' | 'viewer'>>;
  /** Phase 7: the state and plan library_access reports. */
  libraryState?: 'active' | 'read_only';
  libraryPlan?: 'free' | 'pro' | 'studio';
  /** Phase 8: what the default app_status returns. */
  appStatus?: { readOnly: { on: boolean; message: string } | null; maintenance: unknown };
  /**
   * Phase 8 (review round 3): step-up codes, mirroring supabase/migrations/20261115100200_step_up.sql. `needed`
   * is what step_up_needed answers; `codes` holds "member|op" → the stored row.
   */
  stepUp: {
    needed: boolean;
    codes: Map<
      string,
      {
        hash: string | null;
        expires: number;
        attempts: number;
        sends: number;
        windowStart: number;
        grant: string | null;
        grantExpires: number;
      }
    >;
  };
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
    limits: new Map(),
    onUserDeleted: undefined,
    globalLogouts: [],
    media: { blocked: new Set(), down: false, fetched: [] },
    stepUp: { needed: false, codes: new Map() },
    external: undefined,
    teams: {},
    libraryState: 'active',
    libraryPlan: 'free',
  } satisfies World);
  aiQueue.sent.length = 0;
  aiQueue.fail = false;
  workersAi.calls.length = 0;
  workersAi.result = [];
  workersAi.fail = false;
  aiLimiter.ok = true;
  aiLimiter.keys.length = 0;
  facesLimiter.ok = true;
  facesLimiter.keys.length = 0;
  aiReadLimiter.ok = true;
  aiReadLimiter.keys.length = 0;
  resetAppStatusCache();
  resetAdsConfigCache();
  for (const l of [billingLimiter, teamInviteLimiter, adminLimiter, adsLimiter]) {
    l.ok = true;
    l.keys.length = 0;
  }
  shared.reset();
  images.reset();
  for (const l of [shareLimiter, guestLimiter, mediaLimiter]) {
    l.ok = true;
    l.keys.length = 0;
  }
  limiterOk = true;
  limiterKeys.length = 0;
  uploadLimiter.ok = true;
  uploadLimiter.keys.length = 0;
  editLimiter.ok = true;
  editLimiter.keys.length = 0;
  r2.reset();
  CODE_TIMING.floorMs = 0;
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
const STEP_UP_OPS = ['passkey_add', 'passkey_remove', 'account_delete'];
const stepUpRow = (user: string, op: string) => {
  const key = `${user}|${op}`;
  let r = world.stepUp.codes.get(key);
  if (!r) {
    r = {
      hash: null,
      expires: 0,
      attempts: 0,
      sends: 0,
      windowStart: Date.now(),
      grant: null,
      grantExpires: 0,
    };
    world.stepUp.codes.set(key, r);
  }
  return r;
};
const defaultRpc: Record<string, (a: Record<string, unknown>) => unknown> = {
  // Step-up codes (phase 8, review round 3), the same rules as the SQL.
  step_up_needed: () => world.stepUp.needed,
  step_up_issue: (a) => {
    if (!STEP_UP_OPS.includes(String(a.p_op))) return 'invalid';
    const r = stepUpRow(String(a.p_user), String(a.p_op));
    if (r.windowStart < Date.now() - 3600_000) {
      r.sends = 0;
      r.windowStart = Date.now();
    }
    if (r.sends >= 5) return 'rate_limited';
    Object.assign(r, {
      hash: String(a.p_hash),
      expires: Date.now() + 600_000,
      attempts: 0,
      sends: r.sends + 1,
    });
    return 'ok';
  },
  step_up_check: (a) => {
    const r = world.stepUp.codes.get(`${a.p_user}|${a.p_op}`);
    if (!r || r.hash === null) return 'invalid';
    if (r.expires <= Date.now()) {
      r.hash = null;
      return 'invalid';
    }
    if (r.hash !== a.p_hash) {
      r.attempts += 1;
      if (r.attempts >= 5) r.hash = null;
      return 'invalid';
    }
    r.hash = null;
    r.attempts = 0;
    r.grant = typeof a.p_grant === 'string' ? a.p_grant : null;
    r.grantExpires = r.grant ? Date.now() + 600_000 : 0;
    return 'ok';
  },
  step_up_grant_use: (a) => {
    const r = world.stepUp.codes.get(`${a.p_user}|${a.p_op}`);
    if (!r || r.grant === null || r.grant !== a.p_grant || r.grantExpires <= Date.now()) return false;
    r.grant = null;
    return true;
  },
  // Storage follow-ups (phase 8): none due unless a test says otherwise.
  storage_followup_add: () => 1,
  storage_followup_done: () => null,
  storage_followups_due: () => [],
  storage_followups_expire: () => 0,
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
  // Mirrors public.rate_limit_hit: count in the window, refuse at the limit without recording.
  rate_limit_hit: (a) => {
    const key = `${a.p_kind}|${a.p_key}`;
    const since = Date.now() - Number(a.p_window_seconds) * 1000;
    const hits = (world.limits.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= Number(a.p_limit)) return false;
    hits.push(Date.now());
    world.limits.set(key, hits);
    return true;
  },
  rate_limit_reset: (a) => {
    world.limits.delete(`${a.p_kind}|${a.p_key}`);
    return null;
  },
  revoke_unsent_invite: () => null,
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
  // Phase 7: a member's own library is always theirs; team libraries are added per test.
  library_access: (a) => {
    const member = String(a.p_member);
    const owner = String(a.p_owner);
    const team = world.teams?.[owner]?.[member];
    if (member === owner)
      return { role: 'owner', plan: world.libraryPlan ?? 'free', state: world.libraryState ?? 'active' };
    return team ? { role: team, plan: 'studio', state: world.libraryState ?? 'active' } : null;
  },
  // Phase 8: suspension and read-only mode.
  member_suspended: (a) => Boolean(byId(String(a.p_user))?.suspended),
  app_status: () => world.appStatus ?? { readOnly: null, maintenance: null },
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
  if (method === 'POST' && path.startsWith('/logout')) {
    if (path.includes('scope=global')) world.globalLogouts.push(bearer);
    return new Response(null, { status: 204 });
  }
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
  const del = path.match(/^\/admin\/users\/([^/]+)$/);
  if (method === 'PUT' && del) {
    const u = byId(decodeURIComponent(del[1] ?? ''));
    if (!u) return json({ error_code: 'user_not_found' }, 404);
    if (body.ban_duration !== undefined) u.banned = body.ban_duration !== 'none';
    return json({ id: u.id, email: u.email });
  }
  if (method === 'DELETE' && del) {
    const id = decodeURIComponent(del[1] ?? '');
    if (!byId(id)) return json({ error_code: 'user_not_found' }, 404);
    world.users = world.users.filter((u) => u.id !== id);
    world.onUserDeleted?.(id);
    return json({});
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
      if (url.startsWith(`https://${MEDIA_HOST}/`)) {
        // The WAF rule: anything without the secret is blocked.
        if (headers.get('X-Zephyr-Media') !== MEDIA_SECRET) return new Response('blocked', { status: 403 });
        const key = url.slice(`https://${MEDIA_HOST}/`.length).split('/').map(decodeURIComponent).join('/');
        world.media.fetched.push(key);
        if (world.media.down) return new Response('down', { status: 502 });
        if (world.media.blocked.has(key))
          return new Response('Unavailable For Legal Reasons', { status: 451 });
        const o = await shared.get(key);
        if (!o || !('body' in o)) return new Response('not found', { status: 404 });
        return new Response(o.body, {
          headers: {
            'Content-Type': o.httpMetadata?.contentType ?? 'application/octet-stream',
            'Content-Length': String(o.size),
          },
        });
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
          ['/token', '/logout'].includes(path.split('?')[0] ?? '') ? path : (path.split('?')[0] ?? ''),
          (body ?? {}) as Record<string, unknown>,
          headers,
        );
      }
      if (world.external) {
        const r = await world.external({ url, method, body, headers }, init);
        if (r) return r;
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }),
  );
}

// ---- WebAuthn -----------------------------------------------------------------------------------------
/** A credential JSON whose clientDataJSON says `type` and `origin` (signature checks are Auth's job). */
export function credential(
  type: 'webauthn.get' | 'webauthn.create',
  origin: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type, challenge: 'abc', origin, crossOrigin: false, ...extra }),
  ).toString('base64url');
  return { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { clientDataJSON } };
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
