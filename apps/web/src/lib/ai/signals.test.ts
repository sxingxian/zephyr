import { describe, expect, it } from 'vitest';
import { computeSignals, isNight, laplacianVariance, localHour, phash, type Rgba } from './signalsCore';

function image(w: number, h: number, f: (x: number, y: number) => number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, f(x, y)));
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}
const scene = (x: number, y: number) =>
  120 + 80 * Math.sin(x / 9) * Math.cos(y / 13) + (x > 60 && y < 40 ? 60 : 0);
/** A 5-tap box blur of an image (a softer copy of the same picture). */
function blur(img: Rgba, r: number): Rgba {
  const { width: w, height: h } = img;
  return image(w, h, (x, y) => {
    let s = 0;
    let n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        s += img.data[(yy * w + xx) * 4] as number;
        n++;
      }
    return s / n;
  });
}
const bits = (a: string, b: string) => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
};

describe('quality signals', () => {
  it('hashes resized copies alike and different pictures apart', () => {
    const a = image(160, 120, scene);
    const big = image(320, 240, (x, y) => scene(x / 2, y / 2));
    const other = image(160, 120, (x, y) => 255 - scene(y * 1.3, x * 0.7));
    const h = phash(a);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(bits(h, phash(big))).toBeLessThanOrEqual(4);
    expect(bits(h, phash(other))).toBeGreaterThan(12);
    expect(phash(a)).toBe(h); // deterministic
  });

  it('scores a blurred copy as less sharp', () => {
    const a = image(160, 120, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? 230 : 25));
    expect(laplacianVariance(a)).toBeGreaterThan(laplacianVariance(blur(a, 2)) * 3);
    expect(laplacianVariance(image(2, 2, () => 9))).toBe(0);
  });

  it('decides Night from brightness, bright points and the photo’s own clock', () => {
    expect(isNight(0.1, 0.9, null)).toBe(true); // city lights
    expect(isNight(0.1, 0.3, null)).toBe(false); // just dark, no clock
    expect(isNight(0.2, 0.3, 22)).toBe(true);
    expect(isNight(0.2, 0.3, 14)).toBe(false);
    expect(isNight(0.5, 0.95, 23)).toBe(false);
    expect(localHour('2026-10-12T21:04:00+08:00')).toBe(21);
    expect(localHour(null)).toBeNull();
  });

  it('computes every signal within its schema bounds', () => {
    const lights = image(120, 90, (x, y) => (x % 20 < 3 && y % 15 < 3 ? 255 : 8)); // ~3 % bright points
    const s = computeSignals('id', lights, null);
    expect(s.brightness).toBeGreaterThanOrEqual(0);
    expect(s.brightness).toBeLessThan(0.1);
    expect(s.sharpness).toBeGreaterThanOrEqual(0);
    expect(s.sharpness).toBeLessThanOrEqual(65025);
    expect(s.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(s.night).toBe(true);
  });
});
