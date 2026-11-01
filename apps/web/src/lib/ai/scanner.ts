import type { FaceInput, PhotoSignals } from '@zephyr/shared/client';
import { ApiFailure } from '../api';
import { originalPreviewUrl, originalThumbUrl } from '../edits';
import { onSessionEnd, sessionUserId } from '../sessionGuard';
import { facesPending, postFaces, postSignals, signalsPending } from './api';
import { FacesStoppedError, ModelError } from './faceErrors';

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
  /** Shuts the face worker down (face grouping off): frees the models and the WebAssembly heap. */
  stopFaceWorker(): void;
  /** A feature was refused (off in Admin, not on the plan): re-read the AI status. */
  statusChanged(): void;
  /** Waits, unless aborted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** Retries after 429s: at most this many in a row, each waiting the server's Retry-After (capped). */
const MAX_RATE_RETRIES = 6;
const MAX_RETRY_WAIT_S = 120;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Stopped.', 'AbortError'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  stopFaceWorker() {
    void import('./faces').then((m) => m.stopFaces());
  },
  statusChanged() {
    void import('../aiClient').then((m) => m.refreshAiStatus({ fresh: true }));
  },
  sleep: abortableSleep,
};

const IDLE: ScanProgress = {
  phase: 'idle',
  signals: { done: 0, remaining: null },
  faces: { done: 0, remaining: null, total: null },
  error: null,
};

export class Scanner {
  private ctrl: AbortController | null = null;
  private opts: ScanOptions = { signals: true, faces: false };
  private paused = false;
  private resumeWait: (() => void) | null = null;
  private subs = new Set<(p: ScanProgress) => void>();
  private snap: ScanProgress = IDLE;
  /** The face batch being posted right now (never aborted mid-request: the server may already be storing it). */
  private facesPosting: Promise<unknown> | null = null;

  constructor(private deps: ScanDeps = defaultDeps) {}

  /** Starts (or re-targets) the scan for the signed-in member. */
  start(opts: ScanOptions): void {
    const changed = opts.signals !== this.opts.signals || opts.faces !== this.opts.faces;
    const facesOff = this.opts.faces && !opts.faces;
    this.opts = { ...opts };
    if (facesOff) this.deps.stopFaceWorker();
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
    // Forget the previous member's counts too (shared devices).
    this.snap = IDLE;
    this.set({ phase: 'stopped' });
  }
  /**
   * Before face data is deleted: stop finding faces at once, shut the face worker down, and wait for a face
   * batch already on its way to the server to finish, so nothing lands after the delete. Signals carry on.
   */
  async stopFaces(): Promise<void> {
    if (this.opts.faces) this.start({ signals: this.opts.signals, faces: false });
    this.deps.stopFaceWorker();
    this.set({ faces: { done: 0, remaining: null, total: null } });
    await this.facesPosting?.catch(() => undefined);
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
    while (this.paused && !signal.aborted) {
      // Ends on resume, and on abort (re-targeted or stopped while paused), so no run is left hanging.
      await new Promise<void>((r) => {
        this.resumeWait = r;
        signal.addEventListener('abort', () => r(), { once: true });
      });
    }
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
      if (signal.aborted || (e as Error).name === 'AbortError' || e instanceof FacesStoppedError) return;
      if (
        e instanceof ApiFailure &&
        (e.code === 'unauthenticated' ||
          e.code === 'session_changed' ||
          e.code === 'account_pending_deletion')
      ) {
        this.stop();
        return;
      }
      if (e instanceof ApiFailure && (e.code === 'feature_off' || e.code === 'plan_required')) {
        // Switched off in Admin, by the member on another device, or the plan lapsed: no more face work here.
        this.opts = { ...this.opts, faces: false };
        this.deps.stopFaceWorker();
        this.deps.statusChanged();
        this.set({ phase: 'idle', error: null });
        return;
      }
      if (e instanceof ModelError) {
        // Not this photo's fault: end the faces pass and try again on a later start (with back-off).
        this.deps.stopFaceWorker();
        this.set({
          phase: 'error',
          error: 'The face models couldn’t be loaded. Zephyr will try again later.',
        });
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
    type Page = Awaited<ReturnType<typeof o.page>>;
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
      const at: string | null = cursor;
      const page: Page = await this.polite(() => o.page(at), signal);
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
        const batch = items.splice(0);
        await this.polite(() => o.post(batch), signal);
        done += n;
        report(Math.max(0, page.remaining - done), page.total);
      };
      for (const p of todo) {
        await this.gate(owner, signal);
        try {
          items.push(await o.one(p));
        } catch (e) {
          if ((e as Error).name === 'AbortError' || e instanceof ModelError || e instanceof FacesStoppedError)
            throw e;
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

  /** Runs a request, waiting out 429s (Retry-After, capped) a few times before giving up. */
  private async polite<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await call();
      } catch (e) {
        if (!(e instanceof ApiFailure && e.code === 'rate_limited') || tries >= MAX_RATE_RETRIES) throw e;
        const wait = Math.min(e.retryAfter ?? 30, MAX_RETRY_WAIT_S) * 1000;
        await this.deps.sleep(wait + Math.floor(Math.random() * 1000), signal);
      }
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
      // Not aborted once sent: stopFaces() waits for it instead, so face data can't land after a delete.
      post: (items) => {
        if (signal.aborted) return Promise.reject(new DOMException('Stopped.', 'AbortError'));
        const p = this.deps.postFaces(items, owner);
        this.facesPosting = p;
        return p.finally(() => {
          if (this.facesPosting === p) this.facesPosting = null;
        });
      },
      batch: FACE_BATCH,
    });
  }
}

/** The app's scanner. */
export const scanner = new Scanner();
onSessionEnd(() => scanner.stop());
