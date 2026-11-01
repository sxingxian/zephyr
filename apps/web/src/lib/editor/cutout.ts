import { AI_API, type CutoutSettings, type EditRecipe } from '@zephyr/shared/client';
import { ApiFailure } from '../api';
import { onEditorReset } from './resets';

/**
 * Background-removal masks (phase 6). A mask is an 8-bit greyscale PNG at the photo's preview size, made in the
 * cloud from the untouched preview. It is decoded once per photo and kept in memory with everything the
 * composite pass needs, built here on the CPU so the shader and its CPU reference read the same numbers:
 *
 *   levels   the mask and its mip chain (2×2 box averages), sampled trilinearly for the edge softness
 *   blur     a ≤ 512 px copy blurred by 3 box passes (radius 3 % of its long edge), for the soft shadow
 *   contact  an ellipse under the subject's lowest edge, for the contact shadow (source uv units)
 *
 * The cache belongs to the member's session: it is cleared when the session ends (shared devices).
 */
export interface MaskLevel {
  w: number;
  h: number;
  data: Uint8Array;
}
export interface CutoutMask {
  id: string;
  width: number;
  height: number;
  levels: MaskLevel[];
  blur: MaskLevel;
  /** Centre x, bottom y, radius x, radius y, in source uv (0–1). Null when the mask is empty. */
  contact: [number, number, number, number] | null;
}

/** True when the recipe shows a cut-out (a mask and a background other than the original). */
export function activeCutout(recipe: EditRecipe | null | undefined): CutoutSettings | null {
  const c = recipe?.cutout;
  return c && c.bg !== 'original' ? c : null;
}
/** True when the recipe's cut-out leaves the background transparent (exports as PNG or WEBP with alpha). */
export const isTransparentCutout = (recipe: EditRecipe | null | undefined) =>
  recipe?.cutout?.bg === 'transparent';

const BLUR_EDGE = 512;

function downsample(l: MaskLevel): MaskLevel {
  const w = Math.max(1, l.w >> 1);
  const h = Math.max(1, l.h >> 1);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(l.w - 1, x * 2);
      const x1 = Math.min(l.w - 1, x * 2 + 1);
      const y0 = Math.min(l.h - 1, y * 2);
      const y1 = Math.min(l.h - 1, y * 2 + 1);
      const s =
        (l.data[y0 * l.w + x0] as number) +
        (l.data[y0 * l.w + x1] as number) +
        (l.data[y1 * l.w + x0] as number) +
        (l.data[y1 * l.w + x1] as number);
      out[y * w + x] = (s + 2) >> 2;
    }
  return { w, h, data: out };
}

/** Separable box blur of radius r (clamped edges), in place via a scratch buffer. */
function boxBlur(l: MaskLevel, r: number): void {
  if (r < 1) return;
  const { w, h, data } = l;
  const tmp = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += data[y * w + Math.min(w - 1, Math.max(0, k))] as number;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      const add = Math.min(w - 1, x + r + 1);
      const sub = Math.max(0, x - r);
      acc += (data[y * w + add] as number) - (data[y * w + sub] as number);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x] as number;
    for (let y = 0; y < h; y++) {
      data[y * w + x] = Math.round(acc / n);
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      acc += (tmp[add * w + x] as number) - (tmp[sub * w + x] as number);
    }
  }
}

/** Where the subject meets the ground: the lowest rows of the mask, as an ellipse. */
function contactOf(l: MaskLevel): CutoutMask['contact'] {
  const { w, h, data } = l;
  let bottom = -1;
  let top = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--)
    for (let x = 0; x < w; x++)
      if ((data[y * w + x] as number) >= 128) {
        bottom = y;
        break;
      }
  if (bottom < 0) return null;
  for (let y = 0; y < h && top < 0; y++)
    for (let x = 0; x < w; x++)
      if ((data[y * w + x] as number) >= 128) {
        top = y;
        break;
      }
  // The subject's footprint: its pixels within the bottom 8 % of its height.
  const band = Math.max(1, Math.round((bottom - top + 1) * 0.08));
  let minX = w;
  let maxX = -1;
  let sumX = 0;
  let n = 0;
  for (let y = Math.max(0, bottom - band + 1); y <= bottom; y++)
    for (let x = 0; x < w; x++)
      if ((data[y * w + x] as number) >= 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        sumX += x;
        n++;
      }
  const cx = (sumX / n + 0.5) / w;
  const rx = Math.max(0.02, (((maxX - minX + 1) / w) * 0.6) / 2 + 0.01);
  const by = (bottom + 1) / h;
  return [cx, by, rx, 0.025];
}

/** Builds everything the composite pass needs from a decoded mask (one byte per pixel, top row first). */
export function buildMask(id: string, width: number, height: number, data: Uint8Array): CutoutMask {
  if (data.length !== width * height) throw new Error('mask size');
  const levels: MaskLevel[] = [{ w: width, h: height, data }];
  while (true) {
    const last = levels[levels.length - 1] as MaskLevel;
    if (last.w === 1 && last.h === 1) break;
    levels.push(downsample(last));
  }
  const src = levels.find((l) => Math.max(l.w, l.h) <= BLUR_EDGE) as MaskLevel;
  const blur: MaskLevel = { w: src.w, h: src.h, data: src.data.slice() };
  const r = Math.max(1, Math.round(0.03 * Math.max(blur.w, blur.h)));
  for (let i = 0; i < 3; i++) boxBlur(blur, r);
  return { id, width, height, levels, blur, contact: contactOf(levels[0] as MaskLevel) };
}

// ------------------------------------------------------------ registry
const MAX_MASKS = 8;
const masks = new Map<string, CutoutMask>();
const inflight = new Map<string, Promise<CutoutMask>>();
const listeners = new Set<(id: string) => void>();
let epoch = 0;

/** A mask that is already decoded (the renderer reads it synchronously), or null. */
export function getMask(maskId: string): CutoutMask | null {
  const m = masks.get(maskId);
  if (m) {
    // Most recently used last.
    masks.delete(maskId);
    masks.set(maskId, m);
  }
  return m ?? null;
}

/** Called with the mask id whenever a mask finishes loading. */
export function onMaskLoaded(fn: (maskId: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Decodes a greyscale PNG to one byte per pixel (the red channel; colour management off). */
export async function decodeMaskPng(
  blob: Blob,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const { width, height } = bmp;
    const c =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] as number;
    return { width, height, data };
  } finally {
    bmp.close();
  }
}

export interface MaskDeps {
  fetchMask(photoId: string, maskId: string, signal?: AbortSignal): Promise<Blob>;
  decode(blob: Blob): Promise<{ width: number; height: number; data: Uint8Array }>;
}
export const defaultMaskDeps: MaskDeps = {
  async fetchMask(photoId, maskId, signal) {
    // Owner-only route, served `private, no-cache` with an ETag: the browser revalidates every time (one
    // ownership check, usually a 304), so a signed-out or switched session never reads a cached mask.
    const res = await fetch(AI_API.mask(photoId, maskId), {
      credentials: 'same-origin',
      cache: 'no-cache',
      signal,
    });
    if (!res.ok) throw new ApiFailure(res.status === 404 ? 'not_found' : 'server', res.status);
    return res.blob();
  },
  decode: decodeMaskPng,
};
let deps: MaskDeps = defaultMaskDeps;
/** Tests swap the network and decoder. */
export function setMaskDeps(d: Partial<MaskDeps> | null): void {
  deps = d ? { ...defaultMaskDeps, ...d } : defaultMaskDeps;
}

/** Loads (once) and decodes a photo's mask. Concurrent calls share one request. */
export function loadMask(photoId: string, maskId: string, signal?: AbortSignal): Promise<CutoutMask> {
  const have = getMask(maskId);
  if (have) return Promise.resolve(have);
  const running = inflight.get(maskId);
  if (running) return running;
  const started = epoch;
  const p = (async () => {
    const blob = await deps.fetchMask(photoId, maskId, signal);
    const { width, height, data } = await deps.decode(blob);
    if (!width || !height || width > 4096 || height > 4096) throw new Error('mask size');
    const mask = buildMask(maskId, width, height, data);
    // The session ended while loading: don't keep it.
    if (started !== epoch) throw new DOMException('The session ended.', 'AbortError');
    masks.set(maskId, mask);
    while (masks.size > MAX_MASKS) masks.delete(masks.keys().next().value as string);
    for (const fn of listeners) fn(maskId);
    return mask;
  })().finally(() => {
    if (inflight.get(maskId) === p) inflight.delete(maskId);
  });
  inflight.set(maskId, p);
  return p;
}

/** Loads the recipe's mask if it has one, ignoring failures (the photo then shows with its background). */
export async function ensureMaskFor(photoId: string, recipe: EditRecipe | null | undefined): Promise<void> {
  const c = activeCutout(recipe);
  if (!c) return;
  try {
    await loadMask(photoId, c.mask);
  } catch {
    // Rendering without the cut-out is the safe fallback.
  }
}

/** Forgets every mask (session end). */
export function clearMasks(): void {
  epoch++;
  masks.clear();
  inflight.clear();
}

onEditorReset(clearMasks);
