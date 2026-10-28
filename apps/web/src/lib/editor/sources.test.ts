import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decodeRaw = vi.fn();
class RawTooLargeForFull extends Error {}
vi.mock('./raw', () => ({ decodeRaw: (...a: unknown[]) => decodeRaw(...a), RawTooLargeForFull }));

const { clearRawBaselines, loadOriginal } = await import('./sources');

const fakeRaw = (half: boolean, baselineEv: number) => ({
  width: half ? 100 : 200,
  height: half ? 80 : 160,
  data: new Uint16Array(4),
  baselineEv,
});

describe('RAW baseline exposure', () => {
  beforeEach(() => {
    clearRawBaselines();
    decodeRaw.mockReset();
    // The half-size and full-size decodes measure slightly different numbers on their own.
    decodeRaw.mockImplementation(async (_buf: ArrayBuffer, half: boolean) =>
      fakeRaw(half, half ? 1.25 : 1.31),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0x4d, 0x4d, 0, 0x2a, 1, 2, 3, 4]))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const photo = { id: 'p1', fileType: 'nef' as const };

  it('export after editing reuses the editing decode’s baseline', async () => {
    const edit = await loadOriginal(photo, { full: false, maxEdge: 4096 });
    const exp = await loadOriginal(photo, { full: true, maxEdge: 4096 });
    expect(edit.baselineEv).toBe(1.25);
    expect(exp.baselineEv).toBe(1.25);
    expect(decodeRaw).toHaveBeenCalledTimes(2);
  });

  it('export with no editing session measures on a half-size pass first', async () => {
    const exp = await loadOriginal(photo, { full: true, maxEdge: 4096 });
    expect(exp.baselineEv).toBe(1.25);
    expect(decodeRaw.mock.calls.map((c) => c[1])).toEqual([true, false]);
    expect(exp.quality).toBe('full');
    // Measured once: a second export doesn't decode twice.
    await loadOriginal(photo, { full: true, maxEdge: 4096 });
    expect(decodeRaw).toHaveBeenCalledTimes(3);
  });

  it('is cleared with the session', async () => {
    await loadOriginal(photo, { full: false, maxEdge: 4096 });
    clearRawBaselines();
    await loadOriginal(photo, { full: true, maxEdge: 4096 });
    expect(decodeRaw.mock.calls.map((c) => c[1])).toEqual([true, true, false]);
  });
});

describe('RAW too big for a full-size decode', () => {
  beforeEach(() => {
    clearRawBaselines();
    decodeRaw.mockReset();
    decodeRaw.mockImplementation(async (_buf: ArrayBuffer, half: boolean) => {
      if (!half) throw new RawTooLargeForFull('memory');
      return fakeRaw(true, 1);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0x4d, 0x4d, 0, 0x2a, 1, 2, 3, 4]))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the half-size decode and says so', async () => {
    const exp = await loadOriginal({ id: 'big', fileType: 'nef' }, { full: true, maxEdge: 4096 });
    expect(exp.quality).toBe('half');
    expect(exp.limited).toBe(true);
    expect(exp.source.width).toBe(100);
  });
});
