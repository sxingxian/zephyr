/**
 * Browser check: renders small images through the WebGL develop shader and compares every pixel with the
 * CPU reference in develop.ts. Also times slider re-renders at proxy size. Run by e2e/shader-check.mjs.
 */
import type { EditRecipe } from '@zephyr/shared/client';
import { type buildMask, loadMask, setMaskDeps } from '../src/lib/editor/cutout';
import {
  compositeParams,
  compositePixel,
  developParams,
  developPixel,
  fromSrgb,
  luma,
  sampleBilinear,
  sampleMip,
  shadowAt,
  toSrgb,
} from '../src/lib/editor/develop';
import { apply, outputSize, outputToSource } from '../src/lib/editor/geometry';
import { Renderer } from '../src/lib/editor/gl';
import { toHalf } from '../src/lib/editor/rawCommon';

type Result = { name: string; maxDiff: number; pixels: number };

function makeImage(w: number, h: number, flat?: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (flat) {
        img.data[i] = flat[0];
        img.data[i + 1] = flat[1];
        img.data[i + 2] = flat[2];
      } else {
        // Hue sweep across, brightness down, a grey strip at the bottom.
        const hue = (x / w) * 360;
        const v = 1 - (y / h) * 0.85;
        const s = y > h * 0.8 ? 0 : 0.75;
        const c2 = v * s;
        const hh = hue / 60;
        const xx = c2 * (1 - Math.abs((hh % 2) - 1));
        const [r, g, b] =
          hh < 1
            ? [c2, xx, 0]
            : hh < 2
              ? [xx, c2, 0]
              : hh < 3
                ? [0, c2, xx]
                : hh < 4
                  ? [0, xx, c2]
                  : hh < 5
                    ? [xx, 0, c2]
                    : [c2, 0, xx];
        const m = v - c2;
        img.data[i] = Math.round((r + m) * 255);
        img.data[i + 1] = Math.round((g + m) * 255);
        img.data[i + 2] = Math.round((b + m) * 255);
      }
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

function compare(name: string, r: Renderer, src: HTMLCanvasElement, recipe: EditRecipe): Result {
  const w = src.width;
  const h = src.height;
  r.setSource({ kind: 'bitmap', bitmap: src, width: w, height: h });
  const out = r.renderPixels({ recipe, width: w, height: h });
  const px = (src.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, w, h).data;
  const p = developParams(recipe, w / h);
  let maxDiff = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lin: [number, number, number] = [
        fromSrgb((px[i] as number) / 255),
        fromSrgb((px[i + 1] as number) / 255),
        fromSrgb((px[i + 2] as number) / 255),
      ];
      const d = developPixel(lin, luma(...lin), (x + 0.5) / w, (y + 0.5) / h, p);
      for (let k = 0; k < 3; k++) {
        const want = Math.round(toSrgb(d[k] as number) * 255);
        maxDiff = Math.max(maxDiff, Math.abs(want - (out[i + k] as number)));
      }
    }
  return { name, maxDiff, pixels: w * h };
}

/** IEEE half float bits → number (the precision the GPU sees). */
function fromHalf(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return m * 2 ** -24;
  return (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Scene-linear RAW-like data (half floats): a hue sweep across, a 13-stop brightness ramp down (≈ 0.0005…4,
 * well past white so the shoulder and gamut fit are exercised), a grey strip at the bottom.
 */
function makeRaw(w: number, h: number, flat?: [number, number, number]) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let rgb: [number, number, number];
      if (flat) rgb = flat;
      else {
        const v = 4 * 2 ** (-13 * (y / h));
        const s = y > h * 0.85 ? 0 : 0.8;
        const hue = (x / w) * 6;
        const k = (n: number) => {
          const t = (n + hue) % 6;
          return 1 - s * Math.max(0, Math.min(1, Math.min(t, 4 - t)));
        };
        rgb = [v * k(5), v * k(3), v * k(1)];
      }
      data[i] = toHalf(rgb[0]);
      data[i + 1] = toHalf(rgb[1]);
      data[i + 2] = toHalf(rgb[2]);
      data[i + 3] = 0x3c00;
    }
  return { data, width: w, height: h };
}

function compareRaw(
  name: string,
  r: Renderer,
  src: { data: Uint16Array; width: number; height: number },
  recipe: EditRecipe,
  baselineEv: number,
): Result {
  const { width: w, height: h, data } = src;
  r.setSource({ kind: 'half', data, width: w, height: h });
  const out = r.renderPixels({ recipe, width: w, height: h, baselineEv });
  const p = developParams(recipe, w / h, baselineEv, true);
  let maxDiff = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lin: [number, number, number] = [
        fromHalf(data[i] as number),
        fromHalf(data[i + 1] as number),
        fromHalf(data[i + 2] as number),
      ];
      const d = developPixel(lin, luma(...lin), (x + 0.5) / w, (y + 0.5) / h, p);
      for (let k = 0; k < 3; k++) {
        const want = Math.round(toSrgb(d[k] as number) * 255);
        maxDiff = Math.max(maxDiff, Math.abs(want - (out[i + k] as number)));
      }
    }
  return { name: `RAW ${name}`, maxDiff, pixels: w * h };
}

/** A soft-edged ellipse (the "subject") with a stalk to the bottom edge, as a greyscale mask. */
function makeMask(w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w * 0.5) / (w * 0.3);
      const dy = (y + 0.5 - h * 0.45) / (h * 0.32);
      const r = Math.sqrt(dx * dx + dy * dy);
      let v = Math.max(0, Math.min(1, (1.08 - r) / 0.16));
      if (Math.abs(x + 0.5 - w * 0.5) < w * 0.06 && y > h * 0.5 && y < h * 0.9) v = 1;
      d[y * w + x] = Math.round(v * 255);
    }
  return d;
}

/**
 * Cut-out composite: renders with and without the cut-out, and checks the cut-out pixels against
 * `compositePixel` applied to the GPU's own developed pixels (so geometry resampling isn't compared twice).
 */
async function compareCutout(
  name: string,
  r: Renderer,
  src: HTMLCanvasElement,
  recipe: EditRecipe,
  mask: ReturnType<typeof buildMask>,
): Promise<Result> {
  const w = src.width;
  const h = src.height;
  r.setSource({ kind: 'bitmap', bitmap: src, width: w, height: h });
  const full = outputSize(recipe.crop, { width: w, height: h });
  const plain = r.renderPixels({
    recipe: { ...recipe, cutout: undefined },
    width: full.width,
    height: full.height,
  });
  const out = r.renderPixels({ recipe, width: full.width, height: full.height });
  const cut = recipe.cutout as NonNullable<EditRecipe['cutout']>;
  const p = compositeParams(cut, Math.max(mask.width, mask.height), Math.max(w, h), mask.contact);
  const m = outputToSource(recipe.crop, { width: w, height: h });
  let maxDiff = 0;
  for (let y = 0; y < full.height; y++)
    for (let x = 0; x < full.width; x++) {
      const i = (y * full.width + x) * 4;
      let [u, v] = apply(m, (x + 0.5) / full.width, (y + 0.5) / full.height);
      u = Math.min(1, Math.max(0, u));
      v = Math.min(1, Math.max(0, v));
      const ms = sampleMip(mask.levels, u, v, p.lod);
      const sh = shadowAt(p, (a, b) => sampleBilinear(mask.blur, a, b), u, v);
      const want = compositePixel(
        [plain[i] as number, plain[i + 1] as number, plain[i + 2] as number],
        ms,
        sh,
        p,
      );
      for (let k = 0; k < 4; k++)
        maxDiff = Math.max(maxDiff, Math.abs((want[k] as number) - (out[i + k] as number)));
    }
  return { name: `cut-out ${name}`, maxDiff, pixels: full.width * full.height };
}

async function run() {
  // Let the page finish loading first: the checks below are long and synchronous.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const r = new Renderer();
  const results: Result[] = [];
  const grad = makeImage(96, 64);
  const cases: [string, EditRecipe][] = [
    ['neutral', { v: 1 }],
    ['exposure+contrast', { v: 1, light: { exposure: 0.6, contrast: 35, whites: 20, blacks: -25 } }],
    ['white balance', { v: 1, color: { temperature: 45, tint: -30 } }],
    ['vibrance+saturation', { v: 1, color: { vibrance: 50, saturation: -20 } }],
    ['mono', { v: 1, color: { saturation: -100 } }],
    [
      'colour mixer',
      {
        v: 1,
        mixer: {
          orange: { hue: 40, saturation: -50, luminance: 30 },
          blue: { hue: -60, saturation: 40, luminance: -40 },
        },
      },
    ],
    ['vignette', { v: 1, effects: { vignette: -70 } }],
    [
      'everything (no masks)',
      {
        v: 1,
        light: { exposure: -0.4, contrast: -20 },
        color: { temperature: -20, vibrance: 30 },
        mixer: { green: { hue: 20 } },
        effects: { vignette: 40 },
      },
    ],
  ];
  for (const [n, rec] of cases) results.push(compare(n, r, grad, rec));
  // Highlights and shadows use the blurred neighbourhood: on a flat image it equals the pixel.
  for (const tone of [
    [235, 230, 220],
    [40, 45, 60],
    [128, 120, 110],
  ] as [number, number, number][]) {
    results.push(
      compare(`highlights/shadows on ${tone.join(',')}`, r, makeImage(32, 24, tone), {
        v: 1,
        light: { highlights: -80, shadows: 70 },
      }),
    );
  }

  // Cut-out composite (phase 6): a mask smaller than the photo, every background and shadow, edge shift and
  // softness, and a rotated crop (the mask follows the geometry).
  const MID = '0f3c1d2e-4a5b-4c6d-8e7f-a0b1c2d3e4f5';
  const mw = 80;
  const mh = 54;
  const maskData = makeMask(mw, mh);
  setMaskDeps({
    fetchMask: async () => new Blob([]),
    decode: async () => ({ width: mw, height: mh, data: maskData }),
  });
  const mask = await loadMask('photo', MID);
  const cutCases: [string, EditRecipe][] = [
    ['white', { v: 1, cutout: { mask: MID, bg: 'white' } }],
    ['transparent (alpha)', { v: 1, cutout: { mask: MID, bg: 'transparent' } }],
    [
      'colour + soft shadow',
      { v: 1, cutout: { mask: MID, bg: 'color', color: '#e9e1d3', shadow: 'soft', shadowStrength: 60 } },
    ],
    [
      'white + contact shadow',
      { v: 1, cutout: { mask: MID, bg: 'white', shadow: 'contact', shadowStrength: 80 } },
    ],
    ['shift out, softness 6', { v: 1, cutout: { mask: MID, bg: 'white', shift: 6, softness: 6 } }],
    ['shift in', { v: 1, cutout: { mask: MID, bg: 'color', color: '#0d1117', shift: -8 } }],
    [
      'rotated crop + edits',
      {
        v: 1,
        light: { exposure: 0.3 },
        crop: { angle: 7, rect: { x: 0.1, y: 0.05, w: 0.7, h: 0.8 } },
        cutout: { mask: MID, bg: 'white', shadow: 'soft', shadowStrength: 40 },
      },
    ],
  ];
  for (const [n, rec] of cutCases) results.push(await compareCutout(n, r, grad, rec, mask));
  setMaskDeps(null);

  // RAW sources: baseline exposure and the base curve before the recipe.
  const rawGrad = makeRaw(96, 64);
  const rawCases: [string, EditRecipe, number][] = [
    ['neutral', { v: 1 }, 0],
    ['baseline +1.2 EV', { v: 1 }, 1.2],
    ['baseline −0.7 EV', { v: 1 }, -0.7],
    [
      'edited',
      {
        v: 1,
        light: { exposure: 0.4, contrast: 25, whites: -20, blacks: 15 },
        color: { temperature: 30, tint: -10, vibrance: 25 },
        mixer: { orange: { hue: 20, saturation: -30 }, blue: { luminance: 30 } },
        effects: { vignette: -40 },
      },
      0.6,
    ],
    ['mono', { v: 1, color: { saturation: -100 } }, 0.3],
  ];
  for (const [n, rec, ev] of rawCases) results.push(compareRaw(n, r, rawGrad, rec, ev));
  for (const tone of [
    [2.5, 2.2, 1.8],
    [0.01, 0.012, 0.02],
    [0.18, 0.16, 0.14],
  ] as [number, number, number][]) {
    results.push(
      compareRaw(
        `highlights/shadows on ${tone.join(',')}`,
        r,
        makeRaw(32, 24, tone),
        {
          v: 1,
          light: { highlights: -80, shadows: 70 },
        },
        0.5,
      ),
    );
  }

  // Speed: a 4000 × 2667 source shown at 1600 × 1067; each frame changes exposure (develop + detail only).
  const big = makeImage(4000, 2667);
  const view = document.createElement('canvas');
  document.body.append(view);
  const rv = new Renderer(view);
  rv.setSource({ kind: 'bitmap', bitmap: big, width: big.width, height: big.height });
  const base: EditRecipe = { v: 1, light: { highlights: -30, shadows: 20 }, detail: { sharpening: 30 } };
  rv.renderView({ recipe: base, width: 1600, height: 1067 });
  rv.gl.finish();
  const frames = 40;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    rv.renderView({
      recipe: { ...base, light: { ...base.light, exposure: (i % 20) / 20 } },
      width: 1600,
      height: 1067,
    });
    const px = new Uint8Array(4);
    rv.gl.readPixels(0, 0, 1, 1, rv.gl.RGBA, rv.gl.UNSIGNED_BYTE, px); // forces the frame to finish
  }
  const fps = (frames * 1000) / (performance.now() - t0);
  const renderer = (() => {
    const gl = rv.gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  })();
  (window as unknown as { __result: unknown }).__result = { results, fps, renderer };
}
run().catch((e) => {
  (window as unknown as { __result: unknown }).__result = { error: String(e?.stack ?? e) };
});
