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
      photos: [...left].map((id) => ({ id, takenAt: null })),
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
    stopFaceWorker: vi.fn(),
    statusChanged: vi.fn(),
    sleep: vi.fn(async () => {}),
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
    // Face batches are never aborted mid-request (stopFaces waits for them instead).
    expect(f.postFaces).toHaveBeenCalledWith([{ id: 'x', faces: [] }], 'me');
  });

  // ---- client review fixes ------------------------------------------------------------------------------
  it('stopFaces stops the face pass, shuts the worker and waits for a face batch already sent (#1)', async () => {
    let answer: () => void = () => {};
    const sent = new Promise<{ ok: true; saved: number }>((r) => (answer = () => r({ ok: true, saved: 1 })));
    const f = makeDeps([], {
      facesPending: vi.fn(async () => ({
        ok: true as const,
        photos: [{ id: 'x' }],
        nextCursor: null,
        remaining: 1,
        total: 1,
      })),
      faces: vi.fn(async (): Promise<FaceInput[]> => []),
      postFaces: vi.fn(() => sent),
    });
    // One photo per batch would post at 10; force a flush by ending the page.
    const s = new Scanner(f);
    s.start({ signals: false, faces: true });
    await until(() => (f.postFaces as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    let settled = false;
    const stopping = s.stopFaces().then(() => {
      settled = true;
    });
    await flush();
    await flush();
    expect(f.stopFaceWorker).toHaveBeenCalled();
    expect(settled).toBe(false); // still waiting for the batch on its way
    answer();
    await stopping;
    expect(settled).toBe(true);
  });

  it('turning faces off shuts the face worker straight away (#5)', async () => {
    const f = makeDeps([]);
    const s = new Scanner(f);
    s.start({ signals: true, faces: true });
    await until(() => s.getSnapshot().phase === 'done');
    s.start({ signals: true, faces: false });
    expect(f.stopFaceWorker).toHaveBeenCalledTimes(1);
  });

  it('stops the faces pass and re-reads the status when the server says the feature is off (#5)', async () => {
    const f = makeDeps([], {
      facesPending: vi.fn(async () => {
        throw new ApiFailure('feature_off', 403);
      }),
    });
    const s = new Scanner(f);
    s.start({ signals: false, faces: true });
    await until(() => (f.statusChanged as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(f.stopFaceWorker).toHaveBeenCalled();
    expect(s.getSnapshot().phase).toBe('idle');
  });

  it('ends the faces pass on a model failure instead of trying every photo (#3)', async () => {
    const { ModelError } = await import('./faceErrors');
    const f = makeDeps([], {
      facesPending: vi.fn(async () => ({
        ok: true as const,
        photos: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
        nextCursor: null,
        remaining: 3,
        total: 3,
      })),
      faces: vi.fn(async (): Promise<FaceInput[]> => {
        throw new ModelError();
      }),
    });
    const s = new Scanner(f);
    s.start({ signals: false, faces: true });
    await until(() => s.getSnapshot().phase === 'error');
    expect(f.faces).toHaveBeenCalledTimes(1);
    expect(f.postFaces).not.toHaveBeenCalled();
    expect(f.stopFaceWorker).toHaveBeenCalled();
  });

  it('waits out 429s with the server’s Retry-After, then carries on', async () => {
    let first = true;
    const d = makeDeps(['a'], {
      postSignals: vi.fn(async (photos: PhotoSignals[]) => {
        if (first) {
          first = false;
          throw new ApiFailure('rate_limited', 429, 5);
        }
        d.posted.push(photos);
        left.clear();
        return { ok: true as const, saved: photos.length };
      }),
    });
    const left = new Set(['a']);
    d.signalsPending = vi.fn(async () => ({
      ok: true as const,
      photos: [...left].map((id) => ({ id, takenAt: null })),
      nextCursor: null,
      remaining: left.size,
    }));
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await until(() => s.getSnapshot().phase === 'done');
    expect(d.sleep).toHaveBeenCalledTimes(1);
    expect((d.sleep as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeGreaterThanOrEqual(5000);
    expect(d.posted.flat().map((p) => p.id)).toEqual(['a']);
  });

  it('forgets the previous member’s counts on stop, and a run re-targeted while paused doesn’t hang (#11)', async () => {
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
    release();
    await flush();
    // Re-target while paused: the old run must end (its abort ends the pause wait); the pause itself stays.
    s.start({ signals: true, faces: true });
    await flush();
    expect(d.measure).toHaveBeenCalledTimes(1);
    s.resume();
    await until(() => s.getSnapshot().phase === 'done');
    expect(s.getSnapshot().signals.done).toBeGreaterThan(0);
    s.stop();
    expect(s.getSnapshot().signals).toEqual({ done: 0, remaining: null });
    expect(s.getSnapshot().faces.total).toBeNull();
    expect(s.getSnapshot().phase).toBe('stopped');
  });

  it('stops when the account turns out to be scheduled for deletion', async () => {
    const d = makeDeps(['a'], {
      postSignals: vi.fn(async () => {
        throw new ApiFailure('account_pending_deletion', 403);
      }),
    });
    const s = new Scanner(d);
    s.start({ signals: true, faces: false });
    await until(() => s.getSnapshot().phase === 'stopped');
    expect(d.stopWorkers).toHaveBeenCalled();
  });
});
