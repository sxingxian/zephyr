/**
 * Sessions as httpOnly cookies (backend-for-frontend). The browser never sees a token.
 *
 *   app:   __Host-zs-at, __Host-zs-rt                  Path=/  SameSite=Lax     (app host)
 *   admin: __Host-za-at, __Host-za-rt, __Host-za-seen  Path=/  SameSite=Strict  (landing host)
 *
 * __Host- cookies must be Secure, Path=/ and carry no Domain, so a sibling *.midnightpoetry.studio
 * host can't set or shadow them (cookie tossing). As a second line, a request that carries any of a
 * realm's cookie names twice is refused and its cookies cleared (rejectDuplicateCookies).
 *
 * Access tokens are verified on every request against Supabase's JWKS and refreshed when under five
 * minutes remain. The admin session also carries an HMAC-signed last-activity time and locks after
 * 30 idle minutes.
 */

import {
  ADS_DOC_COOKIE,
  ADS_DOC_COOKIE_MAX_AGE,
  ADS_SEEN_COOKIE,
  ADS_SEEN_COOKIE_MAX_AGE,
  signAdsCookie,
} from '@zephyr/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { sign, unsign } from '../crypto';
import { type Env, supabaseUrl } from '../env';
import type { HonoEnv } from '../types';
import { type GoTrueSession, gotrue } from './gotrue';

export type Realm = 'app' | 'admin';

const REALMS = {
  app: {
    at: '__Host-zs-at',
    rt: '__Host-zs-rt',
    path: '/',
    sameSite: 'Lax',
    refreshMaxAge: 60 * 60 * 24 * 30,
  },
  admin: {
    at: '__Host-za-at',
    rt: '__Host-za-rt',
    path: '/',
    sameSite: 'Strict',
    refreshMaxAge: 60 * 60 * 12,
  },
} as const;
export const ADMIN_SEEN_COOKIE = '__Host-za-seen';
/** Every cookie name a realm uses. */
export const COOKIE_NAMES: Record<Realm, readonly string[]> = {
  app: [REALMS.app.at, REALMS.app.rt],
  admin: [REALMS.admin.at, REALMS.admin.rt, ADMIN_SEEN_COOKIE],
};
/** Adding or removing a passkey needs a sign-in this recent. */
export const RECENT_AUTH_SECONDS = 10 * 60;
export const ADMIN_IDLE_SECONDS = 30 * 60;
const REFRESH_WHEN_UNDER_SECONDS = 5 * 60;

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  session_id?: string;
  aal?: string;
  amr?: ({ method?: string; timestamp?: number } | string)[];
  role?: string;
}
export interface ActiveSession {
  userId: string;
  email: string;
  claims: SessionClaims;
  accessToken: string;
}

// ---- cookies -------------------------------------------------------------------------------------
function cookie(name: string, value: string, path: string, sameSite: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=${sameSite}`;
}

export function sessionCookies(realm: Realm, s: GoTrueSession): string[] {
  const r = REALMS[realm];
  return [
    cookie(r.at, s.access_token, r.path, r.sameSite, s.expires_in || 3600),
    cookie(r.rt, s.refresh_token, r.path, r.sameSite, r.refreshMaxAge),
  ];
}

export function clearCookies(realm: Realm): string[] {
  const r = REALMS[realm];
  const out = [cookie(r.at, '', r.path, r.sameSite, 0), cookie(r.rt, '', r.path, r.sameSite, 0)];
  if (realm === 'admin') out.push(cookie(ADMIN_SEEN_COOKIE, '', r.path, r.sameSite, 0));
  // Phase 8: the AdSense cookie goes with the member's session (the next document gets the strict CSP).
  if (realm === 'app') out.push(cookie(ADS_DOC_COOKIE, '', '/', 'Strict', 0));
  return out;
}

/**
 * Phase 8: the AdSense cookie for `userId` (a signed, 15-minute value the app Worker checks before it widens a
 * document's CSP), or the header that clears it (`userId` null, or no ADS_COOKIE_SECRET configured).
 */
export async function adsDocCookie(env: Env, userId: string | null): Promise<string> {
  if (!userId || !env.ADS_COOKIE_SECRET || env.ADS_COOKIE_SECRET.length < 16)
    return cookie(ADS_DOC_COOKIE, '', '/', 'Strict', 0);
  const value = await signAdsCookie(
    env.ADS_COOKIE_SECRET,
    userId,
    Math.floor(Date.now() / 1000) + ADS_DOC_COOKIE_MAX_AGE,
  );
  return cookie(ADS_DOC_COOKIE, value, '/', 'Strict', ADS_DOC_COOKIE_MAX_AGE);
}
/** Phase 8: "this browser may have run Google's AdSense script" (30 days), or the header that clears it. */
export function adsSeenCookie(on: boolean): string {
  return cookie(ADS_SEEN_COOKIE, on ? '1' : '', '/', 'Strict', on ? ADS_SEEN_COOKIE_MAX_AGE : 0);
}

export async function adminSeenCookie(env: Env, userId: string): Promise<string> {
  const value = await sign(`${userId}:${Math.floor(Date.now() / 1000)}`, env.SESSION_HMAC_SECRET);
  return cookie(ADMIN_SEEN_COOKIE, value, REALMS.admin.path, REALMS.admin.sameSite, ADMIN_IDLE_SECONDS);
}

export function appendCookies(c: Context, cookies: string[]) {
  for (const v of cookies) c.header('Set-Cookie', v, { append: true });
}

/** True if the Cookie header names any of the realm's cookies more than once. */
export function hasDuplicateSessionCookie(header: string | undefined, realm: Realm): boolean {
  if (!header) return false;
  const names = COOKIE_NAMES[realm];
  const seen = new Set<string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    const name = (i < 0 ? part : part.slice(0, i)).trim();
    if (!names.includes(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * Refuses (401, cookies cleared) any request carrying a session cookie name twice: whichever copy a
 * parser picks, one of them was planted.
 */
export function rejectDuplicateCookies(realm: Realm): MiddlewareHandler {
  return async (c, next) => {
    if (hasDuplicateSessionCookie(c.req.header('Cookie'), realm)) {
      appendCookies(c, clearCookies(realm));
      return c.json({ ok: false, error: 'unauthenticated' }, 401);
    }
    await next();
  };
}

// ---- token verification --------------------------------------------------------------------------
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(env: Env) {
  const url = `${supabaseUrl(env)}/auth/v1/.well-known/jwks.json`;
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksCache.set(url, set);
  }
  return set;
}

/** Verifies a Supabase access token: signature (JWKS), issuer, audience and expiry. */
export async function verifyAccessToken(env: Env, token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(env), {
      issuer: `${supabaseUrl(env)}/auth/v1`,
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256', 'EdDSA'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return payload as SessionClaims;
  } catch {
    return null;
  }
}

/** True if the session was established with a passkey (Supabase's AMR method names). */
export function signedInWithPasskey(claims: SessionClaims): boolean {
  const methods = (claims.amr ?? []).map((a) => (typeof a === 'string' ? a : a?.method));
  return methods.some((m) => m === 'passkey' || m === 'webauthn' || m === 'mfa/webauthn');
}

/**
 * When the user last actually authenticated: the newest `amr` timestamp (kept as-is across refreshes),
 * or, only if the token has none, its `iat`.
 */
export function authenticatedAt(claims: SessionClaims): number | null {
  const stamps = (claims.amr ?? [])
    .map((a) => (typeof a === 'object' && a ? (a as { timestamp?: unknown }).timestamp : undefined))
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  if (stamps.length) return Math.max(...stamps);
  return typeof claims.iat === 'number' ? claims.iat : null;
}

/** True if the session's sign-in happened within RECENT_AUTH_SECONDS. */
export function recentlyAuthenticated(claims: SessionClaims, now = Date.now() / 1000): boolean {
  const at = authenticatedAt(claims);
  return at !== null && now - at <= RECENT_AUTH_SECONDS && at <= now + 60;
}

/**
 * Reads the realm's cookies and returns the active session, refreshing it if needed (new cookies are
 * appended to the response). Returns null, clearing the cookies, when there's no usable session.
 */
export async function resolveSession(c: Context<HonoEnv>, realm: Realm): Promise<ActiveSession | null> {
  const r = REALMS[realm];
  const at = getCookie(c, r.at);
  const rt = getCookie(c, r.rt);
  if (!at && !rt) return null;

  let claims = at ? await verifyAccessToken(c.env, at) : null;
  let token = at ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!claims || (claims.exp ?? 0) - now < REFRESH_WHEN_UNDER_SECONDS) {
    if (!rt) {
      if (claims) return toActive(claims, token);
      appendCookies(c, clearCookies(realm));
      return null;
    }
    try {
      const fresh = await gotrue.refresh(c.env, rt);
      const freshClaims = await verifyAccessToken(c.env, fresh.access_token);
      if (!freshClaims) throw new Error('refresh produced no valid token');
      appendCookies(c, sessionCookies(realm, fresh));
      claims = freshClaims;
      token = fresh.access_token;
    } catch {
      // A still-valid token keeps working until it expires; otherwise the session is over.
      if (claims && (claims.exp ?? 0) > now) return toActive(claims, token);
      appendCookies(c, clearCookies(realm));
      return null;
    }
  }
  return toActive(claims, token);
}

function toActive(claims: SessionClaims, token: string): ActiveSession {
  return { userId: claims.sub, email: (claims.email ?? '').toLowerCase(), claims, accessToken: token };
}

/** Checks the admin idle cookie: present, correctly signed, for this user and under 30 minutes old. */
export async function adminSeenIsFresh(c: Context<HonoEnv>, userId: string): Promise<boolean> {
  const raw = getCookie(c, ADMIN_SEEN_COOKIE);
  if (!raw) return false;
  const value = await unsign(raw, c.env.SESSION_HMAC_SECRET);
  if (!value) return false;
  const [uid, ts] = value.split(':');
  const t = Number(ts);
  return uid === userId && Number.isFinite(t) && Date.now() / 1000 - t <= ADMIN_IDLE_SECONDS;
}

/** Ends the session upstream (best effort) and clears the cookies. */
export async function endSession(c: Context<HonoEnv>, realm: Realm, accessToken?: string) {
  const token = accessToken ?? getCookie(c, REALMS[realm].at);
  if (token) {
    try {
      await gotrue.logout(c.env, token);
    } catch {
      /* the cookies go anyway */
    }
  }
  appendCookies(c, clearCookies(realm));
}
