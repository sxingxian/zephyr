// Response headers for the guest gallery page (/g/*). Shared by the app Worker, which serves the page, and
// scripts/csp.mjs, which writes the same headers into dist/_headers for /guest. Plain JS so the Node build
// script can import it as is.

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Stricter than the member app: no WebAssembly, no workers, no manifest, no form posts, and Cloudflare
 * Turnstile (passcode screen, after repeated wrong codes) is the only third party. Images and API calls are
 * same-origin; image bytes come signed from /api/v1/g/…; blob: is for the in-browser .zip download link.
 */
export const GUEST_CSP = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${TURNSTILE_ORIGIN}`,
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/**
 * The link token is in the path: never send it on as a Referer, never cache or index the page.
 * `strict-origin` sends only "https://zephyrapp.midnightpoetry.studio" (never the path, so never the token),
 * which keeps Cloudflare Turnstile's domain check working in browsers without location.ancestorOrigins.
 * Every image and API request on the page also sets referrerPolicy "no-referrer" itself.
 */
export const GUEST_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': GUEST_CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(), publickey-credentials-create=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'no-store',
};
