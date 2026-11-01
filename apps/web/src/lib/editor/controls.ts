import {
  type EditRecipe,
  type EditSection,
  type HueBand,
  type MixerChannel,
  normalizeRecipe,
  RANGES,
} from '@zephyr/shared/client';

/** The Adjust panel's sliders, in mockup order. One list drives the desktop panel and the phone dial. */
export interface Control {
  section: Exclude<EditSection, 'crop' | 'mixer'>;
  key: string;
  label: string;
  /** Short label for the phone chips. */
  short?: string;
  min: number;
  max: number;
  step: number;
  bipolar: boolean;
  /** Track gradient (temperature, tint). */
  track?: string;
}

const r = <S extends keyof typeof RANGES>(s: S, k: keyof (typeof RANGES)[S]) =>
  RANGES[s][k] as unknown as { min: number; max: number; step: number };

export const CONTROLS: Control[] = [
  { section: 'light', key: 'exposure', label: 'Exposure', ...r('light', 'exposure'), bipolar: true },
  { section: 'light', key: 'contrast', label: 'Contrast', ...r('light', 'contrast'), bipolar: true },
  { section: 'light', key: 'highlights', label: 'Highlights', ...r('light', 'highlights'), bipolar: true },
  { section: 'light', key: 'shadows', label: 'Shadows', ...r('light', 'shadows'), bipolar: true },
  { section: 'light', key: 'whites', label: 'Whites', ...r('light', 'whites'), bipolar: true },
  { section: 'light', key: 'blacks', label: 'Blacks', ...r('light', 'blacks'), bipolar: true },
  {
    section: 'color',
    key: 'temperature',
    label: 'Temperature',
    short: 'Temp',
    ...r('color', 'temperature'),
    bipolar: true,
    track: 'linear-gradient(90deg, #5B8DEF, #E9E4D8, #F2B33D)',
  },
  {
    section: 'color',
    key: 'tint',
    label: 'Tint',
    ...r('color', 'tint'),
    bipolar: true,
    track: 'linear-gradient(90deg, #4CAF7A, #E9E4D8, #D85CB7)',
  },
  { section: 'color', key: 'vibrance', label: 'Vibrance', ...r('color', 'vibrance'), bipolar: true },
  { section: 'color', key: 'saturation', label: 'Saturation', ...r('color', 'saturation'), bipolar: true },
  {
    section: 'detail',
    key: 'sharpening',
    label: 'Sharpening',
    short: 'Sharpen',
    ...r('detail', 'sharpening'),
    bipolar: false,
  },
  {
    section: 'detail',
    key: 'noiseReduction',
    label: 'Noise reduction',
    short: 'Noise',
    ...r('detail', 'noiseReduction'),
    bipolar: false,
  },
  { section: 'effects', key: 'vignette', label: 'Vignette', ...r('effects', 'vignette'), bipolar: true },
];

export const SECTION_LABELS: Record<EditSection, string> = {
  light: 'Light',
  color: 'Colour',
  mixer: 'Colour mixer',
  detail: 'Detail',
  effects: 'Effects',
  crop: 'Crop & straighten',
  cutout: 'Background removal',
};
export const SECTION_HINTS: Record<EditSection, string> = {
  light: 'Exposure, contrast, highlights, shadows, whites, blacks',
  color: 'Temperature, tint, vibrance, saturation',
  mixer: 'Hue, saturation and luminance per colour',
  detail: 'Sharpening, noise reduction',
  effects: 'Vignette',
  crop: 'Off by default: photos are usually framed differently',
  cutout: 'Belongs to its own photo; never pasted',
};

export const BANDS: { band: HueBand; label: string; color: string }[] = [
  { band: 'red', label: 'Red', color: '#E5484D' },
  { band: 'orange', label: 'Orange', color: '#F2994A' },
  { band: 'yellow', label: 'Yellow', color: '#F2C94C' },
  { band: 'green', label: 'Green', color: '#4CAF7A' },
  { band: 'aqua', label: 'Aqua', color: '#3CC2C8' },
  { band: 'blue', label: 'Blue', color: '#3D7BE0' },
  { band: 'purple', label: 'Purple', color: '#8E6CDF' },
  { band: 'magenta', label: 'Magenta', color: '#D85CB7' },
];
export const MIXER_KEYS: { key: keyof MixerChannel; label: string }[] = [
  { key: 'hue', label: 'Hue' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'luminance', label: 'Luminance' },
];

/** "+0.35", "−42", "0", "−2.4°" (true minus sign, like the mockups). */
export function formatValue(v: number, step: number, suffix = ''): string {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  if (!v) return `0${suffix}`;
  const s = Math.abs(v).toFixed(decimals);
  return `${v > 0 ? '+' : '−'}${s}${suffix}`;
}
export function ariaValue(_c: { label: string }, v: number, step: number, suffix = ''): string {
  return formatValue(v, step, suffix).replace('−', 'minus ');
}

export function getValue(recipe: EditRecipe, c: Pick<Control, 'section' | 'key'>): number {
  const sec = recipe[c.section] as Record<string, number> | undefined;
  return sec?.[c.key] ?? 0;
}
export function setValue(recipe: EditRecipe, c: Pick<Control, 'section' | 'key'>, v: number): EditRecipe {
  const sec = { ...((recipe[c.section] as Record<string, number> | undefined) ?? {}), [c.key]: v };
  return normalizeRecipe({ ...recipe, [c.section]: sec });
}
export function getMixer(recipe: EditRecipe, band: HueBand, key: keyof MixerChannel): number {
  return recipe.mixer?.[band]?.[key] ?? 0;
}
export function setMixer(recipe: EditRecipe, band: HueBand, key: keyof MixerChannel, v: number): EditRecipe {
  const mixer = { ...(recipe.mixer ?? {}) };
  mixer[band] = { ...(mixer[band] ?? {}), [key]: v };
  return normalizeRecipe({ ...recipe, mixer });
}
export function resetSection(recipe: EditRecipe, section: EditSection): EditRecipe {
  const next = { ...recipe } as Record<string, unknown>;
  delete next[section];
  return normalizeRecipe(next);
}
