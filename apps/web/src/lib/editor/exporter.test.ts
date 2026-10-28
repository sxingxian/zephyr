import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The GPU, decoding and encoding are stood in for: these tests are about streaming, limits and stopping.
const loadOriginal = vi.fn();
vi.mock('./sources', () => ({
  loadOriginal: (...a: unknown[]) => loadOriginal(...a),
  releaseSource: () => undefined,
}));
vi.mock('./background', () => ({
  withRenderer: async (fn: (gl: unknown) => unknown) =>
    fn({
      maxTexture: 8192,
      sourceSize: { width: 400, height: 300 },
      setSource: () => undefined,
      renderPixels: () => new Uint8Array(4),
    }),
}));
vi.mock('./encode', () => ({
  encodeJpeg: async () => new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }),
}));
vi.mock('../edits', () => ({ getEdit: async () => null }));

const { exportZip, renderExport } = await import('./exporter');
const { ExportProblem } = await import('./names');

const photos = (n: number, w = 6000, h = 4000) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    fileType: 'jpeg' as const,
    filename: `IMG_${i}.jpg`,
    width: w,
    height: h,
  }));

beforeEach(() => {
  loadOriginal.mockReset();
  loadOriginal.mockResolvedValue({ source: {}, baselineEv: 0, quality: 'full' });
});
afterEach(() => vi.restoreAllMocks());

describe('zip export', () => {
  it('streams to disk one photo at a time when the browser can', async () => {
    const chunks: Uint8Array[] = [];
    const sink = {
      write: vi.fn(async (c: Uint8Array) => {
        chunks.push(c);
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const out = await exportZip(photos(3), { size: { kind: 'full' }, quality: 0.9 }, sink);
    expect(out).toBeNull();
    expect(sink.close).toHaveBeenCalledTimes(1);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBeGreaterThan(3000); // three 1000-byte JPEGs plus zip headers
  });

  it('refuses an in-memory zip that would be too big, before rendering anything', async () => {
    await expect(exportZip(photos(201), { size: { kind: 'full' }, quality: 0.9 })).rejects.toBeInstanceOf(
      ExportProblem,
    );
    expect(loadOriginal).not.toHaveBeenCalled();
    // The same photos at 2048 px fit.
    const zip = await exportZip(photos(3), { size: { kind: 'long', edge: 2048 }, quality: 0.9 });
    expect(zip).toBeInstanceOf(Blob);
  });

  it('stops when the export is cancelled, and abandons the file on disk', async () => {
    const c = new AbortController();
    const sink = { write: vi.fn(async () => undefined), close: vi.fn(), abort: vi.fn(async () => undefined) };
    loadOriginal.mockImplementation(async () => {
      c.abort(); // the member's session ends while the first photo loads
      return { source: {}, baselineEv: 0, quality: 'full' };
    });
    await expect(
      exportZip(photos(3), { size: { kind: 'full' }, quality: 0.9, signal: c.signal }, sink),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.abort).toHaveBeenCalled();
    expect(sink.close).not.toHaveBeenCalled();
    expect(loadOriginal).toHaveBeenCalledTimes(1);
  });
});

describe('single export', () => {
  it('a RAW too big to develop at full size asks for a smaller export instead', async () => {
    loadOriginal.mockResolvedValue({ source: {}, baselineEv: 0, quality: 'half', limited: true });
    const raw = { id: 'r', fileType: 'nef' as const, filename: 'BIG.NEF' };
    await expect(renderExport(raw, { v: 1 }, { size: { kind: 'full' }, quality: 0.9 })).rejects.toThrow(
      /too large to develop at full size/,
    );
    await expect(
      renderExport(raw, { v: 1 }, { size: { kind: 'long', edge: 2048 }, quality: 0.9 }),
    ).resolves.toBeInstanceOf(Blob);
  });
});
