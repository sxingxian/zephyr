import { VARIANT_LIMITS, type VariantKind } from '@zephyr/shared/client';

export interface Variants {
  thumb?: Blob;
  preview?: Blob;
  /** Displayed size (after EXIF orientation) of the decoded source. */
  width?: number;
  height?: number;
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function encode(c: Canvas, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((res) => c.toBlob((b) => res(b), type, quality));
}

let webp: Promise<boolean> | null = null;
/** Whether this browser can encode WEBP (Safari can't, and silently returns PNG instead). */
function canEncodeWebp(): Promise<boolean> {
  webp ??= encode(makeCanvas(2, 2), 'image/webp', 0.8).then((b) => b?.type === 'image/webp');
  return webp;
}

/** Canvas transform for EXIF orientations 2–8 when the browser hasn't applied it (RAW previews). */
function orient(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  o: number,
  w: number,
  h: number,
) {
  // w and h are the output (display) size.
  switch (o) {
    case 2:
      ctx.setTransform(-1, 0, 0, 1, w, 0);
      break;
    case 3:
      ctx.setTransform(-1, 0, 0, -1, w, h);
      break;
    case 4:
      ctx.setTransform(1, 0, 0, -1, 0, h);
      break;
    case 5:
      ctx.setTransform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.setTransform(0, 1, -1, 0, w, 0);
      break;
    case 7:
      ctx.setTransform(0, -1, -1, 0, w, h);
      break;
    case 8:
      ctx.setTransform(0, -1, 1, 0, 0, h);
      break;
    default:
      break;
  }
}

async function render(
  bmp: ImageBitmap,
  kind: VariantKind,
  rotate: number,
  type: 'image/webp' | 'image/jpeg',
): Promise<Blob | undefined> {
  const swap = rotate >= 5 && rotate <= 8;
  const srcW = swap ? bmp.height : bmp.width;
  const srcH = swap ? bmp.width : bmp.height;
  const { maxEdge, maxBytes } = VARIANT_LIMITS[kind];
  // Try smaller sizes too, in case a very detailed image won't fit the byte cap at full size.
  for (const edge of [maxEdge, Math.round(maxEdge * 0.75)]) {
    const scale = Math.min(1, edge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return undefined;
    ctx.imageSmoothingQuality = 'high';
    orient(ctx, rotate, w, h);
    const dw = swap ? h : w;
    const dh = swap ? w : h;
    ctx.drawImage(bmp, 0, 0, dw, dh);
    for (const q of [0.82, 0.72, 0.6, 0.5]) {
      const b = await encode(c, type, q);
      if (b && b.size <= maxBytes && (b.type === type || type === 'image/jpeg')) return b;
    }
  }
  return undefined;
}

/**
 * Thumbnail (512 px) and preview (2048 px) made in the browser: WEBP where it can be encoded, JPEG otherwise.
 * `rotate` is the EXIF orientation to apply by hand (RAW previews); otherwise the browser applies it.
 */
export async function makeVariants(source: Blob, rotate = 1): Promise<Variants> {
  if (typeof createImageBitmap !== 'function') return {};
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(source, { imageOrientation: rotate > 1 ? 'none' : 'from-image' });
  } catch {
    return {};
  }
  try {
    const type = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';
    const swap = rotate >= 5 && rotate <= 8;
    const out: Variants = { width: swap ? bmp.height : bmp.width, height: swap ? bmp.width : bmp.height };
    out.thumb = await render(bmp, 'thumb', rotate, type);
    out.preview = await render(bmp, 'preview', rotate, type);
    return out;
  } finally {
    bmp.close();
  }
}
