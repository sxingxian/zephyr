/**
 * Sessions as httpOnly cookies (backend-for-frontend). The browser never sees a token.
 *
 *   app:   __Secure-zs-at, __Secure-zs-rt                    Path=/api    SameSite=Lax
 *   admin: __Secure-za-at, __Secure-za-rt, __Secure-za-seen  Path=/admin  SameSite=Strict
 *
 * Access tokens are verified on every request against Supabase's JWKS and refreshed when under five
 * minutes remain. The admin session also carries an HMAC-signed last-activity time and locks after
 * 30 idle minutes.
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { sign, unsign } from '../crypto';
import { type Env, supabaseUrl } from '../env';
import type { HonoEnv } from '../types';
import { type GoTrueSession, gotrue } from './gotrue';

export type Realm = 'app' | 'admin';

const REALMS = {
  app: {
    at: '__Secure-zs-at',
    rt: '__Secure-zs-rt',
    path: '/api',
    sameSite: 'Lax',
    refreshMaxAge: 60 * 60 * 24 * 30,
  },
  admin: {
    at: '__Secure-za-at',
    rt: '__Secure-za-rt',
    path: '/admin',
    sameSite: 'Strict',
    refreshMaxAge: 60 * 60 * 12,
  },
} as const;
export const ADMIN_SEEN_COOKIE = '__Secure-za-seen';
export const ADMIN_IDLE_SECONDS = 30 * 60;
const REFRESH_WHEN_UNDER_SECONDS = 5 * 60;

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  session_id?: string;
  aal?: string;
  amr?: ({ method?: string } | string)[];
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
  return out;
}

export async function adminSeenCookie(env: Env, userId: string): Promise<string> {
  const value = await sign(`${userId}:${Math.floor(Date.now() / 1000)}`, env.SESSION_HMAC_SECRET);
  return cookie(ADMIN_SEEN_COOKIE, value, REALMS.admin.path, REALMS.admin.sameSite, ADMIN_IDLE_SECONDS);
}

export function appendCookies(c: Context, cookies: string[]) {
  for (const v of cookies) c.header('Set-Cookie', v, { append: true });
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
