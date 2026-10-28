/**
 * Cloudflare Access in front of /admin. The edge only lets an approved identity through, but the API
 * still verifies the Access JWT itself (signature, issuer, audience, expiry), so a misconfigured or
 * bypassed Access policy can't expose admin routes. The staff session's email must match it.
 */

import type { Context } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { HonoEnv } from '../types';

const certsCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function certs(team: string) {
  const url = `https://${team}/cdn-cgi/access/certs`;
  let set = certsCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    certsCache.set(url, set);
  }
  return set;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The Access identity's email (lower-cased), or null if the request didn't come through Access. */
export async function accessEmail(c: Context<HonoEnv>): Promise<string | null> {
  const env = c.env;
  if (
    env.ENVIRONMENT === 'development' &&
    env.CF_ACCESS_DEV_EMAIL &&
    LOCAL_HOSTS.has(new URL(c.req.url).hostname)
  ) {
    return env.CF_ACCESS_DEV_EMAIL.toLowerCase();
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  const team = (env.CF_ACCESS_TEAM_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!token || !team || !env.CF_ACCESS_AUD) return null;
  try {
    const { payload } = await jwtVerify(token, certs(team), {
      issuer: `https://${team}`,
      audience: env.CF_ACCESS_AUD,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email || null;
  } catch {
    return null;
  }
}
