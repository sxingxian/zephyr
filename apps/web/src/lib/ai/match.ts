import { type EditRecipe, normalizeRecipe, RANGES } from '@zephyr/shared/client';
import { type AiProxy, developProxy, resizeProxy, SMALL_PROXY_EDGE } from './proxy';
import { type LabStats, labStats } from './stats';

/**
 * Colour match (phase 6, on the device): makes a photo's colour and tone resemble a reference photo's.
 * Instead of transferring pixels (which no slider could reproduce), it searches the sliders: coordinate
 * descent over exposure, contrast, temperature, tint, saturation and vibrance, minimising the distance
 * between the two photos' Lab statistics (mean and spread of lightness, mean a and b, mean chroma), at most
 * 60 develop evaluations on 128 px proxies. Strength interpolates from the photo's current sliders to the
 * match. Deterministic.
 */
export interface MatchOptions {
  /** 0–100, default 80. */
  strength?: number;
  /** Evaluation budget (default 60). */
  maxEvals?: number;
}

type Knob = { sec: 'light' | 'color'; key: string; step: number; min: number; max: number };
const KNOBS: Knob[] = [
  {
    sec: 'light',
    key: 'exposure',
    min: RANGES.light.exposure.min,
    max: RANGES.light.exposure.max,
    step: 0.5,
  },
  { sec: 'light', key: 'contrast', min: RANGES.light.contrast.min, max: RANGES.light.contrast.max, step: 20 },
  {
    sec: 'color',
    key: 'temperature',
    min: RANGES.color.temperature.min,
    max: RANGES.color.temperature.max,
    step: 20,
  },
  { sec: 'color', key: 'tint', min: RANGES.color.tint.min, max: RANGES.color.tint.max, step: 20 },
  {
    sec: 'color',
    key: 'saturation',
    min: RANGES.color.saturation.min,
    max: RANGES.color.saturation.max,
    step: 20,
  },
  { sec: 'color', key: 'vibrance', min: RANGES.color.vibrance.min, max: RANGES.color.vibrance.max, step: 20 },
];

/** Weighted squared distance between two photos' Lab statistics. */
export function labDistance(a: LabStats, b: LabStats): number {
  return (
    ((a.meanL - b.meanL) / 4) ** 2 +
    ((a.sdL - b.sdL) / 4) ** 2 +
    ((a.meanA - b.meanA) / 2) ** 2 +
    ((a.meanB - b.meanB) / 2) ** 2 +
    ((a.chroma - b.chroma) / 3) ** 2
  );
}

const get = (r: EditRecipe, k: Knob) =>
  ((r[k.sec] as Record<string, number> | undefined)?.[k.key] ?? 0) as number;
const set = (r: EditRecipe, k: Knob, v: number): EditRecipe => ({
  ...r,
  [k.sec]: { ...(r[k.sec] as Record<string, number> | undefined), [k.key]: v },
});

export function colorMatch(
  proxy: AiProxy,
  recipe: EditRecipe | null,
  reference: AiProxy,
  referenceRecipe: EditRecipe | null,
  opts: MatchOptions = {},
): EditRecipe {
  const k = Math.min(100, Math.max(0, opts.strength ?? 80)) / 100;
  const budget = opts.maxEvals ?? 60;
  const base = normalizeRecipe(recipe);
  const p = resizeProxy(proxy, SMALL_PROXY_EDGE);
  const target = labStats(developProxy(resizeProxy(reference, SMALL_PROXY_EDGE), referenceRecipe));
  let evals = 0;
  const cost = (r: EditRecipe) => {
    evals++;
    return labDistance(labStats(developProxy(p, r)), target);
  };
  let best = base;
  let bestCost = cost(best);
  const steps = KNOBS.map((x) => x.step);
  // Coordinate descent with step halving.
  while (evals < budget) {
    let improved = false;
    for (let i = 0; i < KNOBS.length && evals < budget; i++) {
      const knob = KNOBS[i] as Knob;
      const step = steps[i] as number;
      if (step < (knob.key === 'exposure' ? 0.02 : 1)) continue;
      for (const dir of [1, -1]) {
        if (evals >= budget) break;
        const v = Math.min(knob.max, Math.max(knob.min, get(best, knob) + dir * step));
        const cand = set(best, knob, v);
        const c = cost(cand);
        if (c < bestCost - 1e-9) {
          best = cand;
          bestCost = c;
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      let any = false;
      for (let i = 0; i < steps.length; i++) {
        steps[i] = (steps[i] as number) / 2;
        if ((steps[i] as number) >= (KNOBS[i]?.key === 'exposure' ? 0.02 : 1)) any = true;
      }
      if (!any) break;
    }
  }
  // Strength: from the current sliders toward the match.
  let out = base;
  for (const knob of KNOBS) {
    const from = get(base, knob);
    const to = get(best, knob);
    out = set(out, knob, from + (to - from) * k);
  }
  return normalizeRecipe(out);
}
