import { type EditRecipe, normalizeRecipe } from '@zephyr/shared/client';
import { solveExposure, statsOf, TARGET_MEDIAN } from './enhance';
import { type AiProxy, resizeProxy } from './proxy';

/**
 * HDR & interior balance (phase 6, on the device): lifts dark rooms and holds bright windows and skies.
 * It writes the existing sliders only. Highlights and shadows are already local in the pipeline (they read
 * the blurred neighbourhood luminance), so raising shadows and lowering highlights in proportion to how much
 * of the photo is dark or bright compresses the range without flattening the mid-tones; whites and blacks
 * then pull the ends back out, a little contrast is added back and exposure is solved again for the median.
 */
export interface HdrOptions {
  /** 0–100, default 50. */
  strength?: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function hdrBalance(proxy: AiProxy, recipe: EditRecipe | null, opts: HdrOptions = {}): EditRecipe {
  const k = clamp(opts.strength ?? 50, 0, 100) / 100;
  const base = normalizeRecipe(recipe);
  const p = resizeProxy(proxy, 160);
  const L = base.light ?? {};
  const s0 = statsOf(p, base);
  const dark = s0.below(0.2);
  const bright = s0.above(0.8);
  const shadows = clamp(Math.round((L.shadows ?? 0) + k * clamp(dark * 220, 10, 80)), -100, 100);
  const highlights = clamp(Math.round((L.highlights ?? 0) - k * clamp(bright * 250, 10, 80)), -100, 100);
  const compressed: EditRecipe = { ...base, light: { ...L, shadows, highlights } };
  const s1 = statsOf(p, compressed);
  // Restore the ends the compression pulled in.
  const p995 = s1.quantile(0.995);
  const p005 = s1.quantile(0.005);
  const whites = clamp(
    Math.round((L.whites ?? 0) + (p995 < 0.95 ? k * clamp((0.97 - p995) * 160, 0, 35) : 0)),
    -100,
    100,
  );
  const blacks = clamp(
    Math.round((L.blacks ?? 0) - (p005 > 0.03 ? k * clamp((p005 - 0.02) * 220, 0, 30) : 0)),
    -100,
    100,
  );
  const contrast = clamp(Math.round((L.contrast ?? 0) + 8 * k), -100, 100);
  const shaped: EditRecipe = { ...base, light: { ...L, shadows, highlights, whites, blacks, contrast } };
  // Exposure: re-solved for the median, but never more than 1 EV from where it was.
  const ev0 = L.exposure ?? 0;
  const solved = solveExposure(p, shaped, TARGET_MEDIAN, ev0 - 1, ev0 + 1, 9);
  const exposure = Math.round((ev0 + (solved - ev0) * k) * 100) / 100;
  return normalizeRecipe({ ...shaped, light: { ...shaped.light, exposure } });
}
