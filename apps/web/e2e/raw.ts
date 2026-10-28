/**
 * Manual browser check: decodes a real camera RAW through the RAW worker (half and full size), renders it
 * through the editor pipeline, and returns timings plus images to compare with the camera's embedded JPEG.
 * Run by e2e/raw-check.mjs.
 */
import type { EditRecipe } from '@zephyr/shared/client';
import { fitLongEdge, outputSize } from '../src/lib/editor/geometry';
import { Renderer } from '../src/lib/editor/gl';
import { decodeRaw } from '../src/lib/editor/raw';
import { rawPreview } from '../src/lib/uploads/raw';

declare global {
  interface Window {
    __result?: unknown;
  }
}

function toDataUrl(px: Uint8Array, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  (c.getContext('2d') as CanvasRenderingContext2D).putImageData(
    new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, px.byteLength), w, h),
    0,
    0,
  );
  return c.toDataURL('image/png');
}
/** Luminance percentiles (sRGB 0–255 of linear luminance) and mean saturation of RGBA8 pixels. */
function stats(px: Uint8ClampedArray | Uint8Array): Record<string, number> {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const enc = (x: number) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  const ls: number[] = [];
  let sat = 0;
  let satN = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] as number;
    const g = px[i + 1] as number;
    const b = px[i + 2] as number;
    const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    ls.push(l);
    // Saturation only where it isn't dominated by noise (sRGB luminance ≥ 40).
    const mx = Math.max(r, g, b);
    if (l >= lin(40) && mx > 0) {
      sat += (mx - Math.min(r, g, b)) / mx;
      satN++;
    }
  }
  ls.sort((a, b) => a - b);
  const q = (p: number) => enc(ls[Math.min(ls.length - 1, Math.floor(p * ls.length))] as number);
  return {
    p5: q(0.05),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p99: q(0.99),
    p999: q(0.999),
    sat: satN ? Math.round((1000 * sat) / satN) / 1000 : 0,
  };
}
const mem = () =>
  (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

async function run() {
  const buf = await (await fetch('/__raw')).arrayBuffer();
  const out: Record<string, unknown> = { bytes: buf.byteLength };
  const pv = await rawPreview(new Blob([buf]));
  if (pv) {
    const bmp = await createImageBitmap(pv);
    const c = document.createElement('canvas');
    const k = 1200 / Math.max(bmp.width, bmp.height);
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    (c.getContext('2d') as CanvasRenderingContext2D).drawImage(bmp, 0, 0, c.width, c.height);
    out.preview = { w: bmp.width, h: bmp.height, png: c.toDataURL('image/png') };
    out.cameraStats = stats(
      (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data,
    );
  }
  const m0 = mem();
  let t = performance.now();
  const half = await decodeRaw(buf.slice(0), true);
  out.half = {
    ms: Math.round(performance.now() - t),
    w: half.width,
    h: half.height,
    baselineEv: half.baselineEv,
  };
  t = performance.now();
  const full = await decodeRaw(buf.slice(0), false);
  out.full = {
    ms: Math.round(performance.now() - t),
    w: full.width,
    h: full.height,
    baselineEv: full.baselineEv,
  };
  out.heapMb = Math.round((mem() - m0) / 1e6);

  const gl = new Renderer();
  const shots: Record<string, string> = {};
  const recipes: Record<string, EditRecipe> = {
    neutral: { v: 1 },
    edited: {
      v: 1,
      light: { exposure: 0.3, contrast: 15, highlights: -40, shadows: 30 },
      color: { temperature: 15, vibrance: 20 },
      mixer: { blue: { saturation: -20 } },
      detail: { sharpening: 30, noiseReduction: 20 },
      effects: { vignette: -20 },
      crop: { aspect: '4:5', rect: { x: 0.25, y: 0, w: 0.5, h: 1 }, angle: -3 },
    },
    mono: { v: 1, color: { saturation: -100 }, light: { contrast: 20 } },
  };
  t = performance.now();
  gl.setSource({ kind: 'half', data: half.data, width: half.width, height: half.height });
  out.uploadMs = Math.round(performance.now() - t);
  for (const [name, recipe] of Object.entries(recipes)) {
    const s = fitLongEdge(outputSize(recipe.crop, gl.sourceSize), 1200);
    t = performance.now();
    const px = gl.renderPixels({ recipe, width: s.width, height: s.height, baselineEv: half.baselineEv });
    shots[`half-${name}`] = toDataUrl(px, s.width, s.height);
    if (name === 'neutral') out.neutralStats = stats(px);
    out[`render-${name}-ms`] = Math.round(performance.now() - t);
  }
  // Full-size decode rendered with the half-size baseline (what export does), downscaled for viewing.
  gl.setSource({ kind: 'half', data: full.data, width: full.width, height: full.height });
  const s = fitLongEdge(outputSize(undefined, gl.sourceSize), 1200);
  shots['full-neutral'] = toDataUrl(
    gl.renderPixels({ recipe: { v: 1 }, width: s.width, height: s.height, baselineEv: half.baselineEv }),
    s.width,
    s.height,
  );
  gl.dispose();
  out.shots = shots;
  return out;
}
run()
  .then((r) => {
    window.__result = r;
  })
  .catch((e) => {
    window.__result = { error: String(e?.stack ?? e) };
  });
