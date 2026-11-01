import type { PhotoItem } from '@zephyr/shared/client';
import { ApiFailure, errorMessage } from './api';
import { ExportProblem } from './editor/names';
import { getPhoto } from './library';
import { onSessionEnd, sessionUserId } from './sessionGuard';
import { getRenderQueue, putFullRender } from './share';

/**
 * Full-size downloads of edited or RAW photos in a gallery are rendered on this device (the phase 4 exporter)
 * and uploaded for the edit version they were made from. One photo at a time: a full-size render is heavy.
 *
 * Every item belongs to the member who queued it. The queue stops and empties when that member's session ends
 * (sign-out, a 401, someone else signing in), and work for anyone else is never sent.
 */
export type ShareRenderState = 'pending' | 'processing' | 'completed' | 'failed';
export interface ShareRenderItem {
  key: string;
  galleryId: string;
  galleryName: string;
  photoId: string;
  editVersion: number;
  state: ShareRenderState;
  message?: string;
}
export interface ShareRenderSnapshot {
  items: ShareRenderItem[];
  total: number;
  done: number;
  failed: number;
  busy: boolean;
  /** The member's storage filled up: the rest waits until there's room. */
  storageFull: boolean;
}

export interface ShareRenderDeps {
  owner(): string | null;
  pending(galleryId: string, signal?: AbortSignal): Promise<{ photoId: string; editVersion: number }[]>;
  photo(photoId: string, signal?: AbortSignal): Promise<Pick<PhotoItem, 'id' | 'fileType' | 'filename'>>;
  render(photo: Pick<PhotoItem, 'id' | 'fileType' | 'filename'>, signal: AbortSignal): Promise<Blob>;
  put(
    galleryId: string,
    photoId: string,
    editVersion: number,
    jpeg: Blob,
    owner: string,
    signal: AbortSignal,
  ): Promise<void>;
}

interface Rec extends ShareRenderItem {
  owner: string;
}

const EMPTY: ShareRenderSnapshot = {
  items: [],
  total: 0,
  done: 0,
  failed: 0,
  busy: false,
  storageFull: false,
};

export class ShareRenderQueue {
  private recs = new Map<string, Rec>();
  private subs = new Set<() => void>();
  private snap: ShareRenderSnapshot = EMPTY;
  private running = false;
  private epoch = 0;
  private ctrl: AbortController | null = null;
  private full = false;
  /** Full-size renders aren't accepted any more (plan changed, or sharing paused): stop until reset. */
  private stopped = false;

  constructor(private deps: ShareRenderDeps) {}

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  private emit() {
    const items = [...this.recs.values()].map(({ owner: _o, ...it }) => it);
    this.snap = {
      items,
      total: items.length,
      done: items.filter((i) => i.state === 'completed').length,
      failed: items.filter((i) => i.state === 'failed').length,
      busy: items.some((i) => i.state === 'pending' || i.state === 'processing'),
      storageFull: this.full,
    };
    for (const s of this.subs) s();
  }

  /** Queues photos for one gallery. A newer edit version replaces a queued older one. */
  add(
    galleryId: string,
    galleryName: string,
    items: { photoId: string; editVersion: number }[],
    /** The member the gallery belongs to; nothing is queued if someone else is signed in now. */
    forOwner?: string,
  ): void {
    const owner = this.deps.owner();
    if (!owner || (forOwner !== undefined && forOwner !== owner)) return;
    let added = false;
    for (const it of items) {
      const key = `${galleryId}:${it.photoId}`;
      const have = this.recs.get(key);
      if (have && have.editVersion > it.editVersion) continue;
      if (have && have.editVersion === it.editVersion && have.state !== 'failed') continue;
      this.recs.set(key, {
        key,
        galleryId,
        galleryName,
        photoId: it.photoId,
        editVersion: it.editVersion,
        state: 'pending',
        owner,
      });
      added = true;
    }
    if (added) {
      this.emit();
      void this.pump();
    }
  }

  /** Picks up renders left unfinished (a tab closed while preparing), for galleries with full-size downloads. */
  async resume(galleries: { id: string; name: string; downloads: string; status: string }[]): Promise<void> {
    const owner = this.deps.owner();
    if (!owner) return;
    const epoch = this.epoch;
    for (const g of galleries) {
      if (g.downloads !== 'full' || g.status !== 'live') continue;
      try {
        const pending = await this.deps.pending(g.id);
        if (epoch !== this.epoch || this.deps.owner() !== owner) return;
        if (pending.length) this.add(g.id, g.name, pending, owner);
      } catch {
        // The next visit tries again.
      }
    }
  }

  retryFailed(): void {
    for (const r of this.recs.values())
      if (r.state === 'failed') {
        r.state = 'pending';
        r.message = undefined;
      }
    this.full = false;
    this.stopped = false;
    this.emit();
    void this.pump();
  }

  /** Drops finished rows from the tray. */
  dismiss(): void {
    for (const [k, r] of this.recs) if (r.state === 'completed' || r.state === 'failed') this.recs.delete(k);
    this.full = false;
    this.stopped = false;
    this.emit();
  }

  /** Stops the render in progress and forgets everything (session end). */
  reset(): void {
    this.epoch++;
    this.ctrl?.abort();
    this.ctrl = null;
    this.running = false;
    this.recs.clear();
    this.full = false;
    this.stopped = false;
    this.snap = EMPTY;
    for (const s of this.subs) s();
  }

  private next(): Rec | undefined {
    for (const r of this.recs.values()) if (r.state === 'pending') return r;
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    try {
      for (let r = this.next(); r && !this.full && !this.stopped; r = this.next()) {
        if (epoch !== this.epoch) return;
        // Never send work for a member who isn't the one signed in any more.
        if (this.deps.owner() !== r.owner) {
          this.recs.delete(r.key);
          this.emit();
          continue;
        }
        await this.one(r, epoch);
      }
    } finally {
      // After a reset a newer pump may already be running; only the current one clears the flag.
      if (epoch === this.epoch) this.running = false;
    }
  }

  private async one(r: Rec, epoch: number): Promise<void> {
    const c = new AbortController();
    this.ctrl = c;
    r.state = 'processing';
    this.emit();
    try {
      const photo = await this.deps.photo(r.photoId, c.signal);
      const jpeg = await this.deps.render(photo, c.signal);
      if (epoch !== this.epoch || c.signal.aborted || this.deps.owner() !== r.owner) return;
      await this.deps.put(r.galleryId, r.photoId, r.editVersion, jpeg, r.owner, c.signal);
      if (epoch !== this.epoch) return;
      r.state = 'completed';
    } catch (e) {
      if (epoch !== this.epoch || (e as Error).name === 'AbortError') return;
      if (e instanceof ApiFailure && (e.status === 410 || e.status === 404)) {
        // The photo changed or left the gallery since: nothing to do (a newer version is queued separately).
        r.state = 'completed';
        r.message = 'Changed since; skipped';
      } else if (e instanceof ApiFailure && e.code === 'storage_full') {
        r.state = 'failed';
        r.message = 'Your storage is full';
        this.full = true;
      } else if (e instanceof ApiFailure && e.code === 'too_large') {
        // Bigger than the server accepts for a full-size copy: guests still get the web size.
        r.state = 'failed';
        r.message = 'Too large to prepare at full size; guests can still download the web size';
      } else if (e instanceof ApiFailure && e.status === 415) {
        r.state = 'failed';
        r.message = 'This photo couldn’t be prepared as a JPEG';
      } else if (e instanceof ApiFailure && (e.code === 'plan_required' || e.code === 'sharing_suspended')) {
        // Full-size downloads aren't available any more (plan changed, or sharing paused): stop asking.
        r.state = 'failed';
        r.message = errorMessage(e);
        this.stopped = true;
      } else {
        r.state = 'failed';
        r.message = e instanceof ExportProblem ? e.message : errorMessage(e);
      }
    } finally {
      if (this.ctrl === c) this.ctrl = null;
      if (epoch === this.epoch) this.emit();
    }
  }
}

export const shareRenders = new ShareRenderQueue({
  owner: sessionUserId,
  pending: (id, signal) => getRenderQueue(id, signal),
  photo: (id, signal) => getPhoto(id, signal),
  // The phase 4 exporter: original → recipe → full-size JPEG without metadata.
  render: async (photo, signal) => {
    const { renderExport } = await import('./editor/exporter');
    return renderExport(photo, null, { size: { kind: 'full' }, quality: 0.92, signal });
  },
  put: (g, p, v, jpeg, owner, signal) => putFullRender(g, p, v, jpeg, owner, signal),
});

onSessionEnd(() => shareRenders.reset());
