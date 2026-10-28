import { z } from 'zod';
import {
  EDIT_SECTIONS,
  type EditRecipe,
  MAX_RECIPE_BYTES,
  normalizeRecipe,
  pickSections,
  RECIPE_NAME_MAX,
  RECIPE_SECTIONS,
} from './edit-types';

/** Server-side request schemas for the phase 4 editor API. */
const uuid = z.string().uuid();
const finite = z.number().finite();
const band = z.object({ hue: finite, saturation: finite, luminance: finite }).partial().strict();

/**
 * Strict shape check (unknown keys rejected, numbers finite), then normalised: values are clamped and rounded
 * to the shared RANGES and neutral values dropped. The stored JSON is capped at MAX_RECIPE_BYTES.
 */
export const recipeSchema = z
  .object({
    v: z.literal(1),
    light: z
      .object({
        exposure: finite,
        contrast: finite,
        highlights: finite,
        shadows: finite,
        whites: finite,
        blacks: finite,
      })
      .partial()
      .strict()
      .optional(),
    color: z
      .object({ temperature: finite, tint: finite, vibrance: finite, saturation: finite })
      .partial()
      .strict()
      .optional(),
    mixer: z
      .object({
        red: band,
        orange: band,
        yellow: band,
        green: band,
        aqua: band,
        blue: band,
        purple: band,
        magenta: band,
      })
      .partial()
      .strict()
      .optional(),
    detail: z.object({ sharpening: finite, noiseReduction: finite }).partial().strict().optional(),
    effects: z.object({ vignette: finite }).partial().strict().optional(),
    crop: z
      .object({
        aspect: z.enum(['original', 'free', '1:1', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16']),
        rect: z.object({ x: finite, y: finite, w: finite, h: finite }).strict(),
        angle: finite,
        quarterTurns: z.number().int().min(0).max(3),
        flipH: z.boolean(),
        flipV: z.boolean(),
        perspectiveV: finite,
        perspectiveH: finite,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .transform((r) => normalizeRecipe(r))
  .refine((r) => new TextEncoder().encode(JSON.stringify(r)).length <= MAX_RECIPE_BYTES, 'recipe too large');

const sectionsSchema = z.array(z.enum(EDIT_SECTIONS as [string, ...string[]])).max(EDIT_SECTIONS.length);

export const editSaveSchema = z.object({
  recipe: recipeSchema,
  baseVersion: z.number().int().min(0).nullable(),
});
/** ids are additionally capped by the member's plan batch size in the route. */
export const editBulkSchema = z
  .object({
    ids: z.array(uuid).min(1).max(500),
    recipe: recipeSchema.nullable(),
    sections: sectionsSchema,
  })
  .refine((b) => b.recipe === null || b.sections.length > 0, 'sections required');

const recipeName = z
  .string()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
  .pipe(z.string().min(1).max(RECIPE_NAME_MAX));
/** Saved recipes never carry a crop. */
const savedRecipe = recipeSchema.transform((r): EditRecipe => pickSections(r, RECIPE_SECTIONS));
export const recipeCreateSchema = z.object({ name: recipeName, recipe: savedRecipe });
export const recipePatchSchema = z
  .object({ name: recipeName, recipe: savedRecipe })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'no changes');
