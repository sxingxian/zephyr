interface ImportMetaEnv {
  /** Cloudflare Turnstile site key (public). Defaults to Cloudflare's always-pass test key outside production. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
