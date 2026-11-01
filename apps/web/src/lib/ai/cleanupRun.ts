import type { CleanupPhoto } from '@zephyr/shared/client';
import type { CleanupResult } from './cleanup';

/**
 * Runs groupCleanup in a short-lived worker so a big library never freezes the page (client review #9).
 * Browsers (and tests) without module workers group on the main thread instead.
 */
export function groupCleanupOffThread(photos: CleanupPhoto[], signal?: AbortSignal): Promise<CleanupResult> {
  if (typeof Worker === 'undefined') return import('./cleanup').then((m) => m.groupCleanup(photos));
  return new Promise<CleanupResult>((resolve, reject) => {
    const w = new Worker(new URL('./cleanup.worker.ts', import.meta.url), {
      type: 'module',
      name: 'cleanup',
    });
    const done = () => {
      w.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new DOMException('Stopped.', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e: MessageEvent<{ n: number; result?: CleanupResult; error?: string }>) => {
      done();
      if (e.data.result) resolve(e.data.result);
      else reject(new Error(e.data.error ?? 'cleanup failed'));
    };
    w.onerror = () => {
      done();
      // A worker that can't start (an old browser): fall back to the main thread.
      import('./cleanup').then((m) => resolve(m.groupCleanup(photos)), reject);
    };
    w.postMessage({ n: 1, photos });
  });
}
