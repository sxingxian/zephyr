import type { EditRecipe } from '@zephyr/shared/client';
import { describe, expect, it } from 'vitest';
import { fromSrgb } from '../editor/develop';
import { autoEnhance, changedSliders, statsOf } from './enhance';
import { hdrBalance } from './hdr';
import { colorMatch, labDistance } from './match';
import { type AiProxy, developProxy, type LinearImage, proxyFromLinear } from './proxy';
import { labStats } from './stats';

/** A synthetic scene: a sky-to-ground gradient with a few objects, in linear light. */
function scene(
  w: number,
  h: number,
  f: (r: number, g: number, b: number, x: number, y: number) => [number, number, number],
): LinearImage {
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let r = 0.55 - 0.35 * t;
      let g = 0.5 - 0.3 * t;
      let b = 0.6 - 0.45 * t;
      if (x > w * 0.2 && x < w * 0.4 && y > h * 0.5) [r, g, b] = [0.4, 0.15, 0.08]; // a red object
      if (x > w * 0.6 && x < w * 0.8 && y > h * 0.3 && y < h * 0.7) [r, g, b] = [0.18, 0.18, 0.18]; // grey card
      const i = (y * w + x) * 3;
      const o = f(r, g, b, x, y);
      rgb[i] = o[0];
      rgb[i + 1] = o[1];
      rgb[i + 2] = o[2];
    }
  return { w, h, rgb };
}
const proxyOf = (img: LinearImage, recipe?: EditRecipe) =>
  proxyFromLinear(img, { width: img.w, height: img.h }, recipe?.crop, 256, 0, false);
const median = (p: AiProxy, r: EditRecipe) => statsOf(p, r).quantile(0.5);

describe('auto-enhance', () => {
  it('brightens a dark photo and darkens a bright one, toward middle grey', () => {
    const dark = proxyOf(scene(300, 200, (r, g, b) => [r * 0.06, g * 0.06, b * 0.06]));
    const bright = proxyOf(
      scene(300, 200, (r, g, b) => [Math.min(1, r * 1.9), Math.min(1, g * 1.9), Math.min(1, b * 1.9)]),
    );
    const d = autoEnhance(dark, { v: 1 }, { strength: 100 });
    const b = autoEnhance(bright, { v: 1 }, { strength: 100 });
    expect(d.light?.exposure ?? 0).toBeGreaterThan(1);
    expect(b.light?.exposure ?? 0).toBeLessThan(0);
    expect(median(dark, d)).toBeGreaterThan(median(dark, { v: 1 }) + 0.15);
    expect(Math.abs(median(dark, d) - 0.46)).toBeLessThan(0.08);
  });

  it('corrects a colour cast with temperature and tint', () => {
    const blue = proxyOf(scene(200, 150, (r, g, b) => [r * 0.7, g * 0.9, b * 1.3]));
    const warm = proxyOf(scene(200, 150, (r, g, b) => [r * 1.3, g * 0.95, b * 0.7]));
    const green = proxyOf(scene(200, 150, (r, g, b) => [r * 0.9, g * 1.25, b * 0.9]));
    expect(autoEnhance(blue, null, { strength: 100 }).color?.temperature ?? 0).toBeGreaterThan(10);
    expect(autoEnhance(warm, null, { strength: 100 }).color?.temperature ?? 0).toBeLessThan(-10);
    expect(autoEnhance(green, null, { strength: 100 }).color?.tint ?? 0).toBeGreaterThan(5);
  });

  it('is deterministic, scales with strength and keeps crop, detail, effects and the cut-out', () => {
    const p = proxyOf(scene(200, 150, (r, g, b) => [r * 0.2, g * 0.2, b * 0.25]));
    const start: EditRecipe = {
      v: 1,
      light: { exposure: -1, contrast: 50 },
      detail: { sharpening: 30 },
      effects: { vignette: -20 },
      crop: { angle: 3 },
      cutout: { mask: '0f3c1d2e-4a5b-4c6d-8e7f-a0b1c2d3e4f5', bg: 'white' },
    };
    const a = autoEnhance(p, start, { strength: 70 });
    expect(autoEnhance(p, start, { strength: 70 })).toEqual(a);
    expect(a.detail).toEqual(start.detail);
    expect(a.effects).toEqual(start.effects);
    expect(a.crop).toEqual(start.crop);
    expect(a.cutout).toEqual(start.cutout);
    // Auto-enhance owns light and colour: the old contrast isn't kept.
    expect(a.light?.contrast).not.toBe(50);
    const none = autoEnhance(p, start, { strength: 0 });
    expect(none.light).toBeUndefined();
    expect(none.color).toBeUndefined();
    const full = autoEnhance(p, start, { strength: 100 });
    expect(Math.abs(full.light?.exposure ?? 0)).toBeGreaterThan(Math.abs(a.light?.exposure ?? 0));
  });

  it('nudges too-red skin toward a natural hue, only inside the faces', () => {
    const w = 200;
    const h = 150;
    const skin: [number, number, number] = [fromSrgb(205 / 255), fromSrgb(110 / 255), fromSrgb(105 / 255)];
    const img = scene(w, h, (r, g, b, x, y) => (x > 80 && x < 120 && y > 40 && y < 90 ? skin : [r, g, b]));
    const p = proxyOf(img);
    const face = { x: 80 / w, y: 40 / h, w: 40 / w, h: 50 / h };
    const withFace = autoEnhance(p, null, { strength: 100, faces: [face] });
    expect(withFace.mixer?.orange?.hue ?? 0).toBeGreaterThan(0);
    expect(withFace.mixer?.red).toEqual(withFace.mixer?.orange);
    expect(Math.abs(withFace.mixer?.orange?.hue ?? 0)).toBeLessThanOrEqual(15);
    // No faces, or skin tones off: no mixer change.
    expect(autoEnhance(p, null, { strength: 100 }).mixer).toBeUndefined();
    expect(autoEnhance(p, null, { strength: 100, faces: [face], skin: false }).mixer).toBeUndefined();
    // A face box with no skin in it: nothing to judge.
    expect(
      autoEnhance(p, null, { strength: 100, faces: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] }).mixer,
    ).toBeUndefined();
  });

  it('counts changed sliders', () => {
    expect(changedSliders({ v: 1 }, { v: 1 })).toBe(0);
    expect(
      changedSliders(
        { v: 1, light: { exposure: 0.2 } },
        { v: 1, light: { exposure: 0.4, contrast: 5 }, mixer: { red: { hue: 3 } }, crop: { angle: 2 } },
      ),
    ).toBe(3);
  });
});

describe('HDR & interior balance', () => {
  it('lifts shadows and holds highlights on a dark room with a bright window', () => {
    const room = proxyOf(
      scene(240, 160, (_r, _g, _b, x, y) => (x > 150 && y < 80 ? [0.95, 0.95, 0.97] : [0.03, 0.025, 0.02])),
    );
    const r = hdrBalance(room, { v: 1 }, { strength: 80 });
    expect(r.light?.shadows ?? 0).toBeGreaterThan(20);
    expect(r.light?.highlights ?? 0).toBeLessThan(-10);
    expect(hdrBalance(room, { v: 1 }, { strength: 80 })).toEqual(r);
    // Strength 0 changes nothing.
    expect(hdrBalance(room, { v: 1, detail: { sharpening: 10 } }, { strength: 0 })).toEqual({
      v: 1,
      detail: { sharpening: 10 },
    });
  });
});

describe('colour match', () => {
  it('moves a photo toward a warmer, brighter reference', () => {
    const img = scene(200, 150, (r, g, b) => [r * 0.5, g * 0.5, b * 0.5]);
    const p = proxyOf(img);
    const ref = proxyOf(scene(200, 150, (r, g, b) => [Math.min(1, r * 1.3), g * 0.85, b * 0.55]));
    const r = colorMatch(p, { v: 1 }, ref, null, { strength: 100 });
    expect(r.color?.temperature ?? 0).toBeGreaterThan(10);
    expect(r.light?.exposure ?? 0).toBeGreaterThan(0);
    const target = labStats(developProxy(ref, null));
    const before = labDistance(labStats(developProxy(p, null)), target);
    const after = labDistance(labStats(developProxy(p, r)), target);
    expect(after).toBeLessThan(before * 0.5);
    expect(colorMatch(p, { v: 1 }, ref, null, { strength: 100 })).toEqual(r);
    // Half strength lands between.
    const half = colorMatch(p, { v: 1 }, ref, null, { strength: 50 });
    expect(half.color?.temperature ?? 0).toBeLessThan(r.color?.temperature ?? 0);
  });
});
