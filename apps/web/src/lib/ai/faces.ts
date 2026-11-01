import { FACE_LIMITS, type FaceInput } from '@zephyr/shared/client';
import { FacesStoppedError, ModelError } from './faceErrors';
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

/**
 * A failed model download or integrity check is remembered for this page session, with a growing back-off
 * (1 minute, doubling up to an hour), so a broken deploy or a proxy serving the wrong bytes never makes every
 * photo download the 10 MB model again. Calls in the back-off window fail at once with ModelError.
 */
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
let blockedUntil = 0;
let backoff = BACKOFF_START_MS;
let now = () => Date.now();
function modelFailed(message: string): ModelError {
  blockedUntil = now() + backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  return new ModelError(message);
}
/** Test hook: a clock, and forgetting the back-off. */
export function _resetFacesForTest(clock?: () => number): void {
  blockedUntil = 0;
  backoff = BACKOFF_START_MS;
  now = clock ?? (() => Date.now());
}

type Reply = { n: number; error?: string; model?: boolean; faces?: unknown; codes?: unknown };
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./faces.worker.ts', import.meta.url), { type: 'module', name: 'faces' });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const w = waiting.get(e.data.n);
    if (!w) return;
    waiting.delete(e.data.n);
    if (e.data.error) w.reject(e.data.model ? modelFailed(e.data.error) : new Error(e.data.error));
    else {
      backoff = BACKOFF_START_MS;
      w.resolve(e.data.faces ?? e.data.codes);
    }
  };
  worker.onerror = () => stopFaces();
  return worker;
}

async function ask<T>(msg: Record<string, unknown>, bitmap: ImageBitmap): Promise<T> {
  if (now() < blockedUntil) throw new ModelError();
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

/**
 * Stops the worker (session end, face grouping turned off, or after an error) and frees its models and
 * WebAssembly heap. Pending calls are rejected with FacesStoppedError.
 */
export function stopFaces(): void {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new FacesStoppedError());
  waiting.clear();
}
export { FacesStoppedError, ModelError } from './faceErrors';
