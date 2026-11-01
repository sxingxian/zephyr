import { describe, expect, it, vi } from 'vitest';
import { GUEST_CSP, GUEST_HEADERS } from './guestHeaders.js';
import worker, { isGuestPath, serveGuest } from './index';

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
