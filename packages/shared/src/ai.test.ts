import { describe, expect, it } from 'vitest';
import {
  aiJobCreateSchema,
  aiMemberSettingsSchema,
  aiSettingsPatchSchema,
  aiSignalsSchema,
  cutoutApplySchema,
  facesSchema,
  personFacesSchema,
} from './ai-schemas';
import { type AiSettings, isRiskLowering } from './ai-types';
import { editBulkSchema, recipeSchema } from './edit-schemas';
import { mergeRecipe, normalizeRecipe, PASTE_SECTIONS } from './edit-types';
import { LABEL_SCENES, sceneForLabels } from './scene-map';

const MASK = 'b6000000-0000-4000-8000-000000000001';
const SETTINGS: AiSettings = {
  enabled: true,
  cloudPaused: false,
  features: {
    auto_enhance: true,
    hdr: true,
    color_match: true,
    cleanup: true,
    face_grouping: true,
    scene_tags: true,
    bg_removal: true,
  },
  bgProvider: 'runware',
  bgFallback: 'fal_bria',
  runwareModel: 'runware:112@5',
  falModel: 'fal-ai/bria/background/remove',
  sceneModel: '@cf/microsoft/resnet-50',
  bgCreditsPerPhoto: 1,
  costs: { runwareMicros: 600, falMicros: 18000, sceneMicros: 20 },
  caps: { total: 10, bgRemoval: 8, sceneTags: 2, perUser: 0.5 },
  alerts: [50, 80, 100],
  atCap: 'pause',
  alertTo: 'owners_finance',
  memberJobsPerMinute: 60,
  updatedAt: '2026-11-01T00:00:00Z',
  updatedBy: null,
};

describe('isRiskLowering', () => {
  it('lets switching off, pausing, lowering caps and adding alerts through', () => {
    expect(isRiskLowering(SETTINGS, { enabled: false })).toBe(true);
    expect(isRiskLowering(SETTINGS, { cloudPaused: true })).toBe(true);
    expect(isRiskLowering(SETTINGS, { features: { bg_removal: false, hdr: false } })).toBe(true);
    expect(isRiskLowering(SETTINGS, { caps: { total: 5, perUser: 0.25 } })).toBe(true);
    expect(isRiskLowering(SETTINGS, { memberJobsPerMinute: 10 })).toBe(true);
    expect(isRiskLowering({ ...SETTINGS, alerts: [80] }, { alerts: [50, 80] })).toBe(true);
    // Unchanged values count as no change.
    expect(isRiskLowering(SETTINGS, { bgProvider: 'runware', costs: { runwareMicros: 600 } })).toBe(true);
  });
  it('needs a recent passkey for anything that can raise spend or change providers', () => {
    expect(isRiskLowering({ ...SETTINGS, enabled: false }, { enabled: true })).toBe(false);
    expect(isRiskLowering({ ...SETTINGS, cloudPaused: true }, { cloudPaused: false })).toBe(false);
    expect(
      isRiskLowering(
        { ...SETTINGS, features: { ...SETTINGS.features, hdr: false } },
        { features: { hdr: true } },
      ),
    ).toBe(false);
    expect(isRiskLowering(SETTINGS, { caps: { bgRemoval: 9 } })).toBe(false);
    expect(isRiskLowering(SETTINGS, { alerts: [80, 100] })).toBe(false);
    expect(isRiskLowering(SETTINGS, { bgProvider: 'fal_bria' })).toBe(false);
    expect(isRiskLowering(SETTINGS, { runwareModel: 'runware:112@9' })).toBe(false);
    expect(isRiskLowering(SETTINGS, { costs: { falMicros: 1 } })).toBe(false);
    expect(isRiskLowering(SETTINGS, { atCap: 'alert_only' })).toBe(false);
    expect(isRiskLowering(SETTINGS, { bgCreditsPerPhoto: 2 })).toBe(false);
    expect(isRiskLowering(SETTINGS, { memberJobsPerMinute: 61 })).toBe(false);
  });
});

describe('cut-out recipes', () => {
  it('normalises a cut-out: lower-case ids, colour only with bg colour, no shadow on transparent', () => {
    expect(
      normalizeRecipe({
        v: 1,
        cutout: {
          mask: MASK.toUpperCase(),
          bg: 'color',
          color: '#ABCDEF',
          shadow: 'soft',
          shadowStrength: 40.4,
        },
      }),
    ).toEqual({
      v: 1,
      cutout: { mask: MASK, bg: 'color', color: '#abcdef', shadow: 'soft', shadowStrength: 40 },
    });
    expect(
      normalizeRecipe({
        v: 1,
        cutout: { mask: MASK, bg: 'transparent', shadow: 'soft', shadowStrength: 40 },
      }),
    ).toEqual({
      v: 1,
      cutout: { mask: MASK, bg: 'transparent' },
    });
    expect(
      normalizeRecipe({
        v: 1,
        cutout: { mask: MASK, bg: 'white', color: '#000000', softness: 99, shift: -3.3 },
      }),
    ).toEqual({
      v: 1,
      cutout: { mask: MASK, bg: 'white', softness: 20, shift: -3.5 },
    });
  });
  it('drops a cut-out without a valid mask id', () => {
    expect(normalizeRecipe({ v: 1, cutout: { mask: 'nope', bg: 'white' } })).toEqual({ v: 1 });
  });
  it('the schema rejects unknown keys and the paste schema never carries a cut-out', () => {
    expect(recipeSchema.safeParse({ v: 1, cutout: { mask: MASK, bg: 'white', url: 'x' } }).success).toBe(
      false,
    );
    expect(recipeSchema.safeParse({ v: 1, cutout: { mask: MASK, bg: 'white' } }).success).toBe(true);
    expect(editBulkSchema.safeParse({ ids: [MASK], recipe: { v: 1 }, sections: ['cutout'] }).success).toBe(
      false,
    );
    expect(PASTE_SECTIONS).not.toContain('cutout');
  });
  it('pasting keeps the target photo’s own cut-out', () => {
    const target = { v: 1 as const, cutout: { mask: MASK, bg: 'white' as const } };
    const pasted = mergeRecipe(target, { v: 1, light: { exposure: 1 } }, PASTE_SECTIONS);
    expect(pasted.cutout).toEqual({ mask: MASK, bg: 'white' });
    expect(pasted.light).toEqual({ exposure: 1 });
  });
});

describe('AI schemas', () => {
  it('cut-out apply', () => {
    expect(cutoutApplySchema.parse({ bg: 'color', color: '#AABBCC' })).toEqual({
      bg: 'color',
      color: '#aabbcc',
    });
    expect(cutoutApplySchema.safeParse({ bg: 'white', mask: MASK }).success).toBe(false);
  });
  it('jobs: background removal and device', () => {
    expect(
      aiJobCreateSchema.safeParse({ kind: 'bg_removal', photoIds: [MASK], apply: { bg: 'white' } }).success,
    ).toBe(true);
    expect(aiJobCreateSchema.safeParse({ kind: 'bg_removal', photoIds: [] }).success).toBe(false);
    const dev = aiJobCreateSchema.parse({
      kind: 'device',
      photoIds: [MASK.toUpperCase()],
      params: { steps: ['auto_enhance', 'hdr'], strength: 70 },
      device: '  Chrome\u0000 on Mac  ',
    });
    expect(dev.photoIds).toEqual([MASK]);
    expect(dev.kind === 'device' && dev.device).toBe('Chrome on Mac');
    expect(
      aiJobCreateSchema.safeParse({
        kind: 'device',
        photoIds: [MASK],
        params: { steps: ['color_match'] },
        device: 'Mac',
      }).success,
    ).toBe(false);
    expect(
      aiJobCreateSchema.safeParse({
        kind: 'device',
        photoIds: [MASK],
        params: { steps: ['hdr', 'hdr'] },
        device: 'Mac',
      }).success,
    ).toBe(false);
  });
  it('member settings need consent to turn face grouping on', () => {
    expect(aiMemberSettingsSchema.safeParse({ faceGrouping: true }).success).toBe(false);
    expect(
      aiMemberSettingsSchema.safeParse({
        faceGrouping: true,
        faceConsent: { version: 1, rightsConfirmed: true },
      }).success,
    ).toBe(true);
    expect(aiMemberSettingsSchema.safeParse({ faceGrouping: false }).success).toBe(true);
    expect(aiMemberSettingsSchema.safeParse({}).success).toBe(false);
    // Only the current wording can be agreed to.
    expect(
      aiMemberSettingsSchema.safeParse({
        faceGrouping: true,
        faceConsent: { version: 2, rightsConfirmed: true },
      }).success,
    ).toBe(false);
  });
  it('signals: hex hash, bounded numbers, at most 100', () => {
    const one = { id: MASK, phash: 'ABCDEF0123456789', sharpness: 12.5, brightness: 0.4, night: false };
    expect(aiSignalsSchema.parse({ v: 1, photos: [one] }).photos[0]?.phash).toBe('abcdef0123456789');
    expect(aiSignalsSchema.safeParse({ v: 1, photos: [{ ...one, brightness: 2 }] }).success).toBe(false);
    expect(aiSignalsSchema.safeParse({ v: 1, photos: Array.from({ length: 101 }, () => one) }).success).toBe(
      false,
    );
    expect(aiSignalsSchema.safeParse({ v: 2, photos: [one] }).success).toBe(false);
  });
  it('faces: 684-character embeddings, boxes inside the photo, scores above the floor', () => {
    const emb = btoa(String.fromCharCode(...new Uint8Array(new Float32Array(128).fill(0.088).buffer)));
    expect(emb).toHaveLength(684);
    const face = { box: [0.1, 0.1, 0.2, 0.2], score: 0.9, embedding: emb };
    expect(facesSchema.safeParse({ v: 1, photos: [{ id: MASK, faces: [face] }] }).success).toBe(true);
    expect(
      facesSchema.safeParse({ v: 1, photos: [{ id: MASK, faces: [{ ...face, box: [0.9, 0.1, 0.2, 0.2] }] }] })
        .success,
    ).toBe(false);
    expect(
      facesSchema.safeParse({ v: 1, photos: [{ id: MASK, faces: [{ ...face, score: 0.5 }] }] }).success,
    ).toBe(false);
    expect(
      facesSchema.safeParse({ v: 1, photos: [{ id: MASK, faces: [{ ...face, embedding: 'AAAA' }] }] })
        .success,
    ).toBe(false);
  });
  it('person faces: exactly one target', () => {
    expect(personFacesSchema.safeParse({ action: 'remove', photoIds: [MASK] }).success).toBe(true);
    expect(personFacesSchema.safeParse({ action: 'remove', photoIds: [MASK], faceIds: [MASK] }).success).toBe(
      false,
    );
    expect(personFacesSchema.safeParse({ action: 'move', to: 'new', faceIds: [MASK] }).success).toBe(true);
    expect(personFacesSchema.safeParse({ action: 'move', to: 'somebody', faceIds: [MASK] }).success).toBe(
      false,
    );
  });
  it('admin settings: caps rounded to cents, model ids checked, fallback differs', () => {
    expect(aiSettingsPatchSchema.parse({ caps: { total: 12.345 } }).caps?.total).toBe(12.35);
    expect(aiSettingsPatchSchema.parse({ alerts: [100, 50, 50] }).alerts).toEqual([50, 100]);
    expect(aiSettingsPatchSchema.safeParse({ runwareModel: 'https://evil.example/x' }).success).toBe(false);
    expect(aiSettingsPatchSchema.safeParse({ falModel: 'fal-ai/bria/../../admin' }).success).toBe(false);
    expect(aiSettingsPatchSchema.safeParse({ falModel: 'fal-ai/bria/background/remove' }).success).toBe(true);
    expect(aiSettingsPatchSchema.safeParse({ sceneModel: '@cf/microsoft/resnet-50' }).success).toBe(true);
    expect(aiSettingsPatchSchema.safeParse({ bgProvider: 'runware', bgFallback: 'runware' }).success).toBe(
      false,
    );
    expect(aiSettingsPatchSchema.safeParse({ caps: { total: -1 } }).success).toBe(false);
    expect(aiSettingsPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe('sceneForLabels', () => {
  it('maps Workers AI labels (any case) to scenes and adds up scores', () => {
    expect(
      sceneForLabels([
        { label: 'GOLDEN RETRIEVER', score: 0.5 },
        { label: 'Labrador retriever', score: 0.2 },
        { label: 'seashore', score: 0.1 },
      ]),
    ).toEqual([{ scene: 'pets', score: 0.7 }]);
    expect(sceneForLabels([{ label: 'pizza, pizza pie', score: 0.9 }])).toEqual([
      { scene: 'food', score: 0.9 },
    ]);
    expect(
      sceneForLabels([
        { label: 'ALP', score: 0.3 },
        { label: 'volcano', score: 0.3 },
      ]),
    ).toEqual([{ scene: 'mountains', score: 0.6 }]);
  });
  it('ignores unknown and malformed labels', () => {
    expect(sceneForLabels([{ label: 'abacus', score: 0.9 }])).toEqual([]);
    expect(sceneForLabels([{ label: 'pug', score: Number.NaN }] as never)).toEqual([]);
  });
  it('covers every scene but Night', () => {
    expect(new Set(Object.values(LABEL_SCENES)).size).toBe(13);
  });
});
