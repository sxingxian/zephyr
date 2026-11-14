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
  /** Per-member limit on edit and recipe writes (saves, reverts, bulk, recipes). */
  EDIT_LIMITER: RateLimit;
  /** Private photo bucket (zephyr-photos): originals and variants under u/<ownerId>/p/<photoId>/. */
  PHOTOS: R2Bucket;

  // ---- Phase 5: sharing ----
  /** Guest renditions and branding assets (zephyr-shared), under o/<ownerId>/. Read through MEDIA_HOST. */
  SHARED: R2Bucket;
  /** Cloudflare Images binding: every guest rendition and branding asset is re-encoded with it. */
  IMAGES: ImagesBinding;
  /** The zephyr-shared custom domain (media.midnightpoetry.studio), reachable only with MEDIA_HOST_SECRET. */
  MEDIA_HOST: string;
  /** Sent as X-Zephyr-Media to the media host; its WAF rule blocks every request without it. */
  MEDIA_HOST_SECRET: string;
  /** Keys passcode HMACs (a database leak alone can't be brute-forced offline). */
  GALLERY_PEPPER: string;
  /** AES-256-GCM key (32 random bytes, base64) encrypting gallery link tokens at rest, so owners can copy links again. */
  GALLERY_LINK_KEY: string;
  /** Signs guests' unlock cookies. */
  GUEST_COOKIE_SECRET: string;
  /** Signs guest media URLs (one hour). */
  MEDIA_URL_SECRET: string;
  /** Where CSAM matches and CSAM reports are sent (the safety team's address). */
  SAFETY_ALERT_EMAIL: string;
  /** Per-member sharing writes. */
  SHARE_LIMITER: RateLimit;
  /** Guest page and API calls per network (token lookups included). */
  GUEST_LIMITER: RateLimit;
  /** Guest media requests per network. */
  MEDIA_LIMITER: RateLimit;

  // ---- Phase 6: Zephyr AI ----
  /** Workers AI (scene tags), always called through AI Gateway in production. */
  AI: WorkersAi;
  /** The zephyr-ai queue: background-removal items and scene tags (ids only, never image bytes). */
  AI_QUEUE: Queue<AiMessage>;
  /** Per-member AI writes (job creation, settings, signals, faces, people). */
  AI_LIMITER: RateLimit;
  /** Phase 6: face batches per member (10 a minute). */
  FACES_LIMITER: RateLimit;
  /** Phase 6: Zephyr AI reads per member (300 a minute). */
  AI_READ_LIMITER: RateLimit;

  // ---- Phase 7: billing and teams ----
  /** Per-member billing and team writes (20 a minute). */
  BILLING_LIMITER: RateLimit;
  /** Per-member team invite sends (5 a minute; plus 20 an hour in Postgres). */
  TEAM_INVITE_LIMITER: RateLimit;
  /** Phase 8: admin writes, 60 a minute per staff member (namespace 1012). */
  ADMIN_LIMITER: RateLimit;
  /** Phase 8: ad reads and events, 120 a minute per member (namespace 1013). */
  ADS_LIMITER: RateLimit;
  /** Cloudflare account id and gateway id of the AI Gateway every cloud AI call goes through. */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** Authenticated gateway token (cf-aig-authorization). */
  AI_GATEWAY_TOKEN?: string;
  RUNWARE_API_KEY?: string;
  FAL_KEY?: string;

  // ---- Phase 7: billing (Stripe, Managed Payments) ----
  /** Restricted Stripe key (docs/phase-7.md, Build step 0). Unset: billing answers 503 billing_unavailable. */
  STRIPE_SECRET_KEY?: string;
  /** Signing secret of the webhook endpoint (whsec_…). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Pinned Stripe API version; defaults to the installed SDK's version. */
  STRIPE_API_VERSION?: string;
}

/** The slice of the Workers AI binding the API uses. */
export interface WorkersAi {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { gateway?: { id: string; skipCache?: boolean } },
  ): Promise<unknown>;
}
/** Messages on the zephyr-ai queue. */
export type AiMessage = { t: 'bg'; item: string } | { t: 'scene'; photo: string; owner: string };

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
