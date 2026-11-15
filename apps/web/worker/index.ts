/**
 * App Worker for zephyrapp.midnightpoetry.studio. It runs first for every request (`run_worker_first: true`):
 *   /api/*     → passed unchanged to the API Worker through a service binding, so the API stays same-origin
 *                and its session cookies stay host-only;
 *   /g/*       → the guest gallery page (guest.html), a separate light app with its own stricter headers;
 *   /ads.txt   → phase 8: generated from the AdSense publisher id while AdSense is on, else 404;
 *   files      → static files (anything with an extension but .html) come straight from ASSETS, untouched,
 *                with their headers from dist/_headers;
 *   HTML       → phase 8: the PWA's pages (index.html, the SPA fallback) get the app's security headers here,
 *                never stored by the browser (`no-store`, which also keeps them out of the back/forward cache).
 *                The AdSense CSP variant goes only to documents on ad pages (worker/adPages.js), only while the
 *                API says AdSense is on (cached 60 s), and only when the request carries the AdSense cookie,
 *                which the API sets only for a member it shows AdSense. Every other document, and /index.html
 *                itself, always gets the strict policy.
 */
import { ADS_DOC_COOKIE, ADS_DOC_TIMING, adsAllowedOn } from './adPages.js';
import { APP_HEADERS, APP_HEADERS_FILE, appCsp } from './appHeaders.js';
import { GUEST_HEADERS } from './guestHeaders.js';

interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export function isGuestPath(pathname: string): boolean {
  return (
    pathname === '/g' || pathname.startsWith('/g/') || pathname === '/guest' || pathname === '/guest.html'
  );
}

/** The guest page is the same HTML for every /g/* path; the page reads the token from its own URL. */
export async function serveGuest(request: Request, env: Pick<Env, 'ASSETS'>): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  // Fetch the page itself, never forwarding the visitor's request (its URL carries the gallery token).
  const page = await env.ASSETS.fetch(new Request(new URL('/guest', request.url), { method: 'GET' }));
  if (!page.ok) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(request.method === 'HEAD' ? null : page.body, { status: 200, headers: GUEST_HEADERS });
}

/** Static files: a last path segment with an extension, except .html pages. */
export function isStaticFile(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(last) && !/\.html?$/i.test(last);
}

// ---------------------------------------------------------------- AdSense config (60 s cache)
/**
 * Internal API endpoint (no session, no member data): { enabled, publisherId }. Fetched through the service
 * binding without the visitor's cookies. Any failure or unexpected shape means "off": the strict policy.
 */
export const ADS_CONFIG_PATH = '/api/v1/ads/config-public';
export const ADS_CONFIG_TTL_MS = 60_000;
const PUBLISHER = /^ca-pub-\d{16}$/;
export interface AdsenseState {
  enabled: boolean;
  publisherId: string | null;
}
const OFF: AdsenseState = { enabled: false, publisherId: null };
let cached: { value: AdsenseState; at: number } | null = null;
let inflight: Promise<AdsenseState> | null = null;

export async function adsenseState(
  env: Pick<Env, 'API'>,
  origin: string,
  now = Date.now(),
): Promise<AdsenseState> {
  if (cached && now - cached.at < ADS_CONFIG_TTL_MS) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    let value = OFF;
    try {
      const res = await env.API.fetch(
        new Request(new URL(ADS_CONFIG_PATH, origin), {
          method: 'GET',
          headers: { accept: 'application/json' },
        }),
      );
      const body = (await res.json().catch(() => null)) as Partial<AdsenseState> | null;
      if (
        res.ok &&
        body?.enabled === true &&
        typeof body.publisherId === 'string' &&
        PUBLISHER.test(body.publisherId)
      )
        value = { enabled: true, publisherId: body.publisherId };
    } catch {
      value = OFF;
    }
    cached = { value, at: now };
    return value;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// ---------------------------------------------------------------- inline script hashes (from the build)
let hashes: string[] | null = null;
async function scriptHashes(env: Pick<Env, 'ASSETS'>, origin: string): Promise<string[]> {
  if (hashes) return hashes;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(APP_HEADERS_FILE, origin), { method: 'GET' }));
    const body = (await res.json().catch(() => null)) as { hashes?: unknown } | null;
    const list = Array.isArray(body?.hashes) ? body.hashes : [];
    // Only well-formed hash sources; anything else would be a way to smuggle sources into the policy.
    hashes = list.filter((h): h is string => typeof h === 'string' && /^'sha256-[A-Za-z0-9+/]+=*'$/.test(h));
    if (!res.ok) hashes = [];
  } catch {
    return [];
  }
  return hashes;
}

/** Test helper: forget the cached config and hashes. */
export function __resetForTest(): void {
  cached = null;
  inflight = null;
  hashes = null;
}

// ---------------------------------------------------------------- responses
const SECURITY = (): Headers => {
  const h = new Headers();
  for (const [k, v] of Object.entries(APP_HEADERS)) h.set(k, v);
  return h;
};

export async function serveAdsTxt(request: Request, env: Pick<Env, 'API'>): Promise<Response> {
  const state = await adsenseState(env, new URL(request.url).origin);
  const headers = SECURITY();
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (!state.enabled || !state.publisherId) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response('Not found\n', { status: 404, headers });
  }
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300');
  // Google's certification authority id for its ad system is fixed (f08c47fec0942fa0).
  const line = `google.com, ${state.publisherId.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`;
  return new Response(request.method === 'HEAD' ? null : line, { status: 200, headers });
}

/** Whether a document at this path may get the AdSense policy: only the ad pages, never `/index.html`. */
export function adsenseDocument(pathname: string): boolean {
  return pathname !== '/index.html' && adsAllowedOn(pathname);
}

/** True when the request carries the AdSense cookie (set by the API only for a member it shows AdSense). */
export function hasAdsCookie(request: Request): boolean {
  const header = request.headers.get('cookie');
  if (!header) return false;
  return header.split(';').some((part) => part.trim() === `${ADS_DOC_COOKIE}=1`);
}

/**
 * The app shell at /index.html, always with the strict policy. Served directly (ASSETS would redirect it to
 * `/`, an ad page, which can get the AdSense policy).
 */
export async function serveShell(request: Request, env: Env): Promise<Response> {
  const shell = new Request(new URL('/', request.url), { method: request.method, headers: request.headers });
  return serveHtml(shell, env, { adPage: false });
}

/** An HTML page from ASSETS, re-sent with the app's headers and the CSP variant AdSense calls for. */
export async function serveHtml(request: Request, env: Env, o: { adPage?: boolean } = {}): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const type = res.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) return res;
  const url = new URL(request.url);
  const origin = url.origin;
  const adPage = (o.adPage ?? adsenseDocument(url.pathname)) && hasAdsCookie(request);
  const [state, list] = await Promise.all([
    adPage ? adsenseState(env, origin) : Promise.resolve(OFF),
    scriptHashes(env, origin),
  ]);
  const wide = adPage && state.enabled;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(APP_HEADERS)) headers.set(k, v);
  headers.set('Content-Security-Policy', appCsp(list, { adsense: wide }));
  // The app reads this from its own navigation entry to know whether Google's script may load here.
  if (wide) headers.set('Server-Timing', ADS_DOC_TIMING);
  else headers.delete('Server-Timing');
  // Never stored: a page restored from the back/forward cache or the HTTP cache could carry another member's
  // state, or an old, wider policy.
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return env.API.fetch(request);
    if (isGuestPath(pathname)) return serveGuest(request, env);
    if (pathname === '/ads.txt') return serveAdsTxt(request, env);
    if (pathname === APP_HEADERS_FILE || isStaticFile(pathname)) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
    if (pathname === '/index.html') return serveShell(request, env);
    return serveHtml(request, env);
  },
} satisfies ExportedHandler<Env>;
