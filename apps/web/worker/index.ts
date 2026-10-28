/**
 * App Worker for zephyrapp.midnightpoetry.studio. Static files (the PWA) are served straight from the
 * assets binding with headers from dist/_headers; unknown paths fall back to index.html for the SPA.
 * Only /api/* runs this script: it goes unchanged to the API Worker through a service binding, so the API
 * stays same-origin and its session cookies stay host-only.
 */
interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
