/** Shared by the RAW worker and its tests. */
export const MAX_RAW_PIXELS = 100_000_000;

/**
 * LibRaw's WebAssembly memory can grow to 2 GB. A full-size decode holds, per pixel: the raw data (2 B),
 * LibRaw's working image (4 × 2 B) and its 16-bit RGB output (6 B); the file itself is also in memory.
 * Full-size decodes that would need more than 1.5 GB are refused, so the decoder never runs out of memory
 * part-way; the editor's half-size decode needs a quarter of that.
 */
export const RAW_FULL_BYTES_PER_PIXEL = 16;
export const RAW_WASM_BUDGET = 1_500_000_000;
export function fullDecodeFits(rawWidth: number, rawHeight: number, fileBytes = 0): boolean {
  return rawWidth * rawHeight * RAW_FULL_BYTES_PER_PIXEL + fileBytes <= RAW_WASM_BUDGET;
}

/** CR2, NEF and ARW are TIFF containers: "II*\0" (little-endian) or "MM\0*" (big-endian). */
export function isTiff(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  );
}

/** IEEE half float of a value in [0, 65504]. */
export function toHalf(v: number): number {
  if (v <= 0) return 0;
  if (v >= 65504) return 0x7bff;
  let e = Math.floor(Math.log2(v));
  let m = v / 2 ** e - 1;
  if (e < -14) {
    // subnormal
    return Math.round(v / 2 ** -24) & 0x3ff;
  }
  let mant = Math.round(m * 1024);
  if (mant === 1024) {
    mant = 0;
    e++;
  }
  m = mant;
  return ((e + 15) << 10) | m;
}

let lut: Uint16Array | null = null;
/** 16-bit linear sample (0…65535) → half float of sample / 65535. */
export function halfLut(): Uint16Array {
  if (lut) return lut;
  lut = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) lut[i] = toHalf(i / 65535);
  return lut;
}

/** sRGB-encoded 0–255 → linear 0–1. */
export function srgb8ToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * Default tone curve for RAW sources: the "camera look" a RAW gets before any edit, so it opens with the
 * contrast and highlight roll-off of a camera JPEG instead of flat linear data. It works on linear luminance
 * in log2 space around middle grey (0.18 stays 0.18):
 * - midtones and highlights get a contrast of `contrast` (log-log slope), shadows a gentler `toe`, blended
 *   smoothly so there is no kink at grey;
 * - above grey a tanh shoulder approaches white without reaching it, so bright areas roll off instead of
 *   clipping.
 * The shader in shaders.ts is generated from these same constants and formulas (`RAW_CURVE_GLSL`).
 */
export const RAW_CURVE = {
  grey: 0.18,
  contrast: 1.6,
  toe: 1.45,
  /** Saturation multiplier around luminance after the curve, like a camera's standard picture style. */
  saturation: 1.0,
} as const;
const WHITE_STOPS = Math.log2(1 / RAW_CURVE.grey);
/** tanh for z ≥ 0 written with exp, exactly as the shader computes it. */
const tanhPos = (z: number) => {
  const e = Math.exp(-2 * z);
  return (1 - e) / (1 + e);
};
const tanhAny = (z: number) => (z >= 0 ? tanhPos(z) : -tanhPos(-z));

/** Linear luminance (≥ 0) → linear luminance after the RAW base curve (0…<1). */
export function rawCurve(x: number): number {
  const { grey, contrast, toe } = RAW_CURVE;
  const s = Math.log2(Math.max(x, 1e-8) / grey);
  const u = s * (toe + (contrast - toe) * (0.5 + 0.5 * tanhAny(s)));
  const t = u > 0 ? WHITE_STOPS * tanhPos(u / WHITE_STOPS) : u;
  return grey * 2 ** t;
}
/** Inverse of rawCurve for y in (0, 1): bisection in log space (the curve is strictly increasing). */
export function rawCurveInverse(y: number): number {
  if (!(y > 0)) return 0;
  const target = Math.min(y, 0.999);
  let lo = Math.log2(1e-8);
  let hi = 20;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (rawCurve(2 ** mid) < target) lo = mid;
    else hi = mid;
  }
  return 2 ** ((lo + hi) / 2);
}

/** GLSL for the same curve and colour step (inserted into the develop shader). */
export const RAW_CURVE_GLSL = `
const float RAW_GREY = ${RAW_CURVE.grey.toFixed(6)};
const float RAW_CONTRAST = ${RAW_CURVE.contrast.toFixed(6)};
const float RAW_TOE = ${RAW_CURVE.toe.toFixed(6)};
const float RAW_SAT = ${RAW_CURVE.saturation.toFixed(6)};
const float RAW_WHITE = ${WHITE_STOPS.toFixed(8)};
float tanhPos(float z) { float e = exp(-2.0 * z); return (1.0 - e) / (1.0 + e); }
float tanhAny(float z) { return z >= 0.0 ? tanhPos(z) : -tanhPos(-z); }
float rawCurve(float x) {
  float s = log2(max(x, 1e-8) / RAW_GREY);
  float u = s * (RAW_TOE + (RAW_CONTRAST - RAW_TOE) * (0.5 + 0.5 * tanhAny(s)));
  float t = u > 0.0 ? RAW_WHITE * tanhPos(u / RAW_WHITE) : u;
  return RAW_GREY * exp2(t);
}
vec3 rawBase(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float f = rawCurve(l);
  c = l > 1e-8 ? c * (f / l) : vec3(f);
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = Y + (c - Y) * RAW_SAT;
  float mx = max(c.r, max(c.g, c.b));
  if (mx > 1.0) c = Y + (c - Y) * ((1.0 - Y) / (mx - Y));
  return max(c, vec3(0.0));
}
`;

/**
 * Base development of a RAW pixel (linear, after the baseline exposure): the tone curve applied to luminance
 * as a ratio (hue kept), the picture-style saturation, then a gamut fit that desaturates any channel above
 * white towards luminance instead of clipping it.
 */
export function rawBase(rgb: [number, number, number]): [number, number, number] {
  let [r, g, b] = rgb;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const f = rawCurve(l);
  if (l > 1e-8) {
    const k = f / l;
    r *= k;
    g *= k;
    b *= k;
  } else {
    r = f;
    g = f;
    b = f;
  }
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = Y + (r - Y) * RAW_CURVE.saturation;
  g = Y + (g - Y) * RAW_CURVE.saturation;
  b = Y + (b - Y) * RAW_CURVE.saturation;
  const mx = Math.max(r, g, b);
  if (mx > 1) {
    const k = (1 - Y) / (mx - Y);
    r = Y + (r - Y) * k;
    g = Y + (g - Y) * k;
    b = Y + (b - Y) * k;
  }
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

/**
 * Exposure the editor adds to a RAW's linear data (before the base curve) so it opens looking like the photo
 * as shot.
 *
 * With the camera's embedded JPEG: the lift that puts the RAW's median luminance, after the base curve, where
 * the JPEG's is (both in linear light), clamped to −1…+3 EV. That keeps a night scene dark and a bright beach
 * bright, as the photographer exposed them. Without one: lift the log-average so it lands at 0.1 after the
 * curve (clamped 0…+2 EV).
 *
 * `rawLuma` are linear 0–1 luminances sampled from the decode; `jpegLuma` linear luminances of the JPEG.
 */
export function rawBaselineEv(rawLuma: number[], jpegLuma: number[] | null): number {
  const round = (v: number) => Math.round(v * 100) / 100;
  if (jpegLuma && jpegLuma.length >= 64 && rawLuma.length >= 64) {
    const r = median(rawLuma);
    const j = median(jpegLuma);
    if (r > 1e-5 && j > 1e-5) return round(Math.min(3, Math.max(-1, Math.log2(rawCurveInverse(j) / r))));
  }
  let logSum = 0;
  for (const l of rawLuma) logSum += Math.log2(Math.max(l, 1e-4));
  const mean = rawLuma.length ? 2 ** (logSum / rawLuma.length) : 0.1;
  return round(Math.min(2, Math.max(0, Math.log2(rawCurveInverse(0.1) / mean))));
}
