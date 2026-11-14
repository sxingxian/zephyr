// Response headers for the member app's HTML. Shared by the app Worker, which serves every HTML response
// (phase 8), and scripts/csp.mjs, which writes the default variant into dist/_headers and checks both variants.
// Plain JS so the Node build script can import it as is.
import { TURNSTILE_ORIGIN } from './guestHeaders.js';

/**
 * Google AdSense and its consent message (Privacy & messaging), added only while AdSense is turned on in
 * Admin. Only these four directives widen; everything else stays exactly as strict as the default policy.
 */
export const ADSENSE_SOURCES = {
  'script-src': [
    'https://pagead2.googlesyndication.com',
    'https://tpc.googlesyndication.com',
    'https://partner.googleadservices.com',
    'https://www.googletagservices.com',
    'https://adservice.google.com',
    'https://fundingchoicesmessages.google.com',
    'https://ep1.adtrafficquality.google',
    'https://ep2.adtrafficquality.google',
  ],
  'frame-src': [
    'https://googleads.g.doubleclick.net',
    'https://tpc.googlesyndication.com',
    'https://pagead2.googlesyndication.com',
    'https://www.google.com',
    'https://fundingchoicesmessages.google.com',
    'https://ep1.adtrafficquality.google',
    'https://ep2.adtrafficquality.google',
  ],
  'img-src': [
    'https://pagead2.googlesyndication.com',
    'https://tpc.googlesyndication.com',
    'https://googleads.g.doubleclick.net',
    'https://www.google.com',
    'https://www.gstatic.com',
    'https://fundingchoicesmessages.google.com',
    'https://ep1.adtrafficquality.google',
    'https://ep2.adtrafficquality.google',
  ],
  'connect-src': [
    'https://pagead2.googlesyndication.com',
    'https://googleads.g.doubleclick.net',
    'https://fundingchoicesmessages.google.com',
    'https://www.google.com',
    'https://csi.gstatic.com',
    'https://ep1.adtrafficquality.google',
    'https://ep2.adtrafficquality.google',
  ],
};

/**
 * The member app's Content-Security-Policy. `hashes` are the inline script hashes found at build time.
 * Default: 'self' plus Cloudflare Turnstile only. `adsense: true` adds ADSENSE_SOURCES and nothing else.
 */
export function appCsp(hashes = [], { adsense = false } = {}) {
  const extra = (d) => (adsense ? ` ${ADSENSE_SOURCES[d].join(' ')}` : '');
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets hash-wasm compile its SHA-256 WebAssembly (upload fingerprinting). It allows
    // WebAssembly compilation only, not JavaScript eval; the worker script itself is 'self'.
    `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE_ORIGIN}${extra('script-src')} ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${extra('img-src')}`,
    "font-src 'self'",
    `connect-src 'self'${extra('connect-src')}`,
    `frame-src ${TURNSTILE_ORIGIN}${extra('frame-src')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** Every other security header of the app's pages (unchanged by AdSense). */
export const APP_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
};

/** Written by scripts/csp.mjs next to the build: the inline script hashes the Worker needs at run time. */
export const APP_HEADERS_FILE = '/app-headers.json';
