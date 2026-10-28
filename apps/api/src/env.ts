export interface Env {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  /** Publishable (anon) key: the `apikey` header on user-level Auth calls. Not a secret. */
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Secret (service-role) key: PostgREST RPCs and the Auth admin API. Server-side only. */
  SUPABASE_SECRET_KEY?: string;
  /** @deprecated Phase 1 name for SUPABASE_SECRET_KEY; still read if the new one isn't set. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Origins allowed to POST to the landing-page routes (invite requests). */
  ALLOWED_ORIGINS: string;
  /** Origins allowed to call the app routes (zephyrapp). */
  APP_ORIGINS: string;
  /** Origins allowed to call /admin/api (the landing host). */
  ADMIN_ORIGINS: string;
  /** Base URL of the app, used to build invite links. */
  APP_URL: string;
  /** Comma-separated hostnames a Turnstile token may come from. */
  TURNSTILE_EXPECTED_HOSTNAMES: string;
  /** Cloudflare Access team domain, e.g. midnightpoetry.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** Audience (AUD) tag of the Access application protecting /admin. */
  CF_ACCESS_AUD: string;
  /** Development only: skip Access and act as this email. Ignored unless ENVIRONMENT=development and the request is to localhost. */
  CF_ACCESS_DEV_EMAIL?: string;
  /** "Zephyr <hello@zephyr.midnightpoetry.studio>" */
  EMAIL_FROM: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  IP_HASH_SECRET: string;
  /** Signs the admin idle-timeout cookie. 32+ random bytes. */
  SESSION_HMAC_SECRET: string;
  BURST_LIMITER: RateLimit;
  /** Per-member limit on upload part and variant PUTs (wrangler.jsonc ratelimits). */
  UPLOAD_LIMITER: RateLimit;
  /** Private photo bucket (zephyr-photos): originals and variants under u/<ownerId>/p/<photoId>/. */
  PHOTOS: R2Bucket;
}

export const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const supabaseUrl = (env: Env) => env.SUPABASE_URL.replace(/\/$/, '');

export function secretKey(env: Env): string {
  const k = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error('SUPABASE_SECRET_KEY is not set');
  return k;
}

/**
 * Headers for calling Supabase with a key. New-style keys (sb_publishable_…, sb_secret_…) go only in
 * `apikey`; legacy JWT keys also go in Authorization. A user's access token, when given, is the
 * Authorization bearer.
 */
export function supabaseHeaders(key: string, userJwt?: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, Accept: 'application/json' };
  if (userJwt) h.Authorization = `Bearer ${userJwt}`;
  else if (key.split('.').length === 3) h.Authorization = `Bearer ${key}`;
  return h;
}
