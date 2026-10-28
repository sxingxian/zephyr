/** Shared by the RAW worker and its tests. */
export const MAX_RAW_PIXELS = 100_000_000;

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
 * Exposure the editor adds to a RAW's linear data so it opens looking like the photo as shot.
 *
 * With the camera's embedded JPEG: the lift that puts the RAW's median luminance where the JPEG's is (both
 * in linear light), clamped to −1…+3 EV. That keeps a night scene dark and a bright beach bright, as the
 * photographer exposed them. Without one: lift the log-average to 0.1 (clamped 0…+2 EV).
 *
 * `rawLuma` are linear 0–1 luminances sampled from the decode; `jpegLuma` linear luminances of the JPEG.
 */
export function rawBaselineEv(rawLuma: number[], jpegLuma: number[] | null): number {
  const round = (v: number) => Math.round(v * 100) / 100;
  if (jpegLuma && jpegLuma.length >= 64 && rawLuma.length >= 64) {
    const r = median(rawLuma);
    const j = median(jpegLuma);
    if (r > 1e-5 && j > 1e-5) return round(Math.min(3, Math.max(-1, Math.log2(j / r))));
  }
  let logSum = 0;
  for (const l of rawLuma) logSum += Math.log2(Math.max(l, 1e-4));
  const mean = rawLuma.length ? 2 ** (logSum / rawLuma.length) : 0.1;
  return round(Math.min(2, Math.max(0, Math.log2(0.1 / mean))));
}
