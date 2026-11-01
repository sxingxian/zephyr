import type { FaceInput, PhotoSignals } from '@zephyr/shared/client';
import { ApiFailure } from '../api';
import { originalPreviewUrl, originalThumbUrl } from '../edits';
import { onSessionEnd, sessionUserId } from '../sessionGuard';
import { facesPending, postFaces, postSignals, signalsPending } from './api';

/**
 * The background scanner (phase 6). While the app is open and idle it measures, one photo at a time:
 *
 * 1. quality signals (cleanup, Night) for photos whose signals are missing or out of date, from their
 *    untouched 512 px thumbnails, posted in batches;
 * 2. with face grouping on, faces and face codes from the untouched 2048 px previews, posted in batches.
 *
 * It pauses while the tab is hidden, and stops for good when the member's session ends (shared devices):
 * nothing is posted under the next member, and the face worker is shut down.
 */
export type ScanPhase = 'idle' | 'signals' | 'faces' | 'paused' | 'done' | 'stopped' | 'error';
export interface ScanProgress {
  phase: ScanPhase;
  signals: { done: number; remaining: number | null };
  faces: { done: number; remaining: number | null; total: number | null };
  error: string | null;
}
export interface ScanOptions {
  signals: boolean;
  faces: boolean;
}
export interface ScanDeps {
  owner(): string | null;
  signalsPending: typeof signalsPending;
  postSignals: typeof postSignals;
  facesPending: typeof facesPending;
  postFaces: typeof postFaces;
  /** Signals for one photo from its untouched thumbnail. */
  measure(id: string, takenAt: string | null, signal: AbortSignal): Promise<PhotoSignals>;
  /** Faces and face codes for one photo from its untouched preview. */
  faces(id: string, signal: AbortSignal): Promise<FaceInput[]>;
  /** Resolves when the browser is idle and the tab is visible. */
  idle(signal: AbortSignal): Promise<void>;
  /** Shuts the workers down (stop). */
  stopWorkers(): void;
}

const SIGNAL_BATCH = 25;
const FACE_BATCH = 10;

async function blobOf(url: string, signal: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { credentials: 'same-origin', signal });
  if (!res.ok) throw new ApiFailure(res.status === 404 ? 'not_found' : 'server', res.status);
  return res.blob();
}

const defaultDeps: ScanDeps = {
  owner: sessionUserId,
  signalsPending,
  postSignals,
  facesPending,
  postFaces,
  async measure(id, takenAt, signal) {
    const { measureSignals } = await import('./signals');
    return measureSignals(id, await blobOf(originalThumbUrl(id), signal), takenAt);
  },
  async faces(id, signal) {
    const { facesForGrouping } = await import('./faces');
    const bmp = await createImageBitmap(await blobOf(originalPreviewUrl(id), signal), {
      imageOrientation: 'from-image',
    });
    try {
      return await facesForGrouping(bmp);
    } finally {
      bmp.close();
    }
  },
  idle(signal) {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        document.removeEventListener('visibilitychange', onVis);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        done();
        reject(new DOMException('Stopped.', 'AbortError'));
      };
      const go = () => {
        const ready = () => {
          done();
          resolve();
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(ready, { timeout: 2000 });
        else setTimeout(ready, 50);
      };
      const onVis = () => {
        if (document.visibilityState === 'visible') go();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (document.visibilityState === 'hidden') document.addEventListener('visibilitychange', onVis);
      else go();
    });
  },
  stopWorkers() {
    void import('./faces').then((m) => m.stopFaces());
    void import('./signals').then((m) => m.stopSignalsWorker());
  },
};

export class Scanner {
  private ctrl: AbortController | null = null;
  private opts: ScanOptions = { signals: true, faces: false };
  private paused = false;
  private resumeWait: (() => void) | null = null;
  private subs = new Set<(p: ScanProgress) => void>();
  private snap: ScanProgress = {
    phase: 'idle',
    signals: { done: 0, remaining: null },
    faces: { done: 0, remaining: null, total: null },
    error: null,
  };

  constructor(private deps: ScanDeps = defaultDeps) {}

  /** Starts (or re-targets) the scan for the signed-in member. */
  start(opts: ScanOptions): void {
    const changed = opts.signals !== this.opts.signals || opts.faces !== this.opts.faces;
    this.opts = { ...opts };
    if (this.ctrl && !changed) return;
    this.ctrl?.abort();
    const owner = this.deps.owner();
    if (!owner || (!opts.signals && !opts.faces)) {
      this.ctrl = null;
      this.set({ phase: 'idle' });
      return;
    }
    const c = new AbortController();
    this.ctrl = c;
    void this.run(owner, c.signal);
  }
  /** Stops and forgets the scan (session end, or the member turned the features off). */
  stop(): void {
    this.ctrl?.abort();
    this.ctrl = null;
    this.paused = false;
    this.resumeWait?.();
    this.deps.stopWorkers();
    this.set({ phase: 'stopped' });
  }
  pause(): void {
    if (!this.ctrl || this.paused) return;
    this.paused = true;
    this.set({ phase: 'paused' });
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resumeWait?.();
  }
  subscribe = (fn: (p: ScanProgress) => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  private set(p: Partial<ScanProgress>) {
    this.snap = { ...this.snap, ...p };
    for (const s of this.subs) s(this.snap);
  }

  private async gate(owner: string, signal: AbortSignal) {
    while (this.paused && !signal.aborted) await new Promise<void>((r) => (this.resumeWait = r));
    if (signal.aborted) throw new DOMException('Stopped.', 'AbortError');
    await this.deps.idle(signal);
    if (this.deps.owner() !== owner) throw new DOMException('Signed in as someone else.', 'AbortError');
  }

  private async run(owner: string, signal: AbortSignal) {
    try {
      if (this.opts.signals) await this.signalsPass(owner, signal);
      if (this.opts.faces) await this.facesPass(owner, signal);
      if (!signal.aborted) this.set({ phase: 'done' });
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError') return;
      if (e instanceof ApiFailure && (e.code === 'unauthenticated' || e.code === 'session_changed')) {
        this.stop();
        return;
      }
      this.set({ phase: 'error', error: (e as Error).message });
    } finally {
      if (this.ctrl?.signal === signal) this.ctrl = null;
    }
  }

  /**
   * Pages through the pending list: processes each photo, posts in batches, and starts again from the top
   * (posted photos drop off the list). Photos that fail are skipped for this session; when a whole page
   * failed, it moves on to the next page.
   */
  private async pass<T>(
    owner: string,
    signal: AbortSignal,
    o: {
      phase: 'signals' | 'faces';
      page: (cursor: string | null) => Promise<{
        photos: { id: string }[];
        nextCursor: string | null;
        remaining: number;
        total?: number;
      }>;
      one: (p: { id: string }) => Promise<T>;
      post: (items: T[]) => Promise<unknown>;
      batch: number;
    },
  ) {
    const failed = new Set<string>();
    let done = 0;
    let cursor: string | null = null;
    const report = (remaining: number, total?: number) =>
      this.set(
        o.phase === 'signals'
          ? { signals: { done, remaining } }
          : { faces: { done, remaining, total: total ?? this.snap.faces.total } },
      );
    for (;;) {
      this.set({ phase: o.phase });
      const page = await o.page(cursor);
      report(page.remaining, page.total);
      const todo = page.photos.filter((p) => !failed.has(p.id));
      if (!todo.length) {
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
        continue;
      }
      const items: T[] = [];
      const flush = async () => {
        if (!items.length) return;
        const n = items.length;
        await o.post(items.splice(0));
        done += n;
        report(Math.max(0, page.remaining - done), page.total);
      };
      for (const p of todo) {
        await this.gate(owner, signal);
        try {
          items.push(await o.one(p));
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          failed.add(p.id); // undecodable, or gone: skipped for this session
        }
        if (items.length >= o.batch) await flush();
      }
      await flush();
      const allFailed = todo.every((p) => failed.has(p.id));
      if (allFailed && !page.nextCursor) return;
      cursor = allFailed ? page.nextCursor : null;
    }
  }

  private signalsPass(owner: string, signal: AbortSignal) {
    return this.pass<PhotoSignals>(owner, signal, {
      phase: 'signals',
      page: (cursor) => this.deps.signalsPending(cursor, signal),
      one: (p) => this.deps.measure(p.id, (p as { takenAt?: string | null }).takenAt ?? null, signal),
      post: (items) => this.deps.postSignals(items, owner, signal),
      batch: SIGNAL_BATCH,
    });
  }

  private facesPass(owner: string, signal: AbortSignal) {
    return this.pass<{ id: string; faces: FaceInput[] }>(owner, signal, {
      phase: 'faces',
      page: (cursor) => this.deps.facesPending(cursor, signal),
      one: async (p) => ({ id: p.id, faces: await this.deps.faces(p.id, signal) }),
      post: (items) => this.deps.postFaces(items, owner, signal),
      batch: FACE_BATCH,
    });
  }
}

/** The app's scanner. */
export const scanner = new Scanner();
onSessionEnd(() => scanner.stop());
