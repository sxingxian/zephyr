import type { PhotoSignals } from '@zephyr/shared/client';

export { computeSignals, isNight, laplacianVariance, localHour, phash } from './signalsCore';

// ------------------------------------------------------------ worker
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (s: PhotoSignals) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./signals.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ n: number; signals?: PhotoSignals; error?: string }>) => {
    const w = waiting.get(e.data.n);
    if (!w) return;
    waiting.delete(e.data.n);
    if (e.data.signals) w.resolve(e.data.signals);
    else w.reject(new Error(e.data.error ?? 'signals failed'));
  };
  return worker;
}

/** Measures one thumbnail (an image blob) off the main thread. */
export function measureSignals(id: string, thumb: Blob, takenAt: string | null): Promise<PhotoSignals> {
  return new Promise((resolve, reject) => {
    const n = ++seq;
    waiting.set(n, { resolve, reject });
    getWorker().postMessage({ n, id, blob: thumb, takenAt });
  });
}

/** Stops the worker (session end). Pending measurements are rejected. */
export function stopSignalsWorker(): void {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new DOMException('Stopped.', 'AbortError'));
  waiting.clear();
}
