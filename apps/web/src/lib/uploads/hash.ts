type Pending = { resolve: (h: string) => void; reject: (e: Error) => void; onProgress?: (n: number) => void };

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no workers');
    const w = new Worker(new URL('./hash.worker.ts', import.meta.url), {
      type: 'module',
      name: 'zephyr-hash',
    });
    w.onmessage = (e: MessageEvent<{ id: number; progress?: number; hash?: string; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.progress !== undefined) return p.onProgress?.(e.data.progress);
      pending.delete(e.data.id);
      if (e.data.hash) p.resolve(e.data.hash);
      else p.reject(new Error(e.data.error ?? 'hash failed'));
    };
    w.onerror = () => {
      // The worker couldn't start (old browser, blocked): fall back to the main thread from now on.
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('worker failed'));
      }
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Stops fingerprinting in progress: the worker is terminated (a new one starts on the next file). */
export function stopHashing(): void {
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new DOMException('Aborted', 'AbortError'));
  }
}

/** SHA-256 (hex) of a file, in a Web Worker when possible, falling back to the main thread. */
export async function hashFile(file: Blob, onProgress?: (n: number) => void): Promise<string> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<string>((resolve, reject) => {
        seq += 1;
        pending.set(seq, { resolve, reject, onProgress });
        w.postMessage({ id: seq, file });
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      // fall through to the main thread
    }
  }
  // Main-thread fallback, loaded only when needed.
  const { sha256Blob } = await import('./sha256');
  return sha256Blob(file, onProgress);
}
