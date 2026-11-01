import { VARIANT_LIMITS, type VariantKind } from '@zephyr/shared/client';

type Canvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * Phase 6: a transparent cut-out has alpha below 255. JPEG has no alpha, so those pixels are put on white
 * first (otherwise browsers encode them on black). Opaque pixels are left exactly as they are.
 */
export function flattenOnWhite(px: Uint8Array): Uint8Array {
  let out: Uint8Array | null = null;
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i] as number;
    if (a === 255) continue;
    out ??= px.slice();
    const k = a / 255;
    for (let c = i - 3; c < i; c++) out[c] = Math.round((px[c] as number) * k + 255 * (1 - k));
    out[i] = 255;
  }
  return out ?? px;
}
/** True when any pixel is not fully opaque. */
export function hasAlpha(px: Uint8Array): boolean {
  for (let i = 3; i < px.length; i += 4) if ((px[i] as number) !== 255) return true;
  return false;
}
function canvasFrom(px: Uint8Array, w: number, h: number): Canvas {
  const c: Canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('canvas');
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), w, h),
    0,
    0,
  );
  return c;
}
function toBlob(c: Canvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((res) => (c as HTMLCanvasElement).toBlob((b) => res(b), type, quality));
}

let webp: Promise<boolean> | null = null;
/** WEBP where the browser can encode it (Safari returns PNG instead). */
export function canEncodeWebp(): Promise<boolean> {
  webp ??= toBlob(canvasFrom(new Uint8Array(16), 2, 2), 'image/webp', 0.8).then(
    (b) => b?.type === 'image/webp',
  );
  return webp;
}

/**
 * Encodes a thumbnail or preview within its byte cap: WEBP (or JPEG), stepping quality down. The canvas
 * re-encode carries no metadata. Returns null if it can't fit.
 */
export async function encodeVariant(
  px: Uint8Array,
  w: number,
  h: number,
  kind: VariantKind,
): Promise<Blob | null> {
  const type = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';
  // WEBP keeps a transparent cut-out's alpha; the JPEG fallback puts it on white.
  const c = canvasFrom(type === 'image/jpeg' ? flattenOnWhite(px) : px, w, h);
  for (const q of [0.82, 0.72, 0.6, 0.5, 0.4]) {
    const b = await toBlob(c, type, q);
    if (b && b.size <= VARIANT_LIMITS[kind].maxBytes && (b.type === type || type === 'image/jpeg')) return b;
  }
  return null;
}

/** Full export: sRGB JPEG with no metadata (no location, no camera serial). */
export async function encodeJpeg(px: Uint8Array, w: number, h: number, quality: number): Promise<Blob> {
  const b = await toBlob(
    canvasFrom(flattenOnWhite(px), w, h),
    'image/jpeg',
    Math.min(1, Math.max(0.3, quality)),
  );
  if (!b) throw new Error('Couldn’t encode the JPEG');
  return b;
}

/** Phase 6: lossless PNG with alpha (transparent cut-outs), no metadata. */
export async function encodePng(px: Uint8Array, w: number, h: number): Promise<Blob> {
  const b = await toBlob(canvasFrom(px, w, h), 'image/png', 1);
  if (b?.type !== 'image/png') throw new Error('Couldn’t encode the PNG');
  return b;
}
