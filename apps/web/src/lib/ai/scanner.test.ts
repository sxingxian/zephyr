import type { FaceInput, PhotoSignals } from '@zephyr/shared/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../api';
import { type ScanDeps, Scanner } from './scanner';

const sig = (id: string): PhotoSignals => ({
  id,
  phash: '0123456789abcdef',
  sharpness: 100,
  brightness: 0.5,
  night: false,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await flush();
}

function makeDeps(pending: string[], over: Partial<ScanDeps> = {}) {
  const left = new Set(pending);
  let who: string | null = 'me';
  const d: ScanDeps & { posted: PhotoSignals[][]; setOwner(o: string | null): void } = {
    posted: [],
    setOwner: (o) => {
      who = o;
    },
    owner: () => who,
    signalsPending: vi.fn(async () => ({
      ok: true as const,
      photos: [...left].map((id) => ({ id })),
      nextCursor: null,
      remaining: left.size,
    })),
    postSignals: vi.fn(async (photos: PhotoSignals[]) => {
      for (const p of photos) left.delete(p.id);
      d.posted.push(photos);
      return { ok: true as const, saved: photos.length };
    }),
    facesPending: vi.fn(async () => ({
      ok: true as const,
      photos: [],
      nextCursor: null,
      remaining: 0,
      total: 0,
    })),
    postFaces: vi.fn(async () => ({ ok: true as const, saved: 0 })),
    measure: vi.fn(async (id: string) => sig(id)),
    faces: vi.fn(async (): Promise<FaceInput[]> => []),
    idle: async () => {},
    stopWorkers: vi.fn(),
    ...over,
  };
  return d;
}

describe('background scanner', () => {
  it('measures pending photos, posts them in batches for the member, and finishes', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const d = makeDeps(ids);
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await until(() => s.getSnapshot().phase === 'done');
    expect(d.posted.map((b) => b.length)).toEqual([25, 5]);
    expect(d.postSignals).toHaveBeenCalledWith(expect.any(Array), 'me', expect.anything());
    expect(s.getSnapshot().signals.done).toBe(30);
  });

  it('skips photos it can’t measure and still ends', async () => {
    const d = makeDeps(['a', 'b'], {
      measure: vi.fn(async (id: string) => {
        if (id === 'a') throw new Error('decode');
        return sig(id);
      }),
    });
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await until(() => s.getSnapshot().phase === 'done');
    expect(d.posted.flat().map((p) => p.id)).toEqual(['b']);
  });

  it('never posts after someone else signs in, and stops when the session ends', async () => {
    const d = makeDeps(['a', 'b', 'c']);
    d.idle = async () => {
      d.setOwner('someone-else');
    };
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await until(() => s.getSnapshot().phase !== 'signals' && s.getSnapshot().phase !== 'idle');
    await flush();
    expect(d.postSignals).not.toHaveBeenCalled();
    const d2 = makeDeps(['a'], {
      postSignals: vi.fn(async () => {
        throw new ApiFailure('session_changed', 409);
      }),
    });
    const s2 = new Scanner(d2);
    s2.start({ signals: true, faces: false });
    await until(() => s2.getSnapshot().phase === 'stopped');
    expect(d2.stopWorkers).toHaveBeenCalled();
  });

  it('pauses and resumes, and scans faces only when face grouping is on', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const d = makeDeps(['a', 'b'], {
      measure: vi.fn(async (id: string) => {
        if (id === 'a') await gate;
        return sig(id);
      }),
    });
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await flush();
    s.pause();
    expect(s.getSnapshot().phase).toBe('paused');
    release();
    await flush();
    await flush();
    expect(d.measure).toHaveBeenCalledTimes(1); // waiting at the gate
    s.resume();
    await until(() => s.getSnapshot().phase === 'done');
    expect(d.facesPending).not.toHaveBeenCalled();

    const f = makeDeps([], {
      facesPending: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, photos: [{ id: 'x' }], nextCursor: null, remaining: 1, total: 1 })
        .mockResolvedValue({ ok: true, photos: [], nextCursor: null, remaining: 0, total: 1 }),
    });
    const s3 = new Scanner(f);
    s3.start({ signals: false, faces: true });
    await until(() => s3.getSnapshot().phase === 'done');
    expect(f.postFaces).toHaveBeenCalledWith([{ id: 'x', faces: [] }], 'me', expect.anything());
  });
});
