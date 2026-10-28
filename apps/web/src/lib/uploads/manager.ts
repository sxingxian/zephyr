import {
  FILE_TYPES,
  type FileTypeId,
  type PhotoItem,
  type PhotoMetadata,
  type UploadDecision,
  type UploadFileSpec,
  type UploadStatus,
  type VariantKind,
} from '@zephyr/shared/client';
import { ApiFailure, errorMessage } from '../api';
import { bytesDone, partRange, partsToSend } from './parts';

export type UploadState =
  | 'hashing' // reading the file to fingerprint it
  | 'queued' // fingerprinted, waiting for the server to accept it
  | 'waiting' // accepted, waiting for a free slot
  | 'uploading'
  | 'paused'
  | 'done'
  | 'duplicate'
  | 'rejected'
  | 'failed';

/** One file as the tray shows it. */
export interface UploadItem {
  key: string;
  name: string;
  size: number;
  state: UploadState;
  /** Bytes the server has (confirmed parts plus the part in flight). */
  sent: number;
  /** Why it was skipped or failed, in plain words. */
  message?: string;
  /** Object URL of the generated thumbnail, for the tray. */
  thumbUrl?: string;
  photoId?: string;
  retryable: boolean;
}

export interface UploadSnapshot {
  items: UploadItem[];
  paused: boolean;
  total: number;
  settled: number;
  done: number;
  failed: number;
  busy: boolean;
  bytesTotal: number;
  bytesSent: number;
  /** Rough seconds left, once there's enough data to estimate. */
  etaSeconds: number | null;
}

export interface Prepared {
  metadata: PhotoMetadata;
  thumb?: Blob;
  preview?: Blob;
}
export interface UploadRules {
  fileTypes: FileTypeId[];
  maxFileBytes: number;
  batchSize: number;
}

/** Everything the manager talks to, injectable for tests. */
export interface UploadDeps {
  rules(): Promise<UploadRules | null>;
  hash(file: File): Promise<string>;
  prepare(file: File, raw: boolean): Promise<Prepared>;
  create(files: UploadFileSpec[]): Promise<UploadDecision[]>;
  putVariant(uploadId: string, kind: VariantKind, blob: Blob, signal: AbortSignal): Promise<void>;
  putPart(
    uploadId: string,
    n: number,
    blob: Blob,
    signal: AbortSignal,
    onProgress: (sent: number) => void,
  ): Promise<void>;
  /** `duplicate`: the same file finished first in another upload; `photo` is that copy. */
  complete(uploadId: string, metadata: PhotoMetadata): Promise<{ photo: PhotoItem; duplicate?: boolean }>;
  status(uploadId: string): Promise<UploadStatus>;
  abort(uploadId: string): Promise<void>;
  /** A photo finished: show it in the grid. */
  onPhoto?(photo: PhotoItem): void;
  /** Everything finished (or stopped): refresh storage usage. */
  onSettled?(): void;
  objectUrl?(blob: Blob): string;
  revokeUrl?(url: string): void;
}

interface Rec extends UploadItem {
  file: File;
  sha256?: string;
  fileType?: FileTypeId;
  uploadId?: string;
  partSize: number;
  partCount: number;
  partsDone: Set<number>;
  variantsDone: Set<VariantKind>;
  prepared?: Prepared;
  ctrl?: AbortController;
  /** Ask the server what it already has before sending more. */
  checkStatus: boolean;
  /** The server-side upload is gone: ask for a new one. */
  needsCreate: boolean;
}

const BUSY: UploadState[] = ['hashing', 'queued', 'waiting', 'uploading', 'paused'];
export const CONCURRENCY = 3;

/** File type from the extension (the server re-checks the bytes). */
export function fileTypeOf(name: string): FileTypeId | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  for (const [id, t] of Object.entries(FILE_TYPES)) {
    if ((t.exts as readonly string[]).includes(ext)) return id as FileTypeId;
  }
  return null;
}

const MB = (n: number) => `${Math.round(n / 1_000_000)} MB`;
export function rejectionMessage(
  reason: 'type' | 'too_large' | 'quota' | 'invalid',
  file: { name: string },
  rules?: UploadRules | null,
): string {
  switch (reason) {
    case 'type': {
      const t = fileTypeOf(file.name);
      if (!t) return 'Zephyr can’t open this file type';
      return FILE_TYPES[t].raw ? 'RAW files need the Pro plan' : `${FILE_TYPES[t].label} isn’t on your plan`;
    }
    case 'too_large':
      return rules
        ? `Too large · your plan allows up to ${MB(rules.maxFileBytes)}`
        : 'Too large for your plan';
    case 'quota':
      return 'Storage full · free up space or upgrade';
    default:
      return 'This file couldn’t be read';
  }
}

function failMessage(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === 'network') return 'Didn’t upload · connection dropped';
    if (e.code === 'storage_full') return 'Storage full · free up space or upgrade';
    if (e.code === 'too_large') return 'Too large for your plan';
    return errorMessage(e);
  }
  return 'Didn’t upload · something went wrong';
}
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * The upload queue. Lives at module level so uploads keep going while the member moves between pages.
 * Files are fingerprinted one at a time, accepted by the server in batches, then sent three at a time,
 * each file's parts in order. Paused or failed files resume from the parts the server confirmed.
 */
export class UploadManager {
  private recs: Rec[] = [];
  private hashQueue: Rec[] = [];
  private createQueue: Rec[] = [];
  private hashing = false;
  private creating = false;
  private paused = false;
  private rules: UploadRules | null = null;
  private seq = 0;
  private subs = new Set<() => void>();
  private snap: UploadSnapshot;
  private wasBusy = false;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private rate = { t: 0, bytes: 0, bps: 0 };

  constructor(
    private deps: UploadDeps,
    private concurrency = CONCURRENCY,
  ) {
    this.snap = this.build();
  }

  // ------------------------------------------------------------ store
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  isBusy = () => this.snap.busy;

  private notify() {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.snap = this.build();
    for (const s of this.subs) s();
    if (this.wasBusy && !this.snap.busy) this.deps.onSettled?.();
    this.wasBusy = this.snap.busy;
  }
  /** Progress ticks are frequent; coalesce them to ~10 updates a second. */
  private notifySoon() {
    this.progressTimer ??= setTimeout(() => this.notify(), 100);
  }

  private build(): UploadSnapshot {
    const items = this.recs.map(
      (r): UploadItem => ({
        key: r.key,
        name: r.name,
        size: r.size,
        state: r.state,
        sent: r.sent,
        message: r.message,
        thumbUrl: r.thumbUrl,
        photoId: r.photoId,
        retryable: r.retryable,
      }),
    );
    let bytesTotal = 0;
    let bytesSent = 0;
    let done = 0;
    let failed = 0;
    let settled = 0;
    let busy = false;
    for (const r of this.recs) {
      if (BUSY.includes(r.state)) busy = true;
      if (r.state === 'done') done++;
      if (r.state === 'failed') failed++;
      if (r.state === 'done' || r.state === 'duplicate' || r.state === 'rejected') settled++;
      if (r.state === 'duplicate' || r.state === 'rejected') continue;
      bytesTotal += r.size;
      bytesSent += r.state === 'done' ? r.size : r.sent;
    }
    const now = Date.now();
    if (!this.rate.t || bytesSent < this.rate.bytes) this.rate = { t: now, bytes: bytesSent, bps: 0 };
    else if (now - this.rate.t >= 1000) {
      const bps = ((bytesSent - this.rate.bytes) * 1000) / (now - this.rate.t);
      this.rate = { t: now, bytes: bytesSent, bps: this.rate.bps ? this.rate.bps * 0.7 + bps * 0.3 : bps };
    }
    const left = bytesTotal - bytesSent;
    const etaSeconds = busy && !this.paused && this.rate.bps > 0 && left > 0 ? left / this.rate.bps : null;
    return {
      items,
      paused: this.paused,
      total: this.recs.length,
      settled,
      done,
      failed,
      busy,
      bytesTotal,
      bytesSent,
      etaSeconds,
    };
  }

  // ------------------------------------------------------------ public actions
  /** Adds files to the queue. Files the plan can't take are marked straight away, without a request. */
  async add(files: File[]): Promise<void> {
    if (!files.length) return;
    try {
      this.rules = (await this.deps.rules()) ?? this.rules;
    } catch {
      // Let the server decide.
    }
    for (const file of files) {
      this.seq += 1;
      const rec: Rec = {
        key: `u${this.seq}`,
        name: file.name,
        size: file.size,
        state: 'hashing',
        sent: 0,
        retryable: false,
        file,
        partSize: 0,
        partCount: 0,
        partsDone: new Set(),
        variantsDone: new Set(),
        checkStatus: false,
        needsCreate: false,
      };
      const type = fileTypeOf(file.name);
      if (!type || (this.rules && !this.rules.fileTypes.includes(type))) {
        this.reject(rec, rejectionMessage('type', file, this.rules));
      } else if (this.rules && file.size > this.rules.maxFileBytes) {
        this.reject(rec, rejectionMessage('too_large', file, this.rules));
      } else if (file.size === 0) {
        this.reject(rec, rejectionMessage('invalid', file));
      } else {
        rec.fileType = type;
        this.hashQueue.push(rec);
      }
      this.recs.push(rec);
    }
    this.notify();
    void this.hashLoop();
  }

  pauseAll(): void {
    if (this.paused) return;
    this.paused = true;
    for (const r of this.recs) {
      if (r.state === 'uploading') {
        r.state = 'paused';
        r.checkStatus = true;
        r.ctrl?.abort();
      } else if (r.state === 'waiting') r.state = 'paused';
    }
    this.notify();
  }

  resumeAll(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const r of this.recs) if (r.state === 'paused') r.state = 'waiting';
    this.notify();
    this.pump();
  }

  /** Stops one file and tells the server to drop what it has. */
  cancel(key: string): void {
    const r = this.recs.find((x) => x.key === key);
    if (!r || r.state === 'done') return;
    r.ctrl?.abort();
    if (r.uploadId) void this.deps.abort(r.uploadId).catch(() => {});
    this.hashQueue = this.hashQueue.filter((x) => x !== r);
    this.createQueue = this.createQueue.filter((x) => x !== r);
    this.drop([r]);
    this.notify();
    this.pump();
  }

  /** Tries a failed file again, resuming from the parts the server already confirmed. */
  retry(key: string): void {
    const r = this.recs.find((x) => x.key === key);
    if (r?.state !== 'failed' || !r.retryable) return;
    r.message = undefined;
    if (!r.sha256) {
      r.state = 'hashing';
      this.hashQueue.push(r);
      this.notify();
      void this.hashLoop();
    } else if (r.needsCreate || !r.uploadId) {
      r.state = 'queued';
      r.uploadId = undefined;
      r.partsDone = new Set();
      r.variantsDone = new Set();
      r.sent = 0;
      this.createQueue.push(r);
      this.notify();
      void this.maybeFlush();
    } else {
      r.state = this.paused ? 'paused' : 'waiting';
      r.checkStatus = true;
      this.notify();
      this.pump();
    }
  }

  retryAll(): void {
    for (const r of [...this.recs]) if (r.state === 'failed') this.retry(r.key);
  }

  /** Removes finished, skipped and rejected rows from the tray. */
  clearFinished(): void {
    this.drop(
      this.recs.filter((r) => r.state === 'done' || r.state === 'duplicate' || r.state === 'rejected'),
    );
    this.notify();
  }

  // ------------------------------------------------------------ internals
  private drop(rs: Rec[]) {
    for (const r of rs) if (r.thumbUrl) this.deps.revokeUrl?.(r.thumbUrl);
    this.recs = this.recs.filter((r) => !rs.includes(r));
  }

  private reject(r: Rec, message: string) {
    r.state = 'rejected';
    r.message = message;
    r.retryable = false;
  }
  private fail(r: Rec, message: string, retryable = true) {
    r.state = 'failed';
    r.message = message;
    r.retryable = retryable;
  }
  private alive(r: Rec) {
    return this.recs.includes(r);
  }
  private activeCount() {
    return this.recs.filter((r) => r.state === 'uploading').length;
  }

  private async hashLoop() {
    if (this.hashing) return;
    this.hashing = true;
    try {
      while (this.hashQueue.length) {
        const r = this.hashQueue.shift() as Rec;
        if (!this.alive(r)) continue;
        try {
          r.sha256 = await this.deps.hash(r.file);
          if (!this.alive(r)) continue;
          r.state = 'queued';
          this.createQueue.push(r);
        } catch {
          this.fail(r, 'Couldn’t read this file');
        }
        this.notify();
        void this.maybeFlush();
      }
    } finally {
      this.hashing = false;
    }
  }

  private batchSize() {
    return Math.max(1, Math.min(this.rules?.batchSize ?? 50, 500));
  }

  /**
   * Asks the server to accept queued files. Sends a batch as soon as it's full, when fingerprinting has
   * caught up, or when upload slots are idle (so the first files start without waiting for the rest).
   */
  private async maybeFlush(): Promise<void> {
    if (this.creating || !this.createQueue.length) return;
    const idle =
      this.recs.filter((r) => r.state === 'uploading' || r.state === 'waiting').length < this.concurrency;
    if (this.createQueue.length < this.batchSize() && this.hashQueue.length && !idle) return;
    this.creating = true;
    const batch = this.createQueue.splice(0, this.batchSize()).filter((r) => this.alive(r));
    try {
      if (batch.length) {
        const decisions = await this.deps.create(
          batch.map((r) => ({
            name: r.name,
            size: r.size,
            sha256: r.sha256 as string,
            lastModified: r.file.lastModified || undefined,
          })),
        );
        for (const [i, r] of batch.entries()) this.apply(r, decisions[i]);
      }
    } catch (e) {
      for (const r of batch) {
        r.needsCreate = true;
        this.fail(r, failMessage(e), !(e instanceof ApiFailure && e.code === 'invalid'));
      }
    } finally {
      this.creating = false;
    }
    this.notify();
    this.pump();
    void this.maybeFlush();
  }

  private apply(r: Rec, d: UploadDecision | undefined) {
    if (!this.alive(r)) {
      if (d?.status === 'ready') void this.deps.abort(d.uploadId).catch(() => {});
      return;
    }
    if (!d) return this.fail(r, 'Didn’t upload · something went wrong');
    if (d.status === 'duplicate') {
      r.state = 'duplicate';
      r.photoId = d.photoId;
      r.message = 'Already in your library · skipped';
      return;
    }
    if (d.status === 'rejected') return this.reject(r, rejectionMessage(d.reason, r, this.rules));
    r.uploadId = d.uploadId;
    r.photoId = d.photoId;
    r.partSize = d.partSize;
    r.partCount = d.partCount;
    r.fileType = d.fileType;
    r.partsDone = new Set();
    r.variantsDone = new Set();
    r.needsCreate = false;
    r.checkStatus = false;
    r.sent = 0;
    r.state = this.paused ? 'paused' : 'waiting';
  }

  private pump() {
    if (this.paused) return;
    let active = this.activeCount();
    for (const r of this.recs) {
      if (active >= this.concurrency) break;
      if (r.state !== 'waiting') continue;
      active++;
      void this.run(r);
    }
  }

  private async run(r: Rec): Promise<void> {
    const uploadId = r.uploadId as string;
    r.state = 'uploading';
    r.message = undefined;
    const ctrl = new AbortController();
    r.ctrl = ctrl;
    this.notify();
    try {
      if (r.checkStatus) {
        const st = await this.deps.status(uploadId);
        r.partsDone = new Set(st.partsDone);
        r.variantsDone = new Set(st.variantsDone);
        r.checkStatus = false;
      }
      r.sent = bytesDone(r.size, r.partSize, r.partsDone);
      this.notify();
      if (!r.prepared) {
        const raw = Boolean(r.fileType && FILE_TYPES[r.fileType].raw);
        r.prepared = await this.deps.prepare(r.file, raw);
        if (r.prepared.thumb && this.deps.objectUrl) r.thumbUrl = this.deps.objectUrl(r.prepared.thumb);
      }
      for (const kind of ['thumb', 'preview'] as const) {
        const blob = r.prepared[kind];
        if (!blob || r.variantsDone.has(kind)) continue;
        try {
          await this.deps.putVariant(uploadId, kind, blob, ctrl.signal);
          r.variantsDone.add(kind);
        } catch (e) {
          // A variant the server won't take isn't worth failing the upload over; the grid shows a placeholder.
          if (e instanceof ApiFailure && (e.code === 'invalid' || e.code === 'too_large')) continue;
          throw e;
        }
      }
      for (const n of partsToSend(r.partCount, r.partsDone)) {
        const { start, end } = partRange(r.size, r.partSize, n);
        const base = bytesDone(r.size, r.partSize, r.partsDone);
        await this.deps.putPart(uploadId, n, r.file.slice(start, end), ctrl.signal, (s) => {
          r.sent = base + Math.min(s, end - start);
          this.notifySoon();
        });
        r.partsDone.add(n);
        r.sent = bytesDone(r.size, r.partSize, r.partsDone);
        this.notifySoon();
      }
      const { photo, duplicate } = await this.deps.complete(uploadId, r.prepared.metadata);
      r.sent = r.size;
      r.photoId = photo.id;
      if (duplicate) {
        r.state = 'duplicate';
        r.message = 'Already in your library · skipped';
      } else {
        r.state = 'done';
        this.deps.onPhoto?.(photo);
      }
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e)) {
        // Paused or cancelled: the caller already set the state.
      } else if (e instanceof ApiFailure && (e.code === 'upload_expired' || e.code === 'not_found')) {
        r.needsCreate = true;
        this.fail(r, 'This upload expired · retry to start again');
      } else if (e instanceof ApiFailure && e.code === 'invalid') {
        this.fail(r, 'The server couldn’t accept this file', false);
      } else {
        r.checkStatus = true;
        this.fail(r, failMessage(e));
      }
    } finally {
      if (r.ctrl === ctrl) r.ctrl = undefined;
      this.notify();
      this.pump();
    }
  }
}
