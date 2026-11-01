import { fromSrgb } from '../editor/develop';

/** Statistics of a developed (display-encoded sRGB, 0–1, 3 per pixel) image, for the on-device AI. */
export interface DisplayStats {
  n: number;
  /** Display luminance (Rec. 709 weights on the encoded values), sorted ascending. */
  sorted: Float32Array;
  mean: number;
  /** Mean HSV saturation of the display values. */
  meanSat: number;
  quantile(q: number): number;
  /** Share of pixels with luminance above t. */
  above(t: number): number;
  /** Share of pixels with luminance below t. */
  below(t: number): number;
}

export const lumaOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function displayStats(disp: Float32Array): DisplayStats {
  const n = disp.length / 3;
  const l = new Float32Array(n);
  let sum = 0;
  let sat = 0;
  for (let i = 0; i < n; i++) {
    const r = disp[i * 3] as number;
    const g = disp[i * 3 + 1] as number;
    const b = disp[i * 3 + 2] as number;
    const y = lumaOf(r, g, b);
    l[i] = y;
    sum += y;
    const mx = Math.max(r, g, b);
    sat += mx > 1e-4 ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const sorted = l.sort();
  const idx = (t: number) => {
    // First index with value > t (upper bound).
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    n,
    sorted,
    mean: sum / Math.max(1, n),
    meanSat: sat / Math.max(1, n),
    quantile: (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))] as number,
    above: (t) => (n - idx(t)) / Math.max(1, n),
    below: (t) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((sorted[mid] as number) < t) lo = mid + 1;
        else hi = mid;
      }
      return lo / Math.max(1, n);
    },
  };
}

// ------------------------------------------------------------ CIE Lab (D65)
const F = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
/** Linear sRGB → CIE Lab (D65 white). */
export function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fx = F(x);
  const fy = F(y);
  const fz = F(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export interface LabStats {
  meanL: number;
  sdL: number;
  meanA: number;
  meanB: number;
  /** Mean chroma (√(a² + b²)). */
  chroma: number;
}

/** Lab mean and spread of a developed (display-encoded) image. */
export function labStats(disp: Float32Array): LabStats {
  const n = disp.length / 3;
  let sL = 0;
  let sL2 = 0;
  let sA = 0;
  let sB = 0;
  let sC = 0;
  for (let i = 0; i < n; i++) {
    const [L, a, b] = linearToLab(
      fromSrgb(disp[i * 3] as number),
      fromSrgb(disp[i * 3 + 1] as number),
      fromSrgb(disp[i * 3 + 2] as number),
    );
    sL += L;
    sL2 += L * L;
    sA += a;
    sB += b;
    sC += Math.hypot(a, b);
  }
  const meanL = sL / n;
  return {
    meanL,
    sdL: Math.sqrt(Math.max(0, sL2 / n - meanL * meanL)),
    meanA: sA / n,
    meanB: sB / n,
    chroma: sC / n,
  };
}
