import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADSENSE_SOURCES, APP_HEADERS, APP_HEADERS_FILE, appCsp } from './appHeaders.js';
import { GUEST_CSP, GUEST_HEADERS } from './guestHeaders.js';
import worker, {
  __resetForTest,
  ADS_CONFIG_PATH,
  adsenseState,
  isGuestPath,
  isStaticFile,
  serveGuest,
} from './index';

// A made-up 43-character link token, built at runtime so secret scanners don't mistake it for a key.
const TOKEN = `${'Tk'.repeat(20)}a-_`;
function env() {
  const assets = vi.fn(
    async (r: Request) =>
      new Response(`asset ${new URL(r.url).pathname}`, { headers: { 'X-From': 'assets' } }),
  );
  const api = vi.fn(async () => new Response('api'));
  return {
    ASSETS: { fetch: assets } as unknown as Fetcher,
    API: { fetch: api } as unknown as Fetcher,
    assets,
    api,
  };
}

describe('app Worker', () => {
  it('serves the guest page for /g/* with the guest headers, never forwarding the token', async () => {
    const e = env();
    const res = await worker.fetch(new Request(`https://zephyrapp.midnightpoetry.studio/g/${TOKEN}`), e);
    expect(await res.text()).toBe('asset /guest');
    const asked = e.assets.mock.calls[0]?.[0] as Request;
    expect(asked.url).toBe('https://zephyrapp.midnightpoetry.studio/guest');
    expect(asked.headers.get('cookie')).toBeNull();
    for (const [k, v] of Object.entries(GUEST_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get('X-From')).toBeNull();
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
  it('the owner preview uses the same page', async () => {
    const e = env();
    const res = await serveGuest(new Request('https://x/g/preview/7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'), e);
    expect(res.status).toBe(200);
  });
  it('refuses anything but GET and HEAD on /g/*', async () => {
    const e = env();
    const res = await worker.fetch(new Request(`https://x/g/${TOKEN}`, { method: 'POST', body: 'x' }), e);
    expect(res.status).toBe(405);
    expect(e.assets).not.toHaveBeenCalled();
    const head = await serveGuest(new Request(`https://x/g/${TOKEN}`, { method: 'HEAD' }), e);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
  it('passes /api/* to the API and leaves everything else to the assets', async () => {
    const e = env();
    await worker.fetch(new Request('https://x/api/v1/g/abc'), e);
    expect(e.api).toHaveBeenCalledTimes(1);
    await worker.fetch(new Request('https://x/library'), e);
    expect(e.assets).toHaveBeenCalledTimes(1);
    expect(isGuestPath('/gallery')).toBe(false);
    expect(isGuestPath('/g')).toBe(true);
  });
});

describe('guest Content-Security-Policy', () => {
  const directives = Object.fromEntries(
    GUEST_CSP.split(';').map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k as string, v];
    }),
  );
  it('allows Turnstile for its script and frame only, and nothing else from elsewhere', () => {
    expect(directives['script-src']).toEqual(["'self'", 'https://challenges.cloudflare.com']);
    expect(directives['frame-src']).toEqual(['https://challenges.cloudflare.com']);
    for (const [k, v] of Object.entries(directives)) {
      if (k === 'script-src' || k === 'frame-src') continue;
      expect(v.some((s) => s.startsWith('http'))).toBe(false);
    }
  });
  it('no eval, no WebAssembly, no workers, no inline script', () => {
    expect(GUEST_CSP).not.toMatch(/unsafe-eval|wasm-unsafe-eval|'sha256-/);
    expect(directives['script-src']).not.toContain("'unsafe-inline'");
    expect(directives['worker-src']).toEqual(["'none'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });
});

// ---------------------------------------------------------------- phase 8: HTML headers, AdSense, ads.txt
const PUB = 'ca-pub-1234567890123456';
const HASH = "'sha256-abcDEF123+/=='";
function htmlEnv(adsense: { enabled: boolean; publisherId: string | null } | 'error') {
  const assets = vi.fn(async (r: Request) => {
    const { pathname } = new URL(r.url);
    if (pathname === APP_HEADERS_FILE)
      return new Response(JSON.stringify({ hashes: [HASH, "'self' https://evil.example"] }), {
        headers: { 'content-type': 'application/json' },
      });
    if (pathname.startsWith('/assets/'))
      return new Response('js', { headers: { 'content-type': 'text/javascript', 'X-From': 'assets' } });
    return new Response('<!doctype html><title>Zephyr</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'X-From': 'assets' },
    });
  });
  const api = vi.fn(async (r: Request) => {
    if (adsense === 'error') throw new Error('down');
    expect(new URL(r.url).pathname).toBe(ADS_CONFIG_PATH);
    expect(r.headers.get('cookie')).toBeNull();
    return new Response(JSON.stringify(adsense), { headers: { 'content-type': 'application/json' } });
  });
  return {
    ASSETS: { fetch: assets } as unknown as Fetcher,
    API: { fetch: api } as unknown as Fetcher,
    assets,
    api,
  };
}
const directivesOf = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k as string, v];
    }),
  );

describe('app Worker · HTML pages and AdSense', () => {
  beforeEach(() => __resetForTest());

  it('serves pages with the strict default policy and every security header while AdSense is off', async () => {
    const e = htmlEnv({ enabled: false, publisherId: null });
    const res = await worker.fetch(new Request('https://x/albums/123', { headers: { cookie: 'sid=1' } }), e);
    expect(await res.text()).toContain('<title>Zephyr</title>');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toBe(appCsp([HASH]));
    expect(csp).not.toMatch(/google|doubleclick|evil/);
    for (const [k, v] of Object.entries(APP_HEADERS)) expect(res.headers.get(k)).toBe(v);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('adds Google’s hosts to exactly four directives while AdSense is on', async () => {
    const e = htmlEnv({ enabled: true, publisherId: PUB });
    const res = await worker.fetch(new Request('https://x/'), e);
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toBe(appCsp([HASH], { adsense: true }));
    const wide = directivesOf(csp);
    const strict = directivesOf(appCsp([HASH]));
    for (const [d, v] of Object.entries(strict)) {
      const added = ADSENSE_SOURCES[d as keyof typeof ADSENSE_SOURCES] ?? [];
      expect(wide[d]).toEqual(
        d === 'script-src'
          ? ["'self'", "'wasm-unsafe-eval'", 'https://challenges.cloudflare.com', ...added, HASH]
          : [...(v as string[]), ...added],
      );
    }
    expect(wide['script-src']).toContain('https://pagead2.googlesyndication.com');
    expect(wide['script-src']).toContain('https://fundingchoicesmessages.google.com');
    expect(wide['script-src']).not.toContain("'unsafe-inline'");
    expect(wide['script-src']).not.toContain("'unsafe-eval'");
    expect(wide['object-src']).toEqual(["'none'"]);
    expect(wide['frame-ancestors']).toEqual(["'none'"]);
  });

  it('caches the config for 60 seconds and falls back to the strict policy when the API fails', async () => {
    const on = htmlEnv({ enabled: true, publisherId: PUB });
    const t0 = 1_000_000;
    expect((await adsenseState(on, 'https://x', t0)).enabled).toBe(true);
    expect((await adsenseState(on, 'https://x', t0 + 59_000)).enabled).toBe(true);
    expect(on.api).toHaveBeenCalledTimes(1);
    __resetForTest();
    const down = htmlEnv('error');
    const res = await worker.fetch(new Request('https://x/'), down);
    expect(res.headers.get('Content-Security-Policy')).toBe(appCsp([HASH]));
    __resetForTest();
    const bad = htmlEnv({ enabled: true, publisherId: 'pub-123; script-src *' });
    expect((await adsenseState(bad, 'https://x')).enabled).toBe(false);
  });

  it('passes static files straight to ASSETS, untouched', async () => {
    const e = htmlEnv({ enabled: true, publisherId: PUB });
    const res = await worker.fetch(new Request('https://x/assets/index-abc.js'), e);
    expect(res.headers.get('X-From')).toBe('assets');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(e.api).not.toHaveBeenCalled();
    expect(isStaticFile('/sw.js')).toBe(true);
    expect(isStaticFile('/index.html')).toBe(false);
    expect(isStaticFile('/albums/abc')).toBe(false);
  });

  it('keeps the guest page’s own headers for /guest', async () => {
    const e = htmlEnv({ enabled: true, publisherId: PUB });
    const res = await worker.fetch(new Request('https://x/guest.html'), e);
    expect(res.headers.get('Content-Security-Policy')).toBe(GUEST_CSP);
  });

  it('serves /ads.txt from the publisher id, and 404s while AdSense is off', async () => {
    const on = htmlEnv({ enabled: true, publisherId: PUB });
    const res = await worker.fetch(new Request('https://x/ads.txt'), on);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    __resetForTest();
    const off = htmlEnv({ enabled: false, publisherId: null });
    const missing = await worker.fetch(new Request('https://x/ads.txt'), off);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
  });
});
