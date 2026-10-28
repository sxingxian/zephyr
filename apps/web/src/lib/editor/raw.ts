export interface RawImage {
  width: number;
  height: number;
  /** Linear RGBA half floats, top row first. */
  data: Uint16Array;
  /** Exposure the editor adds so a RAW's linear data looks like a normal photo. */
  baselineEv: number;
}

const TIMEOUT_MS = 60_000;
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (r: RawImage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./raw.worker.ts', import.meta.url), { type: 'module', name: 'raw-decoder' });
  w.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; ok: boolean; error?: string } & Partial<RawImage>;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok && m.data && m.width && m.height) {
      p.resolve({ width: m.width, height: m.height, data: m.data, baselineEv: m.baselineEv ?? 0 });
    } else
      p.reject(
        new Error(
          m.error === 'too large'
            ? 'This RAW file is too large to edit here.'
            : 'Zephyr couldn’t read this RAW file.',
        ),
      );
  };
  w.onerror = () => stopRawDecoder(new Error('The RAW decoder stopped.'));
  worker = w;
  return w;
}

/** Decodes a RAW file in the worker. A decode that takes over 60 s stops the worker. */
export function decodeRaw(buf: ArrayBuffer, half: boolean): Promise<RawImage> {
  const id = ++seq;
  const w = getWorker();
  return new Promise<RawImage>((resolve, reject) => {
    const timer = setTimeout(
      () => stopRawDecoder(new Error('Developing this RAW took too long.')),
      TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, buf, half }, [buf]);
  });
}

/** Terminates the worker (and its WebAssembly memory). Pending decodes fail. */
export function stopRawDecoder(reason: Error = new Error('stopped')): void {
  worker?.terminate();
  worker = null;
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(reason);
  }
  pending.clear();
}
