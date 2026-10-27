/**
 * Landing Worker. Static files are served straight from the assets binding (with headers from
 * dist/_headers). Only /api/* reaches this script: it is forwarded unchanged to the API Worker through a
 * service binding, so the API stays same-origin and has no public URL of its own.
 */
interface Env {
  API: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return env.API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
