import type { CropSettings, EditRecipe, PhotoItem } from '@zephyr/shared/client';
import { developParams, developPixel, fromSrgb, toSrgb } from '../editor/develop';
import { apply, fitLongEdge, type Mat3, outputSize, outputToSource, type Size } from '../editor/geometry';
import type { Source } from '../editor/gl';

/**
 * A small linear-light copy of what the editor develops (phase 6 on-device AI). Auto-enhance, HDR and colour
 * match measure it through `develop.ts`, the CPU reference of the editor's shader, so the sliders they choose
 * look the same in the editor, in thumbnails and in exports.
 *
 * The proxy is taken from the photo's develop input (the RAW half-size decode for RAW files, the stored
 * preview otherwise), inside the recipe's crop, at `edge` pixels on the long side.
 */
export interface AiProxy {
  width: number;
  height: number;
  /** Linear light before the base development (what the shader's geometry pass hands to develop), RGB. */
  rgb: Float32Array;
  /** The blurred neighbourhood luminance per pixel (the shader's local-luminance mask). */
  local: Float32Array;
  /** RAW baseline exposure and whether the RAW base curve applies (see rawCommon.ts). */
  baselineEv: number;
  raw: boolean;
  /** Maps proxy uv (0–1) to source uv, for face boxes found on the whole photo. */
  toSource: Mat3;
}

export const PROXY_EDGE = 256;
export const SMALL_PROXY_EDGE = 128;
/** The source is reduced to this long edge before the crop is resampled. */
const WORK_EDGE = 768;
const LUM_EDGE = 64;

/** A linear RGB image, 3 floats per pixel. */
export interface LinearImage {
  w: number;
  h: number;
  rgb: Float32Array;
}

/** Area-average downscale to at most `edge` on the long side. */
export function shrink(img: LinearImage, edge: number): LinearImage {
  const k = Math.min(1, edge / Math.max(img.w, img.h));
  if (k >= 1) return img;
  const w = Math.max(1, Math.round(img.w * k));
  const h = Math.max(1, Math.round(img.h * k));
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.h) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.w) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.w + xx) * 3;
          r += img.rgb[i] as number;
          g += img.rgb[i + 1] as number;
          b += img.rgb[i + 2] as number;
        }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { w, h, rgb: out };
}

/** RGBA 8-bit sRGB → linear RGB (alpha ignored). */
export function linearFromRgba8(data: Uint8ClampedArray | Uint8Array, w: number, h: number): LinearImage {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = fromSrgb(i / 255);
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) {
    rgb[j] = lut[data[i] as number] as number;
    rgb[j + 1] = lut[data[i + 1] as number] as number;
    rgb[j + 2] = lut[data[i + 2] as number] as number;
  }
  return { w, h, rgb };
}

/** IEEE half float bits → number. */
function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const v = e === 0 ? m * 2 ** -24 : e === 31 ? 65504 : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
}
/** Linear RGBA half floats (a RAW decode) → linear RGB, reduced to `edge` with an area average on the way. */
export function linearFromHalf(data: Uint16Array, w: number, h: number, edge = WORK_EDGE): LinearImage {
  const k = Math.min(1, edge / Math.max(w, h));
  const ow = Math.max(1, Math.round(w * k));
  const oh = Math.max(1, Math.round(h * k));
  const out = new Float32Array(ow * oh * 3);
  const step = Math.max(1, Math.floor(1 / k / 2)); // sample a sparse grid inside each cell: fast and smooth enough
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor((y * h) / oh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / oh));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor((x * w) / ow);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / ow));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += step)
        for (let xx = x0; xx < x1; xx += step) {
          const i = (yy * w + xx) * 4;
          r += Math.max(0, half(data[i] as number));
          g += Math.max(0, half(data[i + 1] as number));
          b += Math.max(0, half(data[i + 2] as number));
          n++;
        }
      const o = (y * ow + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return { w: ow, h: oh, rgb: out };
}

function bilinear(img: LinearImage, u: number, v: number, out: Float32Array, o: number) {
  const x = Math.min(1, Math.max(0, u)) * img.w - 0.5;
  const y = Math.min(1, Math.max(0, v)) * img.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx = (n: number) => Math.min(img.w - 1, Math.max(0, n));
  const cy = (n: number) => Math.min(img.h - 1, Math.max(0, n));
  const a = (cy(y0) * img.w + cx(x0)) * 3;
  const b = (cy(y0) * img.w + cx(x0 + 1)) * 3;
  const c = (cy(y0 + 1) * img.w + cx(x0)) * 3;
  const d = (cy(y0 + 1) * img.w + cx(x0 + 1)) * 3;
  for (let k = 0; k < 3; k++) {
    const t = (img.rgb[a + k] as number) * (1 - fx) + (img.rgb[b + k] as number) * fx;
    const bt = (img.rgb[c + k] as number) * (1 - fx) + (img.rgb[d + k] as number) * fx;
    out[o + k] = t * (1 - fy) + bt * fy;
  }
}

/** Separable box blur of a single-channel image (clamped edges). */
function boxBlur1(data: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += data[y * w + Math.min(w - 1, Math.max(0, x + k))] as number;
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] as number;
      out[y * w + x] = s / n;
    }
  return out;
}

/**
 * The proxy of a linear image inside `crop`: the crop's output shape at `edge` pixels, resampled through the
 * editor's own output → source matrix, plus the neighbourhood luminance the highlights and shadows sliders
 * use (a 64 px blur, like the shader's mask).
 */
export function proxyFromLinear(
  img: LinearImage,
  srcSize: Size,
  crop: CropSettings | undefined,
  edge: number,
  baselineEv: number,
  raw: boolean,
): AiProxy {
  const out = fitLongEdge(outputSize(crop, srcSize), edge);
  const m = outputToSource(crop, srcSize);
  const rgb = new Float32Array(out.width * out.height * 3);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const [u, v] = apply(m, (x + 0.5) / out.width, (y + 0.5) / out.height);
      bilinear(img, u, v, rgb, (y * out.width + x) * 3);
    }
  // Local luminance: luma at 64 px, blurred, then read back per pixel (nearest is fine at this scale).
  const lum: LinearImage = { w: out.width, h: out.height, rgb: new Float32Array(out.width * out.height * 3) };
  for (let i = 0; i < out.width * out.height; i++) {
    const l =
      0.2126 * (rgb[i * 3] as number) +
      0.7152 * (rgb[i * 3 + 1] as number) +
      0.0722 * (rgb[i * 3 + 2] as number);
    lum.rgb[i * 3] = l;
  }
  const small = shrink(lum, LUM_EDGE);
  const one = new Float32Array(small.w * small.h);
  for (let i = 0; i < one.length; i++) one[i] = small.rgb[i * 3] as number;
  const blurred = boxBlur1(boxBlur1(one, small.w, small.h, 2), small.w, small.h, 2);
  const local = new Float32Array(out.width * out.height);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(small.w - 1, Math.floor(((x + 0.5) / out.width) * small.w));
      const sy = Math.min(small.h - 1, Math.floor(((y + 0.5) / out.height) * small.h));
      local[y * out.width + x] = blurred[sy * small.w + sx] as number;
    }
  return { width: out.width, height: out.height, rgb, local, baselineEv, raw, toSource: m };
}

/** A proxy at a smaller size (colour match works on 128 px). */
export function resizeProxy(p: AiProxy, edge: number): AiProxy {
  if (Math.max(p.width, p.height) <= edge) return p;
  const img = shrink({ w: p.width, h: p.height, rgb: p.rgb }, edge);
  const loc = shrink(
    {
      w: p.width,
      h: p.height,
      rgb: Float32Array.from({ length: p.local.length * 3 }, (_, i) => p.local[Math.floor(i / 3)] as number),
    },
    edge,
  );
  const local = new Float32Array(img.w * img.h);
  for (let i = 0; i < local.length; i++) local[i] = loc.rgb[i * 3] as number;
  return { ...p, width: img.w, height: img.h, rgb: img.rgb, local };
}

/**
 * Develops every proxy pixel through `recipe` (develop.ts; detail, cut-out and crop changes excluded: the
 * proxy is already cropped) and returns display-encoded sRGB, 3 values 0–1 per pixel.
 */
export function developProxy(p: AiProxy, recipe: EditRecipe | null): Float32Array {
  const d = developParams(recipe, p.width / p.height, p.baselineEv, p.raw);
  const out = new Float32Array(p.width * p.height * 3);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = y * p.width + x;
      const c = developPixel(
        [p.rgb[i * 3] as number, p.rgb[i * 3 + 1] as number, p.rgb[i * 3 + 2] as number],
        p.local[i] as number,
        (x + 0.5) / p.width,
        (y + 0.5) / p.height,
        d,
      );
      out[i * 3] = toSrgb(c[0]);
      out[i * 3 + 1] = toSrgb(c[1]);
      out[i * 3 + 2] = toSrgb(c[2]);
    }
  return out;
}

// ------------------------------------------------------------ browser loading
function canvas2d(w: number, h: number) {
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('canvas');
  return ctx;
}

/** An editor source (bitmap or RAW half floats) as a linear image of at most WORK_EDGE pixels. */
export function linearFromSource(s: Source): LinearImage {
  if (s.kind === 'half') return linearFromHalf(s.data, s.width, s.height);
  const k = Math.min(1, WORK_EDGE / Math.max(s.width, s.height));
  const w = Math.max(1, Math.round(s.width * k));
  const h = Math.max(1, Math.round(s.height * k));
  const ctx = canvas2d(w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s.bitmap as CanvasImageSource, 0, 0, w, h);
  return linearFromRgba8(ctx.getImageData(0, 0, w, h).data, w, h);
}

/** The proxy of an already-loaded editor source (the editor's own photo: nothing is fetched again). */
export function proxyFromSource(
  s: Source,
  baselineEv: number,
  crop: CropSettings | undefined,
  edge = PROXY_EDGE,
): AiProxy {
  return proxyFromLinear(
    linearFromSource(s),
    { width: s.width, height: s.height },
    crop,
    edge,
    baselineEv,
    s.kind === 'half',
  );
}

/**
 * Loads a photo's develop input and returns its proxy: the RAW half-size decode for RAW files (with its
 * baseline exposure, exactly as the editor uses), the stored preview for everything else (the original
 * when there is no preview).
 */
export async function loadProxy(
  photo: Pick<PhotoItem, 'id' | 'fileType' | 'hasPreview'>,
  crop: CropSettings | undefined,
  opts: { edge?: number; signal?: AbortSignal } = {},
): Promise<AiProxy> {
  const { isRaw, loadOriginal, loadPreview, releaseSource } = await import('../editor/sources');
  const loaded =
    !isRaw(photo) && photo.hasPreview
      ? await loadPreview(photo.id, WORK_EDGE * 2, opts.signal)
      : await loadOriginal(photo, { full: false, maxEdge: 20_000, signal: opts.signal });
  try {
    return proxyFromSource(loaded.source, loaded.baselineEv, crop, opts.edge ?? PROXY_EDGE);
  } finally {
    releaseSource(loaded.source);
  }
}
