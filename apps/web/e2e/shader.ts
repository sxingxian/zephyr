/**
 * Browser check: renders small images through the WebGL develop shader and compares every pixel with the
 * CPU reference in develop.ts. Also times slider re-renders at proxy size. Run by e2e/shader-check.mjs.
 */
import type { EditRecipe } from '@zephyr/shared/client';
import { developParams, developPixel, fromSrgb, luma, toSrgb } from '../src/lib/editor/develop';
import { Renderer } from '../src/lib/editor/gl';

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

async function run() {
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
