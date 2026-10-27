export interface Env {
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  /** Comma-separated list of origins allowed to POST (e.g. https://zephyr.midnightpoetry.studio). */
  ALLOWED_ORIGINS: string;
  /** Comma-separated hostnames a Turnstile token may come from. */
  TURNSTILE_EXPECTED_HOSTNAMES: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  IP_HASH_SECRET: string;
  BURST_LIMITER: RateLimit;
}

export const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
