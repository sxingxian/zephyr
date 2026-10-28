import { describe, expect, it } from 'vitest';
import { editBulkSchema, recipeCreateSchema, recipeSchema } from './edit-schemas';
import {
  changedSections,
  EMPTY_RECIPE,
  isEmptyRecipe,
  mergeRecipe,
  normalizeRecipe,
  recipeJson,
} from './edit-types';

describe('normalizeRecipe', () => {
  it('drops neutral values, clamps and rounds to the shared ranges', () => {
    const r = normalizeRecipe({
      v: 1,
      light: { exposure: 0.3333, contrast: 0, highlights: -250 },
      color: { tint: -0 },
      mixer: { orange: { saturation: 10.6 }, blue: { hue: 0 } },
      crop: {
        angle: 2.44,
        quarterTurns: 5,
        flipH: false,
        rect: { x: 0, y: 0, w: 1, h: 1 },
        aspect: 'original',
      },
      bogus: { x: 1 },
    });
    expect(r).toEqual({
      v: 1,
      light: { exposure: 0.33, highlights: -100 },
      mixer: { orange: { saturation: 11 } },
      crop: { angle: 2.4, quarterTurns: 1 },
    });
  });
  it('never throws and treats junk as no change', () => {
    expect(normalizeRecipe(null)).toEqual(EMPTY_RECIPE);
    expect(normalizeRecipe({ light: { exposure: Number.NaN }, crop: { rect: { x: 'a' } } })).toEqual({
      v: 1,
    });
    expect(isEmptyRecipe({ v: 1, light: { exposure: 0.001 } })).toBe(true);
  });
  it('keeps the crop rectangle inside the image', () => {
    expect(normalizeRecipe({ v: 1, crop: { rect: { x: 0.9, y: 0.2, w: 0.5, h: 0.5 } } }).crop?.rect).toEqual({
      x: 0.5,
      y: 0.2,
      w: 0.5,
      h: 0.5,
    });
  });
  it('serialises the same edit identically', () => {
    expect(recipeJson({ v: 1, color: { tint: 3 }, light: { contrast: 4 } })).toBe(
      recipeJson({ light: { contrast: 4 }, color: { tint: 3 }, v: 1 }),
    );
  });
});

describe('mergeRecipe', () => {
  const target = { v: 1 as const, light: { exposure: 1 }, crop: { angle: 3 }, effects: { vignette: -20 } };
  const source = { v: 1 as const, light: { contrast: 10 }, color: { tint: 5 }, crop: { angle: -1 } };
  it('replaces ticked sections and keeps the rest', () => {
    expect(mergeRecipe(target, source, ['light', 'color', 'effects'])).toEqual({
      v: 1,
      light: { contrast: 10 },
      color: { tint: 5 },
      crop: { angle: 3 },
    });
  });
  it('lists changed sections', () => {
    expect(changedSections(target)).toEqual(['light', 'effects', 'crop']);
  });
});

describe('schemas', () => {
  it('rejects unknown keys and non-finite numbers', () => {
    expect(recipeSchema.safeParse({ v: 1, light: { exposure: 1, evil: 1 } }).success).toBe(false);
    expect(recipeSchema.safeParse({ v: 1, light: { exposure: Number.POSITIVE_INFINITY } }).success).toBe(
      false,
    );
    expect(recipeSchema.safeParse({ v: 2 }).success).toBe(false);
    expect(recipeSchema.safeParse(JSON.parse('{"v":1,"__proto__":{"x":1}}')).success).toBe(false);
  });
  it('saved recipes drop the crop and clean the name', () => {
    const r = recipeCreateSchema.parse({
      name: ' Warm\u0007 ',
      recipe: { v: 1, light: { exposure: 1 }, crop: { angle: 4 } },
    });
    expect(r).toEqual({ name: 'Warm', recipe: { v: 1, light: { exposure: 1 } } });
  });
  it('bulk needs sections unless reverting', () => {
    const id = '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
    expect(editBulkSchema.safeParse({ ids: [id], recipe: { v: 1 }, sections: [] }).success).toBe(false);
    expect(editBulkSchema.safeParse({ ids: [id], recipe: null, sections: [] }).success).toBe(true);
  });
});
