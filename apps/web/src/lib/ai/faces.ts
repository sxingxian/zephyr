import { FACE_LIMITS, type FaceInput } from '@zephyr/shared/client';
import { embeddingToBase64, type FaceDetection } from './facesCore';

export type { FaceDetection } from './facesCore';

/**
 * Main-thread side of face detection and face codes (phase 6). The work runs in faces.worker.ts; the
 * bitmaps passed in are copied to the worker (the caller keeps and closes its own).
 *
 * `detectFaces` is also what skin tones in auto-enhance use (face boxes only; nothing is kept).
 * `embedFaces` makes face codes, used only for face grouping, which the member opts in to.
 */
let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./faces.worker.ts', import.meta.url), { type: 'module', name: 'faces' });
  worker.onmessage = (e: MessageEvent<{ n: number; error?: string; faces?: unknown; codes?: unknown }>) => {
    const w = waiting.get(e.data.n);
    if (!w) return;
    waiting.delete(e.data.n);
    if (e.data.error) w.reject(new Error(e.data.error));
    else w.resolve(e.data.faces ?? e.data.codes);
  };
  worker.onerror = () => stopFaces();
  return worker;
}

async function ask<T>(msg: Record<string, unknown>, bitmap: ImageBitmap): Promise<T> {
  // A copy for the worker: transferring would take the caller's bitmap away.
  const copy = await createImageBitmap(bitmap);
  return new Promise<T>((resolve, reject) => {
    const n = ++seq;
    waiting.set(n, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...msg, n, bitmap: copy }, [copy]);
  });
}

/** Faces in the image (normalised boxes and landmarks), at or above `threshold` (default FACE_LIMITS.minScore). */
export function detectFaces(
  bitmap: ImageBitmap,
  threshold: number = FACE_LIMITS.minScore,
): Promise<FaceDetection[]> {
  return ask<FaceDetection[]>({ op: 'detect', threshold }, bitmap);
}

/** One face code per face: 128 float32 values, little-endian, base64 (the FacesBody wire format). */
export async function embedFaces(bitmap: ImageBitmap, faces: FaceDetection[]): Promise<string[]> {
  if (!faces.length) return [];
  const codes = await ask<Float32Array[]>({ op: 'embed', faces }, bitmap);
  return codes.map(embeddingToBase64);
}

/**
 * Face grouping input for one photo's preview: faces at or above FACE_LIMITS.minScore and at least
 * FACE_LIMITS.minPixels wide on a 2048 px preview, at most FACE_LIMITS.perPhoto (the most confident).
 */
export async function facesForGrouping(bitmap: ImageBitmap): Promise<FaceInput[]> {
  const long = Math.max(bitmap.width, bitmap.height);
  const toPreview = 2048 / long;
  const found = (await detectFaces(bitmap))
    .filter((f) => f.box[2] * bitmap.width * toPreview >= FACE_LIMITS.minPixels)
    .sort((a, b) => b.score - a.score)
    .slice(0, FACE_LIMITS.perPhoto);
  const codes = await embedFaces(bitmap, found);
  return found.map((f, i) => ({
    box: f.box.map((v) => Math.floor(v * 10_000) / 10_000) as [number, number, number, number],
    score: Math.min(1, f.score),
    embedding: codes[i] as string,
  }));
}

/** Stops the worker (session end, or after an error). Pending calls are rejected. */
export function stopFaces(): void {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new DOMException('Stopped.', 'AbortError'));
  waiting.clear();
}
