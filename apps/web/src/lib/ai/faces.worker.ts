/// <reference lib="webworker" />
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { MODEL_CACHE, MODEL_PATH, MODELS } from './faceModels';
import { createFaceEngine, type FaceDetection, type FaceEngine, type Rgba } from './facesCore';

/**
 * Face detection and face codes off the main thread (phase 6). The models are fetched from this origin only,
 * checked against their pinned SHA-256 before use, and kept in Cache Storage; onnxruntime-web runs on its
 * self-hosted WebAssembly build (SIMD, one thread, no proxy worker).
 */
type Req =
  | { n: number; op: 'detect'; bitmap: ImageBitmap; threshold: number }
  | { n: number; op: 'embed'; bitmap: ImageBitmap; faces: FaceDetection[] };

async function sha256(buf: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A model that couldn't be downloaded or verified: the main thread backs off instead of retrying per photo. */
class ModelLoadError extends Error {}

async function loadModel(m: { file: string; sha256: string }): Promise<Uint8Array> {
  try {
    return await fetchModel(m);
  } catch (e) {
    throw new ModelLoadError(String((e as Error)?.message ?? e));
  }
}

async function fetchModel(m: { file: string; sha256: string }): Promise<Uint8Array> {
  const url = MODEL_PATH + m.file;
  const cache = 'caches' in self ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if ((await sha256(buf)) === m.sha256) return new Uint8Array(buf);
    await cache?.delete(url);
  }
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn’t download the face model (${res.status}).`);
  const buf = await res.arrayBuffer();
  if ((await sha256(buf)) !== m.sha256) throw new Error('The face model didn’t pass its integrity check.');
  await cache
    ?.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } }))
    .catch(() => undefined);
  return new Uint8Array(buf);
}

let engine: Promise<FaceEngine> | null = null;
function getEngine(): Promise<FaceEngine> {
  engine ??= (async () => {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    ort.env.logLevel = 'error';
    const yunet = await loadModel(MODELS.yunet);
    // SFace (10 MB) loads only when face codes are first needed: skin tones use detection alone.
    return createFaceEngine(ort as unknown as Parameters<typeof createFaceEngine>[0], yunet, () =>
      loadModel(MODELS.sface),
    );
  })();
  engine.catch(() => {
    engine = null; // try again next time (a failed download)
  });
  return engine;
}

/** The bitmap's pixels at most 2048 px on the long edge (previews are that size already). */
function pixels(bmp: ImageBitmap): Rgba {
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const r = e.data;
  try {
    const eng = await getEngine().catch((err: unknown) => {
      // onnxruntime or the detector itself couldn't start: as bad as a missing model.
      throw err instanceof ModelLoadError ? err : new ModelLoadError(String((err as Error)?.message ?? err));
    });
    const img = pixels(r.bitmap);
    r.bitmap.close();
    if (r.op === 'detect') {
      (self as unknown as Worker).postMessage({ n: r.n, faces: await eng.detect(img, r.threshold) });
    } else {
      const codes = await eng.embed(img, r.faces);
      (self as unknown as Worker).postMessage(
        { n: r.n, codes },
        codes.map((c) => c.buffer as ArrayBuffer),
      );
    }
  } catch (err) {
    try {
      r.bitmap.close();
    } catch {
      // already closed
    }
    (self as unknown as Worker).postMessage({
      n: r.n,
      error: String((err as Error)?.message ?? err),
      model: err instanceof ModelLoadError,
    });
  }
};
