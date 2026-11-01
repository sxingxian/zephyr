import { type EditRecipe, normalizeRecipe } from '@zephyr/shared/client';
import { fromSrgb, rgbToHsv } from '../editor/develop';
import { apply } from '../editor/geometry';
import { type AiProxy, developProxy, resizeProxy } from './proxy';
import { type DisplayStats, displayStats, lumaOf } from './stats';

/**
 * Auto-enhance (phase 6, on the device). Chooses exposure, white balance, contrast, highlights, shadows,
 * whites, blacks and vibrance for one photo, and with skin tones on, small red/orange colour-mixer nudges for
 * the faces it was given. Everything lands on the normal sliders: the result is an ordinary recipe that can
 * be fine-tuned or undone. Deterministic for the same proxy and options.
 */
export interface FaceBox {
  /** Normalised box in the photo (source uv, 0–1). */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EnhanceOptions {
  /** 0–100, default 70: scales every change. */
  strength?: number;
  /** Optimise skin tones (needs `faces`), default on. */
  skin?: boolean;
  /** Faces found on the photo (detectFaces), for skin tones. */
  faces?: FaceBox[];
}

/** Display luminance a well-exposed photo's median sits at (≈ middle grey). */
export const TARGET_MEDIAN = 0.46;
/** Proxy size the solver works on (the 256 px proxy is reduced to this). */
const SOLVE_EDGE = 160;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number) => Math.round(x);

export function statsOf(p: AiProxy, r: EditRecipe): DisplayStats {
  return displayStats(developProxy(p, r));
}

/** Sets light.exposure (−3…3 EV by default) so the median display luminance reaches `target` (bisection). */
export function solveExposure(
  p: AiProxy,
  r: EditRecipe,
  target = TARGET_MEDIAN,
  lo = -3,
  hi = 3,
  iterations = 11,
): number {
  const at = (ev: number) => statsOf(p, { ...r, light: { ...r.light, exposure: ev } }).quantile(0.5);
  if (at(lo) >= target) return lo;
  if (at(hi) <= target) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2;
    if (at(m) < target) a = m;
    else b = m;
  }
  return Math.round(((a + b) / 2) * 100) / 100;
}

/**
 * Grey-world white balance on near-neutral pixels, as temperature and tint (−60…60). It inverts
 * `whiteBalance()` in develop.ts: temperature scales red by e^{0.32t} and blue by e^{−0.32t}, tint scales green
 * by e^{−0.22g}. Corrections are applied at 80 % (a scene's own colour cast is often intended).
 */
export function solveWhiteBalance(p: AiProxy, r: EditRecipe): { temperature: number; tint: number } {
  const disp = developProxy(p, r);
  const n = disp.length / 3;
  const pick = (strict: boolean) => {
    let R = 0;
    let G = 0;
    let B = 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const dr = disp[i * 3] as number;
      const dg = disp[i * 3 + 1] as number;
      const db = disp[i * 3 + 2] as number;
      const y = lumaOf(dr, dg, db);
      if (y < 0.05 || y > (strict ? 0.85 : 0.92)) continue;
      if (strict) {
        const mx = Math.max(dr, dg, db);
        if ((mx - Math.min(dr, dg, db)) / mx > 0.3) continue;
      }
      R += fromSrgb(dr);
      G += fromSrgb(dg);
      B += fromSrgb(db);
      k++;
    }
    return { R, G, B, k };
  };
  let s = pick(true);
  if (s.k < n * 0.02) s = pick(false);
  if (s.k === 0 || s.R <= 0 || s.G <= 0 || s.B <= 0) return { temperature: 0, tint: 0 };
  const t = Math.log(s.B / s.R) / 0.64;
  const g = Math.log(s.G / Math.sqrt(s.R * s.B)) / 0.22;
  const temperature = clamp(round(100 * t * 0.8), -60, 60);
  const tint = clamp(round(100 * g * 0.8), -60, 60);
  return { temperature: Math.abs(temperature) < 3 ? 0 : temperature, tint: Math.abs(tint) < 3 ? 0 : tint };
}

/** Highlights, shadows, whites, blacks and contrast from the histogram of the exposed photo. */
export function toneFrom(s: DisplayStats) {
  const highlights = -clamp((s.above(0.92) - 0.01) * 600, 0, 60);
  const shadows = clamp((s.below(0.08) - 0.02) * 400, 0, 50);
  const p995 = s.quantile(0.995);
  const p005 = s.quantile(0.005);
  const whites = p995 < 0.93 ? clamp((0.96 - p995) * 160, 0, 40) : 0;
  const blacks = p005 > 0.05 ? -clamp((p005 - 0.03) * 220, 0, 35) : 0;
  const iqr = s.quantile(0.75) - s.quantile(0.25);
  const contrast = clamp((0.3 - iqr) * 110, -15, 25);
  return {
    highlights: round(highlights),
    shadows: round(shadows),
    whites: round(whites),
    blacks: round(blacks),
    contrast: round(contrast),
  };
}

/** Skin-coloured pixels inside the faces (YCbCr skin range, the inner 60 % of each box). */
export function skinPixels(p: AiProxy, disp: Float32Array, faces: FaceBox[]): number[] {
  const idx: number[] = [];
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const [u, v] = apply(p.toSource, (x + 0.5) / p.width, (y + 0.5) / p.height);
      const inFace = faces.some(
        (f) => u >= f.x + f.w * 0.2 && u <= f.x + f.w * 0.8 && v >= f.y + f.h * 0.2 && v <= f.y + f.h * 0.8,
      );
      if (!inFace) continue;
      const i = y * p.width + x;
      const R = (disp[i * 3] as number) * 255;
      const G = (disp[i * 3 + 1] as number) * 255;
      const B = (disp[i * 3 + 2] as number) * 255;
      const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      const cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) idx.push(i);
    }
  return idx;
}

/**
 * Colour-mixer nudges (red and orange, each ±15) that move skin toward a natural hue band (15–35°), calm
 * over-saturated skin and lift dark skin a little. Null when there's too little skin to judge.
 */
export function skinNudge(
  p: AiProxy,
  disp: Float32Array,
  faces: FaceBox[],
): { hue: number; saturation: number; luminance: number } | null {
  const idx = skinPixels(p, disp, faces);
  if (idx.length < 30) return null;
  let sx = 0;
  let sy = 0;
  let ss = 0;
  let sv = 0;
  for (const i of idx) {
    const [h, s, v] = rgbToHsv(disp[i * 3] as number, disp[i * 3 + 1] as number, disp[i * 3 + 2] as number);
    sx += Math.cos((h * Math.PI) / 180);
    sy += Math.sin((h * Math.PI) / 180);
    ss += s;
    sv += v;
  }
  let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (hue > 180) hue -= 360;
  const sat = ss / idx.length;
  const val = sv / idx.length;
  const d = hue < 15 ? 15 - hue : hue > 35 ? 35 - hue : 0;
  return {
    hue: clamp(round((d / 30) * 100), -15, 15),
    saturation: sat > 0.6 ? clamp(round((0.6 / sat - 1) * 100), -15, 0) : sat < 0.2 ? 6 : 0,
    luminance: val < 0.5 ? clamp(round((0.55 - val) * 50), 0, 15) : 0,
  };
}

export function autoEnhance(
  proxy: AiProxy,
  recipe: EditRecipe | null,
  opts: EnhanceOptions = {},
): EditRecipe {
  const k = clamp(opts.strength ?? 70, 0, 100) / 100;
  const base = normalizeRecipe(recipe);
  const p = resizeProxy(proxy, SOLVE_EDGE);
  // Auto-enhance owns the light and colour sections: start them from neutral.
  const work: EditRecipe = { ...base, light: undefined, color: undefined };
  const wb = solveWhiteBalance(p, work);
  const withWb: EditRecipe = { ...work, color: { temperature: wb.temperature, tint: wb.tint } };
  const ev1 = solveExposure(p, withWb, TARGET_MEDIAN, -3, 4);
  const tone = toneFrom(statsOf(p, { ...withWb, light: { exposure: ev1 } }));
  const toned: EditRecipe = { ...withWb, light: { ...tone, exposure: ev1 } };
  const exposure = solveExposure(p, toned, TARGET_MEDIAN, -3, 4);
  const ms = statsOf(p, { ...toned, light: { ...tone, exposure } }).meanSat;
  const vibrance = ms < 0.4 ? clamp(round(8 + (0.35 - ms) * 25), 8, 15) : 0;
  const s = (v: number) => round(v * k);
  let out: EditRecipe = {
    ...base,
    light: {
      exposure: Math.round(exposure * k * 100) / 100,
      contrast: s(tone.contrast),
      highlights: s(tone.highlights),
      shadows: s(tone.shadows),
      whites: s(tone.whites),
      blacks: s(tone.blacks),
    },
    color: { temperature: s(wb.temperature), tint: s(wb.tint), vibrance: s(vibrance) },
  };
  if ((opts.skin ?? true) && opts.faces?.length) {
    const nudge = skinNudge(proxy, developProxy(proxy, out), opts.faces);
    if (nudge) {
      const ch = { hue: s(nudge.hue), saturation: s(nudge.saturation), luminance: s(nudge.luminance) };
      out = { ...out, mixer: { ...out.mixer, red: ch, orange: ch } };
    }
  }
  return normalizeRecipe(out);
}

const SLIDER_SECTIONS = ['light', 'color', 'mixer', 'detail', 'effects'] as const;
function leaves(r: EditRecipe): Map<string, number> {
  const out = new Map<string, number>();
  const n = normalizeRecipe(r) as unknown as Record<string, unknown>;
  for (const sec of SLIDER_SECTIONS) {
    const o = n[sec] as Record<string, unknown> | undefined;
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') out.set(`${sec}.${k}`, v);
      else if (v && typeof v === 'object')
        for (const [k2, v2] of Object.entries(v as Record<string, number>)) out.set(`${sec}.${k}.${k2}`, v2);
    }
  }
  return out;
}
/** How many sliders differ between two recipes ("Auto-enhance changed 7 sliders"). */
export function changedSliders(before: EditRecipe | null, after: EditRecipe | null): number {
  const a = leaves(before ?? { v: 1 });
  const b = leaves(after ?? { v: 1 });
  let n = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) if ((a.get(key) ?? 0) !== (b.get(key) ?? 0)) n++;
  return n;
}
