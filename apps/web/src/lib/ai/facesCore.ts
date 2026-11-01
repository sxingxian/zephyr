/**
 * Face detection and face codes (phase 6, on the device): YuNet 2023mar (detection, MIT) and SFace 2021dec
 * int8 (128-value face codes, Apache 2.0), both from OpenCV Zoo, run with onnxruntime-web. This file holds the
 * maths (pre-processing, decoding, alignment) and an engine over any onnxruntime module, so it runs the same
 * in the browser worker (faces.worker.ts) and in Node tests.
 *
 * Coordinates: detections are normalised to the image given (0–1). Face codes never leave this device except
 * to the member's own account (AI_API.faces), and only when face grouping is on.
 */
export const YUNET_SIZE = 640;
export const SFACE_SIZE = 112;
const STRIDES = [8, 16, 32] as const;

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}
export interface FaceDetection {
  /** Normalised [x, y, w, h] in the image (0–1). */
  box: [number, number, number, number];
  score: number;
  /** Five points (right eye, left eye, nose tip, right mouth corner, left mouth corner, as seen by the
   * subject), normalised, x then y. */
  landmarks: [number, number][];
}

/** Bilinear RGBA resize. */
export function resizeRgba(img: Rgba, w: number, h: number): Rgba {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, ((y + 0.5) * img.height) / h - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, ((x + 0.5) * img.width) / w - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c] as number;
        const b = img.data[(y0 * img.width + x1) * 4 + c] as number;
        const d = img.data[(y1 * img.width + x0) * 4 + c] as number;
        const e = img.data[(y1 * img.width + x1) * 4 + c] as number;
        out[(y * w + x) * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** YuNet input: the image scaled to fit 640 × 640 (top-left, zero padding), BGR 0–255, NCHW. */
export function yunetInput(img: Rgba): { tensor: Float32Array; scale: number } {
  const scale = YUNET_SIZE / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const small = w === img.width && h === img.height ? img : resizeRgba(img, w, h);
  const plane = YUNET_SIZE * YUNET_SIZE;
  const t = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = y * YUNET_SIZE + x;
      t[o] = small.data[i + 2] as number; // B
      t[plane + o] = small.data[i + 1] as number; // G
      t[2 * plane + o] = small.data[i] as number; // R
    }
  return { tensor: t, scale };
}

type Out = Record<string, { data: Float32Array | ArrayLike<number> }>;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Decodes YuNet's per-stride outputs (as OpenCV's FaceDetectorYN does), in pixels of the original image. */
export function decodeYunet(
  out: Out,
  scale: number,
  threshold: number,
): { box: number[]; score: number; kps: number[] }[] {
  const found: { box: number[]; score: number; kps: number[] }[] = [];
  for (const s of STRIDES) {
    const cls = out[`cls_${s}`]?.data;
    const obj = out[`obj_${s}`]?.data;
    const bbox = out[`bbox_${s}`]?.data;
    const kps = out[`kps_${s}`]?.data;
    if (!cls || !obj || !bbox || !kps) throw new Error(`YuNet output for stride ${s} missing`);
    const cols = Math.ceil(YUNET_SIZE / s);
    const n = cls.length;
    for (let i = 0; i < n; i++) {
      const score = Math.sqrt(clamp01(cls[i] as number) * clamp01(obj[i] as number));
      if (score < threshold) continue;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const cx = (col + (bbox[i * 4] as number)) * s;
      const cy = (row + (bbox[i * 4 + 1] as number)) * s;
      const w = Math.exp(bbox[i * 4 + 2] as number) * s;
      const h = Math.exp(bbox[i * 4 + 3] as number) * s;
      const k: number[] = [];
      for (let j = 0; j < 5; j++) {
        k.push(((col + (kps[i * 10 + j * 2] as number)) * s) / scale);
        k.push(((row + (kps[i * 10 + j * 2 + 1] as number)) * s) / scale);
      }
      found.push({ box: [(cx - w / 2) / scale, (cy - h / 2) / scale, w / scale, h / scale], score, kps: k });
    }
  }
  return found;
}

const iou = (a: number[], b: number[]) => {
  const x1 = Math.max(a[0] as number, b[0] as number);
  const y1 = Math.max(a[1] as number, b[1] as number);
  const x2 = Math.min((a[0] as number) + (a[2] as number), (b[0] as number) + (b[2] as number));
  const y2 = Math.min((a[1] as number) + (a[3] as number), (b[1] as number) + (b[3] as number));
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = (a[2] as number) * (a[3] as number) + (b[2] as number) * (b[3] as number) - inter;
  return u > 0 ? inter / u : 0;
};
/** Greedy non-maximum suppression (highest score first). */
export function nms<T extends { box: number[]; score: number }>(
  dets: T[],
  threshold = 0.3,
  topK = 5000,
): T[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score).slice(0, topK);
  const keep: T[] = [];
  for (const d of sorted) if (keep.every((k) => iou(k.box, d.box) <= threshold)) keep.push(d);
  return keep;
}

/** ArcFace's 112 × 112 five-point template (what SFace was trained on). */
export const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Least-squares similarity transform (rotation, uniform scale, shift; no reflection) taking `src` points onto
 * `dst`: dst ≈ [c −s; s c]·src + t. Returns [c, s, tx, ty].
 */
export function similarity(
  src: [number, number][],
  dst: [number, number][],
): [number, number, number, number] {
  const n = src.length;
  let mx = 0;
  let my = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < n; i++) {
    mx += (src[i] as [number, number])[0] / n;
    my += (src[i] as [number, number])[1] / n;
    nx += (dst[i] as [number, number])[0] / n;
    ny += (dst[i] as [number, number])[1] / n;
  }
  let a = 0;
  let b = 0;
  let sp = 0;
  for (let i = 0; i < n; i++) {
    const px = (src[i] as [number, number])[0] - mx;
    const py = (src[i] as [number, number])[1] - my;
    const qx = (dst[i] as [number, number])[0] - nx;
    const qy = (dst[i] as [number, number])[1] - ny;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    sp += px * px + py * py;
  }
  const c = sp > 0 ? a / sp : 1;
  const s = sp > 0 ? b / sp : 0;
  return [c, s, nx - (c * mx - s * my), ny - (s * mx + c * my)];
}

/**
 * The face aligned to the 112 × 112 template (bilinear, black outside the image), as SFace's input: RGB 0–255,
 * NCHW. `landmarks` in pixels of `img`.
 */
export function alignFace(img: Rgba, landmarks: [number, number][]): Float32Array {
  const [c, s, tx, ty] = similarity(landmarks, TEMPLATE);
  const det = c * c + s * s || 1;
  const plane = SFACE_SIZE * SFACE_SIZE;
  const t = new Float32Array(3 * plane);
  for (let v = 0; v < SFACE_SIZE; v++)
    for (let u = 0; u < SFACE_SIZE; u++) {
      // Inverse of dst = R·src + t.
      const dx = u - tx;
      const dy = v - ty;
      const x = (c * dx + s * dy) / det;
      const y = (-s * dx + c * dy) / det;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const at = (xx: number, yy: number, ch: number) =>
        xx < 0 || yy < 0 || xx >= img.width || yy >= img.height
          ? 0
          : (img.data[(yy * img.width + xx) * 4 + ch] as number);
      for (let ch = 0; ch < 3; ch++) {
        const val =
          (at(x0, y0, ch) * (1 - fx) + at(x0 + 1, y0, ch) * fx) * (1 - fy) +
          (at(x0, y0 + 1, ch) * (1 - fx) + at(x0 + 1, y0 + 1, ch) * fx) * fy;
        t[ch * plane + v * SFACE_SIZE + u] = val;
      }
    }
  return t;
}

/** L2-normalised copy. */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}
export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return d / (Math.sqrt(na * nb) || 1);
}

/** 128 float32 values, little-endian, base64 (684 characters): the FacesBody format. */
export function embeddingToBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i] as number, true);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function base64ToEmbedding(s: string): Float32Array {
  const bin = atob(s);
  const dv = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  return Float32Array.from({ length: bin.length / 4 }, (_, i) => dv.getFloat32(i * 4, true));
}

// ------------------------------------------------------------ engine
/** The slice of onnxruntime's API the engine uses (browser and Node builds both provide it). */
export interface OrtLike {
  InferenceSession: {
    create(
      model: Uint8Array,
      opts?: unknown,
    ): Promise<{
      inputNames: readonly string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
    }>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}

export interface FaceEngine {
  /** Faces at or above `threshold` (default 0.8), largest overlap removed. */
  detect(img: Rgba, threshold?: number): Promise<FaceDetection[]>;
  /** One L2-normalised 128-value face code per detection. */
  embed(img: Rgba, faces: FaceDetection[]): Promise<Float32Array[]>;
}

/**
 * `sface` may be a loader: the 10 MB recognition model is then fetched only when face codes are first asked
 * for (skin tones in auto-enhance need detection only).
 */
export async function createFaceEngine(
  ort: OrtLike,
  yunet: Uint8Array,
  sface: Uint8Array | (() => Promise<Uint8Array>),
): Promise<FaceEngine> {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const det = await ort.InferenceSession.create(yunet, opts);
  type Session = Awaited<ReturnType<OrtLike['InferenceSession']['create']>>;
  let recP: Promise<Session> | null = null;
  const recognizer = () => {
    recP ??= (async () =>
      ort.InferenceSession.create(typeof sface === 'function' ? await sface() : sface, opts))();
    recP.catch(() => {
      recP = null;
    });
    return recP;
  };
  return {
    async detect(img, threshold = 0.8) {
      const { tensor, scale } = yunetInput(img);
      const out = await det.run({
        [det.inputNames[0] as string]: new ort.Tensor('float32', tensor, [1, 3, YUNET_SIZE, YUNET_SIZE]),
      });
      const raw = nms(decodeYunet(out as unknown as Out, scale, threshold), 0.3);
      return raw.map((d) => {
        const [x, y, w, h] = d.box as [number, number, number, number];
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        return {
          box: [
            x0 / img.width,
            y0 / img.height,
            Math.min(img.width - x0, w - (x0 - x)) / img.width,
            Math.min(img.height - y0, h - (y0 - y)) / img.height,
          ] as [number, number, number, number],
          score: Math.round(d.score * 10_000) / 10_000,
          landmarks: Array.from({ length: 5 }, (_, j) => [
            (d.kps[j * 2] as number) / img.width,
            (d.kps[j * 2 + 1] as number) / img.height,
          ]) as [number, number][],
        };
      });
    },
    async embed(img, faces) {
      const codes: Float32Array[] = [];
      if (!faces.length) return codes;
      const rec = await recognizer();
      for (const f of faces) {
        const pts = f.landmarks.map(([x, y]) => [x * img.width, y * img.height] as [number, number]);
        const input = alignFace(img, pts);
        const out = await rec.run({
          [rec.inputNames[0] as string]: new ort.Tensor('float32', input, [1, 3, SFACE_SIZE, SFACE_SIZE]),
        });
        const first = Object.values(out)[0] as { data: Float32Array };
        codes.push(normalize(Float32Array.from(first.data)));
      }
      return codes;
    },
  };
}
