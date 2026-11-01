import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Client review #3: a model that can't be downloaded or verified is remembered with a back-off, so the scanner
 * doesn't download the 10 MB model again for every photo.
 */
type Msg = { n: number; op: string };
let posted: Msg[] = [];
let reply: (m: Msg) => Record<string, unknown> = (m) => ({
  n: m.n,
  error: 'Couldn’t download the face model (503).',
  model: true,
});

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(m: Msg) {
    posted.push(m);
    queueMicrotask(() => this.onmessage?.({ data: reply(m) }));
  }
  terminate() {}
}

describe('face engine back-off', () => {
  beforeEach(() => {
    posted = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 10, close() {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails fast with ModelError during the back-off, then tries the model again', async () => {
    let t = 1_000_000;
    const faces = await import('./faces');
    faces._resetFacesForTest(() => t);
    const bmp = { width: 10, height: 10 } as ImageBitmap;
    await expect(faces.detectFaces(bmp)).rejects.toBeInstanceOf(faces.ModelError);
    expect(posted).toHaveLength(1);
    // Every photo in the next minute fails at once, without asking the worker (no download).
    await expect(faces.detectFaces(bmp)).rejects.toBeInstanceOf(faces.ModelError);
    await expect(faces.facesForGrouping(bmp)).rejects.toBeInstanceOf(faces.ModelError);
    expect(posted).toHaveLength(1);
    // After the back-off it tries again; a second failure doubles the wait.
    t += 61_000;
    await expect(faces.detectFaces(bmp)).rejects.toBeInstanceOf(faces.ModelError);
    expect(posted).toHaveLength(2);
    t += 61_000;
    await expect(faces.detectFaces(bmp)).rejects.toBeInstanceOf(faces.ModelError);
    expect(posted).toHaveLength(2);
    t += 60_000;
    reply = (m) => ({ n: m.n, faces: [] });
    await expect(faces.detectFaces(bmp)).resolves.toEqual([]);
    expect(posted).toHaveLength(3);
  });

  it('a photo the engine can’t read fails only that photo, and stopping rejects with FacesStoppedError', async () => {
    const faces = await import('./faces');
    faces._resetFacesForTest(() => 5);
    reply = (m) => ({ n: m.n, error: 'bad pixels' });
    const bmp = { width: 10, height: 10 } as ImageBitmap;
    const e = await faces.detectFaces(bmp).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(faces.ModelError);
    reply = () => ({ n: -1 }); // never answers
    const pending = faces.detectFaces(bmp);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    faces.stopFaces();
    await expect(pending).rejects.toBeInstanceOf(faces.FacesStoppedError);
  });
});
