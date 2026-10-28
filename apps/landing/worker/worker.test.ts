import { describe, expect, it, vi } from 'vitest';
import worker, { ADMIN_CSP } from './index';

function env(assets: (req: Request) => Response) {
  return {
    API: { fetch: vi.fn(async (_r: Request) => new Response('api')) },
    ASSETS: { fetch: vi.fn(async (r: Request) => assets(r)) },
  };
}
const call = (url: string, e: ReturnType<typeof env>) => worker.fetch(new Request(url), e as never);

describe('landing worker', () => {
  it('forwards /api and /admin/api to the API unchanged', async () => {
    const e = env(() => new Response('asset'));
    for (const p of ['/api/v1/public/config', '/admin/api/v1/signups']) {
      const res = await call(`https://zephyr.midnightpoetry.studio${p}`, e);
      expect(await res.text()).toBe('api');
    }
    expect(e.API.fetch).toHaveBeenCalledTimes(2);
    const forwarded = e.API.fetch.mock.calls[1];
    expect(forwarded && new URL((forwarded[0] as Request).url).pathname).toBe('/admin/api/v1/signups');
  });
  it('serves console routes from the console page with strict, uncached headers', async () => {
    const e = env((r) =>
      new URL(r.url).pathname === '/admin'
        ? new Response('<html>console</html>', { status: 200 })
        : new Response('nf', { status: 404 }),
    );
    const res = await call('https://zephyr.midnightpoetry.studio/admin/signups', e);
    expect(await res.text()).toContain('console');
    expect(res.headers.get('content-security-policy')).toBe(ADMIN_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(ADMIN_CSP).not.toContain('challenges.cloudflare.com');
  });
  it('keeps real 404s for missing console files and caches hashed bundles', async () => {
    const e = env((r) =>
      r.url.endsWith('.js') && r.url.includes('index-abc')
        ? new Response('js')
        : new Response('nf', { status: 404 }),
    );
    expect((await call('https://zephyr.midnightpoetry.studio/admin/assets/missing.js', e)).status).toBe(404);
    const ok = await call('https://zephyr.midnightpoetry.studio/admin/assets/index-abc.js', e);
    expect(ok.headers.get('cache-control')).toContain('immutable');
  });
  it('leaves the public site to static assets', async () => {
    const e = env(() => new Response('home'));
    const res = await call('https://zephyr.midnightpoetry.studio/', e);
    expect(await res.text()).toBe('home');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});
