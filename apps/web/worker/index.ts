/**
 * App Worker for zephyrapp.midnightpoetry.studio. Static files (the PWA) are served straight from the
 * assets binding with headers from dist/_headers; unknown paths fall back to index.html for the SPA.
 * This script runs only for:
 *   /api/*  → passed unchanged to the API Worker through a service binding, so the API stays same-origin
 *             and its session cookies stay host-only;
 *   /g/*    → the guest gallery page (guest.html), a separate light app with its own stricter headers.
 */
import { GUEST_HEADERS } from './guestHeaders.js';

interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export function isGuestPath(pathname: string): boolean {
  return pathname === '/g' || pathname.startsWith('/g/');
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return env.API.fetch(request);
    if (isGuestPath(pathname)) return serveGuest(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
