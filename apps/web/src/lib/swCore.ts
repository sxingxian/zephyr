/**
 * The service worker's pieces (src/sw.ts), kept here so they can be tested. Nothing in it reads Cache Storage:
 * see sw.ts for why.
 */
/** Caches this worker deletes when it takes over: anything Workbox ever made (precache and runtime caches). */
export const OLD_CACHE = /^workbox-/;

export const OFFLINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zephyr · Offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #F4F6F9; color: #1B2230;
         font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 22rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; color: #5A6478; }
  a { display: inline-block; padding: .6rem 1.1rem; border-radius: 999px; background: #1B2230; color: #fff;
      text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>You’re offline</h1>
<p>Zephyr needs a connection to open your library. Check your connection, then try again.</p>
<a href="/">Try again</a>
</main>
</body>
</html>
`;

/** The offline page: built in this file, never read from a cache, and with a policy that allows no script. */
export function offlineResponse(): Response {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': OFFLINE_CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** Page loads this worker answers: the app's own pages, never /api or the guest gallery (/g). */
export function handlesNavigation(request: Request, origin: string): boolean {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === origin && !/^\/(api|g)(\/|$)/.test(url.pathname);
}
