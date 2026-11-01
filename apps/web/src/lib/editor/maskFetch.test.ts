import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMasks, defaultMaskDeps, getMask, loadMask, setMaskDeps } from './cutout';

const PHOTO = '11111111-1111-4111-8111-111111111111';
const MASK = '22222222-2222-4222-8222-222222222222';

describe('mask fetch (client review #4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setMaskDeps(null);
    clearMasks();
  });

  it('always revalidates with the server (no-cache + ETag), never trusting a cached copy blindly', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1])]),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await defaultMaskDeps.fetchMask(PHOTO, MASK);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/masks/${MASK}`);
    expect(init.cache).toBe('no-cache');
    expect(init.credentials).toBe('same-origin');
  });

  it('forgets every decoded mask when the session ends, and drops one still loading', async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((r) => (finish = r));
    setMaskDeps({
      fetchMask: async () => {
        await gate;
        return new Blob([new Uint8Array([1])]);
      },
      decode: async () => ({ width: 2, height: 2, data: new Uint8Array([0, 255, 255, 0]) }),
    });
    const loading = loadMask(PHOTO, MASK);
    clearMasks(); // session end while loading
    finish();
    await expect(loading).rejects.toThrow(/session ended/);
    expect(getMask(MASK)).toBeFalsy();
  });
});
