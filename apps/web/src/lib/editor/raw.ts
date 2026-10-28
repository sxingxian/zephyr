export interface RawImage {
  width: number;
  height: number;
  /** Linear RGBA half floats, top row first. */
  data: Uint16Array;
  /** Exposure the editor adds so a RAW's linear data looks like a normal photo. */
  baselineEv: number;
}

/** The decoder refused a full-size decode that wouldn't fit in its memory (a half-size one still works). */
export class RawTooLargeForFull extends Error {
  override name = 'RawTooLargeForFull';
}

const TIMEOUT_MS = 60_000;
let worker: Worker | null = null;
let seq = 0;
interface Job {
  id: number;
  buf: ArrayBuffer;
  half: boolean;
  signal?: AbortSignal;
  resolve: (r: RawImage) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}
/** Decodes run one at a time: the worker only ever holds one file, and each gets its full 60 s. */
const waiting: Job[] = [];
let current: Job | null = null;

function failure(code: string | undefined): Error {
  if (code === 'too large') return new Error('This RAW file is too large to edit here.');
  if (code === 'memory') return new RawTooLargeForFull('This RAW is too large to develop at full size here.');
  return new Error('Zephyr couldn’t read this RAW file.');
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./raw.worker.ts', import.meta.url), { type: 'module', name: 'raw-decoder' });
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; ok: boolean; error?: string } & Partial<RawImage>;
    const job = current;
    if (!job || job.id !== m.id) return;
    current = null;
    clearTimeout(job.timer);
    if (m.ok && m.data && m.width && m.height) {
      job.resolve({ width: m.width, height: m.height, data: m.data, baselineEv: m.baselineEv ?? 0 });
    } else {
      job.reject(failure(m.error));
      // A failed decode may have left LibRaw (or its WebAssembly memory) unusable: start afresh next time.
      killWorker();
    }
    next();
  };
  w.onerror = () => stopRawDecoder(new Error('The RAW decoder stopped.'));
  worker = w;
  return w;
}

function killWorker() {
  worker?.terminate();
  worker = null;
}

function next(): void {
  if (current) return;
  let job = waiting.shift();
  while (job?.signal?.aborted) {
    job.reject(new DOMException('Aborted', 'AbortError'));
    job = waiting.shift();
  }
  if (!job) return;
  current = job;
  const w = getWorker();
  // The 60 s start now, when the decode actually starts, not while it waits its turn.
  job.timer = setTimeout(() => {
    if (current !== job) return;
    current = null;
    job.reject(new Error('Developing this RAW took too long.'));
    killWorker();
    next();
  }, TIMEOUT_MS);
  w.postMessage({ id: job.id, buf: job.buf, half: job.half }, [job.buf]);
}

/**
 * Decodes a RAW file in the worker. A decode that takes over 60 s stops the worker. Aborting the signal
 * drops a waiting decode, or stops the one running (by restarting the worker).
 */
export function decodeRaw(buf: ArrayBuffer, half: boolean, signal?: AbortSignal): Promise<RawImage> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<RawImage>((resolve, reject) => {
    const job: Job = { id: ++seq, buf, half, signal, resolve, reject };
    signal?.addEventListener(
      'abort',
      () => {
        const i = waiting.indexOf(job);
        if (i >= 0) {
          waiting.splice(i, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        } else if (current === job) {
          current = null;
          clearTimeout(job.timer);
          reject(new DOMException('Aborted', 'AbortError'));
          killWorker();
          next();
        }
      },
      { once: true },
    );
    waiting.push(job);
    next();
  });
}

/** Terminates the worker (and its WebAssembly memory). Running and waiting decodes fail. */
export function stopRawDecoder(reason: Error = new Error('stopped')): void {
  killWorker();
  const all = [...(current ? [current] : []), ...waiting.splice(0)];
  current = null;
  for (const j of all) {
    clearTimeout(j.timer);
    j.reject(reason);
  }
}
