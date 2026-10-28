/**
 * Phase 4 contract: edit recipes, saved recipes and the editor's HTTP routes. Types, constants and pure helpers
 * only (browser-safe; no zod). See docs/phase-4.md.
 *
 * A recipe is a sparse JSON delta on top of the untouched original (FR-ED-03): any setting left out is at its
 * neutral value. `normalizeRecipe` is the one place that rounds, clamps and drops neutral values, and both the
 * browser and the API run it, so the same edit always serialises to the same bytes.
 */
import type { VariantKind } from './library-types';

export const EDIT_API = {
  /** GET → { ok, edit: PhotoEdit | null } · PUT EditSaveBody → 200 { ok, edit } (409 conflict → { ok: false, error: 'conflict', edit }) · DELETE → 204 (revert to original) */
  photoEdit: (photoId: string) => `/api/v1/photos/${encodeURIComponent(photoId)}/edit`,
  /** PUT image bytes (JPEG or WEBP) rendered from the given edit version → 200 { ok } · 410 when that version is no longer current */
  photoEditVariant: (photoId: string, kind: VariantKind, version: number) =>
    `/api/v1/photos/${encodeURIComponent(photoId)}/edit/variants/${kind}?v=${version}`,
  /** POST EditBulkBody → 200 EditBulkResult (paste edits / apply recipe / revert, for up to the plan's batch size) */
  editsBulk: '/api/v1/photos/edits/bulk',
  /** GET → { ok, recipes: SavedRecipe[] } · POST RecipeCreateBody → 201 { ok, recipe } */
  recipes: '/api/v1/recipes',
  /** PATCH RecipePatchBody → 200 { ok, recipe } · DELETE → 204 */
  recipe: (id: string) => `/api/v1/recipes/${encodeURIComponent(id)}`,
} as const;

/** Thumbnails and previews have an `?original=1` form that ignores edits (compare views, "before"). */
export const ORIGINAL_VARIANT_QUERY = 'original=1';

// ---------------------------------------------------------------- recipe shape
export const HUE_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HueBand = (typeof HUE_BANDS)[number];
export const CROP_ASPECTS = ['original', 'free', '1:1', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16'] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];

export interface LightSettings {
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
}
export interface ColorSettings {
  temperature?: number;
  tint?: number;
  vibrance?: number;
  saturation?: number;
}
export interface MixerChannel {
  hue?: number;
  saturation?: number;
  luminance?: number;
}
export type MixerSettings = Partial<Record<HueBand, MixerChannel>>;
export interface DetailSettings {
  sharpening?: number;
  noiseReduction?: number;
}
export interface EffectsSettings {
  vignette?: number;
}
/** Normalised crop rectangle (0–1) in the straightened, rotated and flipped image. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CropSettings {
  aspect?: CropAspect;
  rect?: CropRect;
  /** Straighten, degrees, −45…45. */
  angle?: number;
  /** Clockwise quarter turns, 0–3. */
  quarterTurns?: number;
  flipH?: boolean;
  flipV?: boolean;
  perspectiveV?: number;
  perspectiveH?: number;
}
export interface EditRecipe {
  v: 1;
  light?: LightSettings;
  color?: ColorSettings;
  mixer?: MixerSettings;
  detail?: DetailSettings;
  effects?: EffectsSettings;
  crop?: CropSettings;
}
export type EditSection = 'light' | 'color' | 'mixer' | 'detail' | 'effects' | 'crop';
export const EDIT_SECTIONS: readonly EditSection[] = ['light', 'color', 'mixer', 'detail', 'effects', 'crop'];
/** Sections a saved recipe may carry: never the crop (photos are framed differently). */
export const RECIPE_SECTIONS: readonly EditSection[] = ['light', 'color', 'mixer', 'detail', 'effects'];
/** Sections ticked by default when pasting. */
export const DEFAULT_PASTE_SECTIONS: readonly EditSection[] = RECIPE_SECTIONS;

/** Slider ranges. `step` is also the rounding unit used by normalizeRecipe. The UI and the API both read these. */
export const RANGES = {
  light: {
    exposure: { min: -5, max: 5, step: 0.01 },
    contrast: { min: -100, max: 100, step: 1 },
    highlights: { min: -100, max: 100, step: 1 },
    shadows: { min: -100, max: 100, step: 1 },
    whites: { min: -100, max: 100, step: 1 },
    blacks: { min: -100, max: 100, step: 1 },
  },
  color: {
    temperature: { min: -100, max: 100, step: 1 },
    tint: { min: -100, max: 100, step: 1 },
    vibrance: { min: -100, max: 100, step: 1 },
    saturation: { min: -100, max: 100, step: 1 },
  },
  mixer: {
    hue: { min: -100, max: 100, step: 1 },
    saturation: { min: -100, max: 100, step: 1 },
    luminance: { min: -100, max: 100, step: 1 },
  },
  detail: {
    sharpening: { min: 0, max: 150, step: 1 },
    noiseReduction: { min: 0, max: 100, step: 1 },
  },
  effects: {
    vignette: { min: -100, max: 100, step: 1 },
  },
  crop: {
    angle: { min: -45, max: 45, step: 0.1 },
    perspectiveV: { min: -100, max: 100, step: 1 },
    perspectiveH: { min: -100, max: 100, step: 1 },
  },
} as const;

/** Largest stored recipe, in UTF-8 bytes of its JSON. A full recipe is well under 2 KB. */
export const MAX_RECIPE_BYTES = 4096;
export const MAX_SAVED_RECIPES = 200;
export const RECIPE_NAME_MAX = 60;

export const EMPTY_RECIPE: EditRecipe = Object.freeze({ v: 1 }) as EditRecipe;

// ---------------------------------------------------------------- helpers
type Range = { min: number; max: number; step: number };
function num(v: unknown, r: Range): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const c = Math.min(r.max, Math.max(r.min, v));
  const decimals = Math.max(0, -Math.floor(Math.log10(r.step) + 1e-9));
  const rounded = Number((Math.round(c / r.step) * r.step).toFixed(decimals));
  return rounded === 0 ? undefined : rounded; // -0 and 0 both drop
}
function pickNums<T extends Record<string, Range>>(
  src: unknown,
  ranges: T,
): Partial<Record<keyof T, number>> | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const out: Partial<Record<keyof T, number>> = {};
  for (const k of Object.keys(ranges) as (keyof T)[]) {
    const v = num((src as Record<string, unknown>)[k as string], ranges[k] as Range);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
const unit = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

function normalizeCrop(src: unknown): CropSettings | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const s = src as Record<string, unknown>;
  const out: CropSettings = {};
  if (
    typeof s.aspect === 'string' &&
    (CROP_ASPECTS as readonly string[]).includes(s.aspect) &&
    s.aspect !== 'original'
  )
    out.aspect = s.aspect as CropAspect;
  const r = s.rect as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const x = unit(r.x);
    const y = unit(r.y);
    const w = unit(r.w);
    const h = unit(r.h);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined && w >= 0.01 && h >= 0.01) {
      const rect = { x: r4(Math.min(x, 1 - w)), y: r4(Math.min(y, 1 - h)), w: r4(w), h: r4(h) };
      if (!(rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1)) out.rect = rect;
    }
  }
  const angle = num(s.angle, RANGES.crop.angle);
  if (angle !== undefined) out.angle = angle;
  if (typeof s.quarterTurns === 'number' && Number.isInteger(s.quarterTurns)) {
    const q = ((s.quarterTurns % 4) + 4) % 4;
    if (q) out.quarterTurns = q;
  }
  if (s.flipH === true) out.flipH = true;
  if (s.flipV === true) out.flipV = true;
  const pv = num(s.perspectiveV, RANGES.crop.perspectiveV);
  if (pv !== undefined) out.perspectiveV = pv;
  const ph = num(s.perspectiveH, RANGES.crop.perspectiveH);
  if (ph !== undefined) out.perspectiveH = ph;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Clamps, rounds and drops neutral values; unknown keys are discarded. Keys are emitted in a fixed order so the
 * same edit always serialises identically. Never throws: anything unusable becomes "no change".
 */
export function normalizeRecipe(input: unknown): EditRecipe {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: EditRecipe = { v: 1 };
  const light = pickNums(src.light, RANGES.light);
  if (light) out.light = light;
  const color = pickNums(src.color, RANGES.color);
  if (color) out.color = color;
  if (src.mixer && typeof src.mixer === 'object') {
    const mixer: MixerSettings = {};
    for (const band of HUE_BANDS) {
      const ch = pickNums((src.mixer as Record<string, unknown>)[band], RANGES.mixer);
      if (ch) mixer[band] = ch;
    }
    if (Object.keys(mixer).length) out.mixer = mixer;
  }
  const detail = pickNums(src.detail, RANGES.detail);
  if (detail) out.detail = detail;
  const effects = pickNums(src.effects, RANGES.effects);
  if (effects) out.effects = effects;
  const crop = normalizeCrop(src.crop);
  if (crop) out.crop = crop;
  return out;
}

/** True when the recipe changes nothing (the photo looks like its original). */
export function isEmptyRecipe(r: EditRecipe | null | undefined): boolean {
  return !r || Object.keys(normalizeRecipe(r)).length === 1;
}

/** Sections that differ from neutral. */
export function changedSections(r: EditRecipe | null | undefined): EditSection[] {
  const n = normalizeRecipe(r);
  return EDIT_SECTIONS.filter((s) => n[s] !== undefined);
}

/**
 * Paste / apply: the ticked sections of `source` replace the same sections of `target` (a section the source
 * leaves neutral resets that section on the target); every other section of `target` is kept.
 */
export function mergeRecipe(
  target: EditRecipe | null | undefined,
  source: EditRecipe | null | undefined,
  sections: readonly EditSection[],
): EditRecipe {
  const t = normalizeRecipe(target) as unknown as Record<string, unknown>;
  const s = normalizeRecipe(source) as unknown as Record<string, unknown>;
  for (const sec of sections) {
    if (s[sec] === undefined) delete t[sec];
    else t[sec] = s[sec];
  }
  return normalizeRecipe(t);
}

/** Keeps only the given sections (used when saving a recipe: never the crop). */
export function pickSections(r: EditRecipe | null | undefined, sections: readonly EditSection[]): EditRecipe {
  return mergeRecipe(EMPTY_RECIPE, r, sections);
}

/** Stable JSON text of a recipe (after normalising). */
export function recipeJson(r: EditRecipe | null | undefined): string {
  return JSON.stringify(normalizeRecipe(r));
}

// ---------------------------------------------------------------- API types
export interface PhotoEdit {
  photoId: string;
  recipe: EditRecipe;
  /** Increases on every save; variants are uploaded against a version. */
  version: number;
  /** Edited thumb and preview exist for this version (otherwise the grid shows the original). */
  rendered: boolean;
  updatedAt: string;
}
export interface EditSaveBody {
  recipe: EditRecipe;
  /** The version this edit was based on; null for a photo that had no edit. Mismatch → 409 conflict. */
  baseVersion: number | null;
}
export interface EditSaveResult {
  ok: true;
  edit: PhotoEdit;
}
export interface EditBulkBody {
  ids: string[];
  /** Pasted or applied recipe; null reverts the listed photos to their originals. */
  recipe: EditRecipe | null;
  /** Which sections of `recipe` replace each photo's; ignored when recipe is null. */
  sections: EditSection[];
}
export interface EditBulkResult {
  ok: true;
  /** Number of the caller's own photos that changed; other ids are ignored. */
  affected: number;
  /** New state per affected photo (null: reverted). The browser renders thumbnails for these. */
  edits: { photoId: string; edit: PhotoEdit | null }[];
}

export interface SavedRecipe {
  id: string;
  name: string;
  recipe: EditRecipe;
  createdAt: string;
  updatedAt: string;
}
export interface RecipeCreateBody {
  name: string;
  recipe: EditRecipe;
}
export interface RecipePatchBody {
  name?: string;
  recipe?: EditRecipe;
}

/** Zephyr's own starting recipes (shipped in code, not stored per member). */
export const BUILT_IN_RECIPES: readonly { id: string; name: string; recipe: EditRecipe }[] = [
  {
    id: 'zephyr-clean',
    name: 'Clean',
    recipe: {
      v: 1,
      light: { exposure: 0.1, contrast: 8, highlights: -20, shadows: 15 },
      color: { vibrance: 10 },
      detail: { sharpening: 25 },
    },
  },
  {
    id: 'zephyr-soft-film',
    name: 'Soft film',
    recipe: {
      v: 1,
      light: { contrast: -18, highlights: -30, shadows: 20, blacks: 18 },
      color: { temperature: 6, vibrance: -10, saturation: -12 },
      mixer: { orange: { saturation: -8 }, blue: { hue: -10, saturation: -20 } },
      effects: { vignette: -10 },
    },
  },
  {
    id: 'zephyr-warm-evening',
    name: 'Warm evening',
    recipe: {
      v: 1,
      light: { exposure: 0.05, contrast: 10, highlights: -25 },
      color: { temperature: 22, tint: 4, vibrance: 12 },
      mixer: { orange: { saturation: 8, luminance: 6 } },
      effects: { vignette: -15 },
    },
  },
  {
    id: 'zephyr-crisp-product',
    name: 'Crisp product',
    recipe: {
      v: 1,
      light: { exposure: 0.2, contrast: 14, whites: 18, blacks: -8 },
      color: { vibrance: 6 },
      detail: { sharpening: 45, noiseReduction: 10 },
    },
  },
  {
    id: 'zephyr-mono-classic',
    name: 'Mono classic',
    recipe: {
      v: 1,
      light: { contrast: 22, highlights: -15, shadows: 10 },
      color: { saturation: -100 },
      detail: { sharpening: 20 },
      effects: { vignette: -12 },
    },
  },
  {
    id: 'zephyr-faded-matte',
    name: 'Faded matte',
    recipe: {
      v: 1,
      light: { contrast: -25, whites: -12, blacks: 30 },
      color: { saturation: -15 },
      effects: { vignette: -6 },
    },
  },
];
