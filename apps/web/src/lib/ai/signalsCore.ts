import type { PhotoSignals } from '@zephyr/shared/client';

/**
 * Quality signals (phase 6, on the device), measured on a photo's untouched 512 px thumbnail: a 64-bit DCT
 * perceptual hash (duplicates and bursts), the variance of the Laplacian (blur), the mean brightness, and the
 * Night verdict. Pure functions here; `measureSignals` (signals.ts) runs them in a Web Worker.
 */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Luminance 0–255 of every pixel (Rec. 709 weights on the encoded values). */
export function lumaPlane(img: Rgba): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] =
      0.2126 * (img.data[i * 4] as number) +
      0.7152 * (img.data[i * 4 + 1] as number) +
      0.0722 * (img.data[i * 4 + 2] as number);
  return out;
}

/** Area-average resize of a luminance plane to w × h. */
function resizePlane(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = (y * sh) / h;
    const y1 = ((y + 1) * sh) / h;
    for (let x = 0; x < w; x++) {
      const x0 = (x * sw) / w;
      const x1 = ((x + 1) * sw) / w;
      let s = 0;
      let a = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          s += (src[Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)] as number) * wx * wy;
          a += wx * wy;
        }
      }
      out[y * w + x] = a ? s / a : 0;
    }
  }
  return out;
}

const DCT_N = 32;
const COS = (() => {
  const t = new Float64Array(DCT_N * DCT_N);
  for (let u = 0; u < DCT_N; u++)
    for (let x = 0; x < DCT_N; x++) t[u * DCT_N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
  return t;
})();

/**
 * pHash: the image as 32×32 grey, its 2-D DCT, the 8×8 lowest frequencies; each bit says whether a
 * coefficient is above the median of the 63 non-DC ones (the DC term's bit is then set the same way).
 * Bits are row-major (u = row), most significant first. 16 lowercase hex characters.
 */
export function phash(img: Rgba): string {
  const g = resizePlane(lumaPlane(img), img.width, img.height, DCT_N, DCT_N);
  const coef = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < DCT_N; y++) {
        let row = 0;
        for (let x = 0; x < DCT_N; x++) row += (g[y * DCT_N + x] as number) * (COS[v * DCT_N + x] as number);
        s += row * (COS[u * DCT_N + y] as number);
      }
      coef[u * 8 + v] = s;
    }
  const ac = Array.from(coef.subarray(1)).sort((a, b) => a - b);
  const med = ((ac[30] as number) + (ac[31] as number)) / 2;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = (coef[i] as number) > med ? 1 : 0;
    if (i < 32) hi = (hi << 1) | bit;
    else lo = (lo << 1) | bit;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Variance of the 3×3 Laplacian of luminance (0–255 scale), capped at 65025. Low means blurry. */
export function laplacianVariance(img: Rgba): number {
  const { width: w, height: h } = img;
  if (w < 3 || h < 3) return 0;
  const l = lumaPlane(img);
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        (l[i - 1] as number) +
        (l[i + 1] as number) +
        (l[i - w] as number) +
        (l[i + w] as number) -
        4 * (l[i] as number);
      s += v;
      s2 += v * v;
      n++;
    }
  const mean = s / n;
  return Math.min(65025, Math.round((s2 / n - mean * mean) * 100) / 100);
}

/** Local hour (0–23) of an ISO 8601 time as written (the photo's own clock), or null. */
export function localHour(iso: string | null | undefined): number | null {
  const m = /T(\d{2}):/.exec(iso ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Night: dark overall with bright points (city lights, a moon), or simply dark and taken at night by the
 * photo's own clock.
 */
export function isNight(meanBrightness: number, p99: number, hour: number | null): boolean {
  if (meanBrightness < 0.18 && p99 > 0.6) return true;
  return meanBrightness < 0.28 && hour !== null && (hour >= 19 || hour < 6);
}

export function computeSignals(id: string, img: Rgba, takenAt: string | null): PhotoSignals {
  const l = lumaPlane(img);
  let sum = 0;
  for (const v of l) sum += v;
  const brightness = l.length ? sum / l.length / 255 : 0;
  const sorted = Float32Array.from(l).sort();
  const p99 = (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0) / 255;
  return {
    id,
    phash: phash(img),
    sharpness: laplacianVariance(img),
    brightness: Math.round(brightness * 10_000) / 10_000,
    night: isNight(brightness, p99, localHour(takenAt)),
  };
}
