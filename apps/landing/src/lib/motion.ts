/**
 * Build-time helpers that describe scroll animations as data attributes. scripts/motion.ts reads them
 * and builds GSAP ScrollTrigger timelines. Ranges are fractions (0–1) of the scene's scroll distance.
 * The markup itself is always the final layout, so the page is complete without JavaScript.
 */
export type Preset =
  | 'flyIn'
  | 'tagIn'
  | 'grow'
  | 'dimOut'
  | 'grade'
  | 'sweep'
  | 'draw'
  | 'gust'
  | 'dimBoard'
  | 'popIn'
  | 'digitIn'
  | 'develop';

export type From = Record<string, number | string>;

export function anim(preset: Preset, start: number, end: number, from?: From): Record<string, string> {
  const a: Record<string, string> = {
    'data-anim': preset,
    'data-range': `${start.toFixed(3)} ${end.toFixed(3)}`,
  };
  if (from) a['data-from'] = JSON.stringify(from);
  return a;
}

/** Two animations on one element (e.g. fly in, then dim). */
export function anim2(
  a: [Preset, number, number, From?],
  b: [Preset, number, number, From?],
): Record<string, string> {
  const x = anim(...a);
  const y = anim(...b);
  return {
    'data-anim': `${x['data-anim']}|${y['data-anim']}`,
    'data-range': `${x['data-range']}|${y['data-range']}`,
    'data-from': `${x['data-from'] ?? ''}|${y['data-from'] ?? ''}`,
  };
}

/** Animations for elements outside a scene, driven by their own way through the viewport. */
export function viewAnim(preset: Preset, from?: From): Record<string, string> {
  const a: Record<string, string> = { 'data-view-anim': preset };
  if (from) a['data-from'] = JSON.stringify(from);
  return a;
}

export interface StepRange {
  in: [number, number];
  out?: [number, number];
}
