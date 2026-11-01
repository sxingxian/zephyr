import { type EditRecipe, HUE_BANDS, normalizeRecipe } from '@zephyr/shared/client';
import { rawBase, rawCurve } from './rawCommon';

/**
 * The develop maths, written once in TypeScript as the reference for the GLSL in shaders.ts. Both read the
 * same `DevelopParams`, built by `developParams`. A browser test renders a small image through the shader
 * and checks every pixel against `developPixel` (within 2/255).
 *
 * Working space: linear-light Rec. 709 / sRGB primaries. Tone and colour-mixer steps run on a perceptual
 * (gamma 2.2) encoding of luminance or colour, then go back to linear.
 *
 * RAW sources are scene-linear: they first get their baseline exposure and the RAW base curve (rawCommon.ts),
 * which turns them into the same display-referred linear light a decoded JPEG gives. Every slider then acts
 * on that, so the same recipe behaves the same on a RAW and on a JPEG.
 */
export interface DevelopParams {
  /** RAW baseline exposure multiplier (2^baselineEv), applied before the base curve. 1 for other sources. */
  baseGain: number;
  /** Apply the RAW base curve (RAW sources only). */
  raw: boolean;
  /** The recipe's exposure multiplier (2^ev). */
  gain: number;
  /** White-balance channel multipliers, luminance-normalised. */
  wb: [number, number, number];
  highlights: number; // −1…1
  shadows: number;
  whites: number;
  blacks: number;
  contrast: number;
  vibrance: number;
  saturation: number;
  /** Per band: hue shift (−1…1 → ±30°), saturation (−1…1), luminance (−1…1). */
  mixer: [number, number, number][];
  vignette: number; // −1…1
  /** Output aspect (width / height), for a round vignette. */
  aspect: number;
}

export const NEUTRAL: DevelopParams = {
  baseGain: 1,
  raw: false,
  gain: 1,
  wb: [1, 1, 1],
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  contrast: 0,
  vibrance: 0,
  saturation: 0,
  mixer: HUE_BANDS.map(() => [0, 0, 0] as [number, number, number]),
  vignette: 0,
  aspect: 1.5,
};

const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];
export const luma = (r: number, g: number, b: number) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

/** White balance as channel gains from relative temperature and tint (−100…100), keeping luminance. */
export function whiteBalance(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100;
  const g = tint / 100;
  const r = Math.exp(0.32 * t);
  const b = Math.exp(-0.32 * t);
  const gg = Math.exp(-0.22 * g);
  const l = luma(r, gg, b);
  return [r / l, gg / l, b / l];
}

export function developParams(
  recipe: EditRecipe | null | undefined,
  aspect = 1.5,
  baselineEv = 0,
  raw = false,
): DevelopParams {
  const r = normalizeRecipe(recipe);
  const L = r.light ?? {};
  const C = r.color ?? {};
  const pct = (v: number | undefined) => (v ?? 0) / 100;
  return {
    baseGain: 2 ** baselineEv,
    raw,
    gain: 2 ** (L.exposure ?? 0),
    wb: whiteBalance(C.temperature ?? 0, C.tint ?? 0),
    highlights: pct(L.highlights),
    shadows: pct(L.shadows),
    whites: pct(L.whites),
    blacks: pct(L.blacks),
    contrast: pct(L.contrast),
    vibrance: pct(C.vibrance),
    saturation: pct(C.saturation),
    mixer: HUE_BANDS.map((b) => {
      const m = r.mixer?.[b];
      return [pct(m?.hue), pct(m?.saturation), pct(m?.luminance)] as [number, number, number];
    }),
    vignette: pct(r.effects?.vignette),
    aspect,
  };
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const encodeG = (x: number) => Math.max(0, x) ** (1 / 2.2);
const decodeG = (x: number) => Math.max(0, x) ** 2.2;

/** sRGB transfer functions (exact piecewise). */
export const toSrgb = (x: number) => {
  const c = clamp(x);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
export const fromSrgb = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** Tone curve on perceptual luminance y (0…≈1). `base` is the blurred local luminance, also perceptual. */
export function tone(y: number, base: number, p: DevelopParams): number {
  // Local masks: mostly from the neighbourhood, a little from the pixel itself, so edges don't halo.
  const m = 0.7 * base + 0.3 * y;
  const wH = smoothstep(0.45, 0.95, m);
  const wS = 1 - smoothstep(0.05, 0.55, m);
  // Highlights and shadows: up to ±1.2 stops in their regions, applied as a gain on linear luminance.
  const stops = 1.2 * (p.highlights * wH + p.shadows * wS);
  let out = encodeG(decodeG(y) * 2 ** stops);
  // Whites and blacks move the ends of the curve.
  out += 0.22 * p.whites * smoothstep(0.55, 1.0, out);
  out += 0.16 * p.blacks * (1 - smoothstep(0.0, 0.4, out));
  // Contrast: pivot at middle grey (0.18 linear ≈ 0.459 perceptual).
  const pivot = 0.4587;
  const k = 1 + 0.6 * p.contrast;
  out = pivot + (out - pivot) * k;
  return Math.max(0, out);
}

const BAND_HUES = [0, 30, 60, 120, 180, 240, 270, 300]; // degrees: red … magenta

/** Smooth weight of a hue (degrees) for each band: a cosine bump reaching zero at the neighbouring bands. */
export function bandWeights(h: number): number[] {
  const n = BAND_HUES.length;
  const w = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = BAND_HUES[i] as number;
    const prev = BAND_HUES[(i + n - 1) % n] as number;
    const next = BAND_HUES[(i + 1) % n] as number;
    let d = h - c;
    d = ((((d + 180) % 360) + 360) % 360) - 180;
    const span = d >= 0 ? (next - c + 360) % 360 || 360 : (c - prev + 360) % 360 || 360;
    const x = Math.abs(d) / span;
    w[i] = x < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * x) : 0;
  }
  return w;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const i = Math.floor(hh);
  const t: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = t[Math.min(5, i)] as [number, number, number];
  return [r + m, g + m, b + m];
}

/** Baseline exposure, then (RAW only) the base curve: the photo as it looks before any edit. */
export function developBase(rgb: [number, number, number], p: DevelopParams): [number, number, number] {
  const c: [number, number, number] = [rgb[0] * p.baseGain, rgb[1] * p.baseGain, rgb[2] * p.baseGain];
  return p.raw ? rawBase(c) : c;
}

/**
 * Develops one pixel. `rgb` is linear light after geometry, `localLum` the blurred linear luminance of the
 * neighbourhood (before exposure), `u, v` the pixel's position over the whole output (0–1, for the vignette).
 * Returns linear light, ready for detail and sRGB encoding.
 */
export function developPixel(
  rgb: [number, number, number],
  localLum: number,
  u: number,
  v: number,
  p: DevelopParams,
): [number, number, number] {
  let [r, g, b] = developBase(rgb, p);
  // The neighbourhood goes through the same base development (on its luminance).
  const lum0 = localLum * p.baseGain;
  const local = p.raw ? rawCurve(lum0) : lum0;
  // Exposure and white balance.
  r *= p.gain * p.wb[0];
  g *= p.gain * p.wb[1];
  b *= p.gain * p.wb[2];
  // Tone on perceptual luminance, applied as a ratio so hue is kept.
  const lin = luma(r, g, b);
  const y = encodeG(lin);
  const base = encodeG(local * p.gain);
  const y2 = tone(y, base, p);
  const ratio = lin > 1e-5 ? decodeG(y2) / lin : decodeG(y2) / 1e-5;
  if (lin > 1e-5) {
    r *= ratio;
    g *= ratio;
    b *= ratio;
  } else {
    const add = decodeG(y2);
    r = add;
    g = add;
    b = add;
  }
  // Vibrance (more on muted colours) and saturation, around luminance.
  const Y = luma(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx > 1e-5 ? (mx - mn) / mx : 0;
  const k = Math.max(0, (1 + p.saturation) * (1 + p.vibrance * (1 - sat)));
  r = Y + (r - Y) * k;
  g = Y + (g - Y) * k;
  b = Y + (b - Y) * k;
  // Colour mixer, in perceptual HSV.
  if (p.mixer.some(([a, s, l]) => a || s || l)) {
    const [h, s, val] = rgbToHsv(encodeG(r), encodeG(g), encodeG(b));
    const w = bandWeights(h);
    let dh = 0;
    let ds = 0;
    let dl = 0;
    for (let i = 0; i < w.length; i++) {
      const m = p.mixer[i] as [number, number, number];
      const wi = w[i] as number;
      dh += wi * m[0];
      ds += wi * m[1];
      dl += wi * m[2];
    }
    const s2 = clamp(s * (1 + ds));
    const v2 = Math.max(0, val * (1 + 0.5 * dl * s));
    const [er, eg, eb] = hsvToRgb(h + 30 * dh, s2, v2);
    r = decodeG(er);
    g = decodeG(eg);
    b = decodeG(eb);
  }
  // Vignette: an ellipse over the crop, darkening (negative) or lightening (positive) towards the corners.
  if (p.vignette) {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
    const f = 1 + 0.85 * p.vignette * smoothstep(0.35, 1.0, d);
    r *= f;
    g *= f;
    b *= f;
  }
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

/** Convenience for tests: develop an sRGB 8-bit pixel with a flat neighbourhood, back to sRGB 8-bit. */
export function developSrgb8(
  px: [number, number, number],
  p: DevelopParams,
  u = 0.5,
  v = 0.5,
  localLum?: number,
): [number, number, number] {
  const lin: [number, number, number] = [fromSrgb(px[0] / 255), fromSrgb(px[1] / 255), fromSrgb(px[2] / 255)];
  const out = developPixel(lin, localLum ?? luma(...lin), u, v, p);
  return out.map((c) => Math.round(toSrgb(c) * 255)) as [number, number, number];
}

// ------------------------------------------------------------ cut-out composite (phase 6)
/**
 * Parameters of the composite pass, from the recipe's `cutout` and the mask. The shader (COMPOSITE in
 * shaders.ts) and `compositePixel` read the same values.
 */
export interface CompositeParams {
  /** 1: transparent background (alpha = mask), 2: solid colour. */
  mode: 1 | 2;
  /** Background colour, linear light. */
  bg: [number, number, number];
  /** Edge shift as an exponent on the mask: < 1 pushes the edge out, > 1 pulls it in. */
  gamma: number;
  /** Mip level the mask is sampled at (edge softness, and no aliasing when the output is smaller). */
  lod: number;
  /** 0: none, 1: soft drop shadow, 2: contact shadow. */
  shadow: 0 | 1 | 2;
  /** 0–1. */
  strength: number;
  /** Soft shadow: how far below the subject (source uv). */
  offset: number;
  /** Contact shadow ellipse: centre x, bottom y, radius x, radius y (source uv). */
  contact: [number, number, number, number];
}

const hexToLinear = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [fromSrgb(((n >> 16) & 255) / 255), fromSrgb(((n >> 8) & 255) / 255), fromSrgb((n & 255) / 255)];
};

/**
 * `maskEdge`: the mask's long edge in pixels. `outEdgeInSource`: how many output pixels span the source's long
 * edge (output long edge ÷ the crop's share of the source), so a small render samples a smaller mip.
 */
export function compositeParams(
  cutout: {
    bg: string;
    color?: string;
    shadow?: string;
    shadowStrength?: number;
    softness?: number;
    shift?: number;
  },
  maskEdge: number,
  outEdgeInSource: number,
  contact: [number, number, number, number] | null,
): CompositeParams {
  const soft = cutout.softness ?? 0;
  const softLod = Math.log2(1 + (soft * maskEdge) / 2048);
  const minLod = Math.log2(Math.max(1, maskEdge / Math.max(1, outEdgeInSource)));
  const mode = cutout.bg === 'transparent' ? 1 : 2;
  const shadow =
    mode === 2 && cutout.shadow === 'soft' ? 1 : mode === 2 && cutout.shadow === 'contact' && contact ? 2 : 0;
  return {
    mode,
    bg: cutout.bg === 'color' && cutout.color ? hexToLinear(cutout.color) : [1, 1, 1],
    gamma: 2 ** (-(cutout.shift ?? 0) / 5),
    lod: Math.max(softLod, minLod),
    shadow,
    strength: shadow ? clamp((cutout.shadowStrength ?? 0) / 100) : 0,
    offset: 0.025,
    contact: contact ?? [0.5, 1, 0.1, 0.025],
  };
}

/** Bilinear sample of a one-byte-per-pixel image at uv (texel centres at +0.5, clamped edges), 0–1. */
export function sampleBilinear(l: { w: number; h: number; data: Uint8Array }, u: number, v: number): number {
  const x = clamp(u) * l.w - 0.5;
  const y = clamp(v) * l.h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) =>
    l.data[Math.min(l.h - 1, Math.max(0, yy)) * l.w + Math.min(l.w - 1, Math.max(0, xx))] as number;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return (top * (1 - fy) + bot * fy) / 255;
}

/** Trilinear sample across a mip chain (what textureLod does with LINEAR_MIPMAP_LINEAR). */
export function sampleMip(
  levels: { w: number; h: number; data: Uint8Array }[],
  u: number,
  v: number,
  lod: number,
): number {
  const top = levels.length - 1;
  const l = clamp(lod, 0, top);
  const a = Math.floor(l);
  const f = l - a;
  const s0 = sampleBilinear(levels[a] as (typeof levels)[number], u, v);
  if (f === 0 || a >= top) return s0;
  return s0 * (1 - f) + sampleBilinear(levels[a + 1] as (typeof levels)[number], u, v) * f;
}

/** The shadow amount at source uv (0–1) from the blurred mask or the contact ellipse. */
export function shadowAt(
  p: CompositeParams,
  blurSample: (u: number, v: number) => number,
  u: number,
  v: number,
): number {
  if (p.shadow === 1) return blurSample(u, clamp(v - p.offset));
  if (p.shadow === 2) {
    const dx = (u - p.contact[0]) / p.contact[2];
    const dy = (v - p.contact[1]) / p.contact[3];
    return Math.exp(-(dx * dx + dy * dy));
  }
  return 0;
}

/**
 * Composites one developed pixel (sRGB 8-bit) over the background. `m` is the mask sample (0–1), `sh` the
 * shadow amount. Returns RGBA 8-bit: for a transparent background the photo's colour with alpha from the mask.
 */
export function compositePixel(
  px: [number, number, number],
  m: number,
  sh: number,
  p: CompositeParams,
): [number, number, number, number] {
  const a = clamp(m) ** p.gamma;
  if (p.mode === 1) return [px[0], px[1], px[2], Math.round(a * 255)];
  const k = 1 - p.strength * 0.6 * sh;
  const out = [0, 1, 2].map((i) => {
    const photo = fromSrgb((px[i] as number) / 255);
    const bg = (p.bg[i] as number) * k;
    return Math.round(toSrgb(bg + (photo - bg) * a) * 255);
  });
  return [out[0] as number, out[1] as number, out[2] as number, 255];
}
