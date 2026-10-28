/**
 * Landing Worker for zephyr.midnightpoetry.studio.
 * - Static files are served straight from the assets binding with headers from dist/_headers.
 * - /api/* and /admin/api/* go unchanged to the API Worker through a service binding, so the API stays
 *   same-origin and has no public URL of its own.
 * - /admin (the console, built from apps/admin into dist/admin) runs through this script so every
 *   response gets the console's own strict headers and unknown console paths fall back to its index.
 *   Cloudflare Access protects /admin* at the edge before any of this runs.
 */
interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

/** The console has no inline scripts and loads nothing from other origins (checked at build time). */
export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

export function adminHeaders(res: Response, pathname: string): Response {
  const h = new Headers(res.headers);
  h.set('Content-Security-Policy', ADMIN_CSP);
  h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Robots-Tag', 'noindex, nofollow');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  );
  // Hashed bundles can be cached; everything else (the console page itself) must never be stored.
  h.set(
    'Cache-Control',
    pathname.startsWith('/admin/assets/') && res.ok ? 'public, max-age=31536000, immutable' : 'no-store',
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const isApi = (p: string) =>
  p === '/api' || p.startsWith('/api/') || p === '/admin/api' || p.startsWith('/admin/api/');
const isAdmin = (p: string) => p === '/admin' || p.startsWith('/admin/');

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (isApi(path)) return env.API.fetch(request);
    if (isAdmin(path)) {
      let res = await env.ASSETS.fetch(request);
      // Console routes like /admin/signups are client-side: serve the console page for them.
      const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(path);
      if (res.status === 404 && (request.method === 'GET' || request.method === 'HEAD') && !looksLikeFile) {
        res = await env.ASSETS.fetch(
          new Request(new URL('/admin', url), { method: request.method, headers: request.headers }),
        );
      }
      return adminHeaders(res, path);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
