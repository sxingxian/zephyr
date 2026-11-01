import { z } from 'zod';
import {
  AI_FEATURES,
  BG_PROVIDERS,
  CAP_ALERTS,
  CUTOUT_BACKGROUNDS,
  CUTOUT_SHADOWS,
  DEVICE_LABEL_MAX,
  DEVICE_STEPS,
  FACE_CONSENT_VERSION,
  FACE_LIMITS,
  FACE_MODEL_VERSION,
  JOB_TITLE_MAX,
  PERSON_NAME_MAX,
  RUNNER_TOKEN_RE,
  SCENES,
  SIGNALS_VERSION,
} from './ai-types';

/** Server-side request schemas for the phase 6 Zephyr AI API (docs/phase-6.md). */
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const pct = z.number().int().min(0).max(100);
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim();
const text = (max: number) => z.string().transform(clean).pipe(z.string().min(1).max(max));

export const aiMemberSettingsSchema = z
  .object({
    faceGrouping: z.boolean(),
    /** Only the current wording can be agreed to. */
    faceConsent: z
      .object({ version: z.literal(FACE_CONSENT_VERSION), rightsConfirmed: z.literal(true) })
      .strict(),
    sceneTags: z.boolean(),
    cleanup: z.boolean(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'no changes')
  .refine((p) => p.faceGrouping !== true || p.faceConsent !== undefined, 'consent required');

export const cutoutApplySchema = z
  .object({
    bg: z.enum(CUTOUT_BACKGROUNDS),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .transform((s) => s.toLowerCase())
      .optional(),
    shadow: z.enum(CUTOUT_SHADOWS).optional(),
    shadowStrength: pct.optional(),
  })
  .strict();

export const deviceJobParamsSchema = z
  .object({
    steps: z
      .array(z.enum(DEVICE_STEPS))
      .min(1)
      .max(DEVICE_STEPS.length)
      .refine((a) => new Set(a).size === a.length, 'duplicate steps'),
    strength: pct.optional(),
    skin: z.boolean().optional(),
    hdrStrength: pct.optional(),
    reference: uuid.optional(),
    matchStrength: pct.optional(),
  })
  .strict()
  .refine((p) => !p.steps.includes('color_match') || p.reference !== undefined, 'reference required');

/** photoIds are additionally capped by the member's plan batch size in the route. */
const photoIds = z.array(uuid).min(1).max(2000);
export const aiJobCreateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bg_removal'),
      photoIds,
      apply: cutoutApplySchema.optional(),
      title: text(JOB_TITLE_MAX).optional(),
      force: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('device'),
      photoIds,
      params: deviceJobParamsSchema,
      title: text(JOB_TITLE_MAX).optional(),
      device: text(DEVICE_LABEL_MAX),
    })
    .strict(),
]);
export const aiJobRetrySchema = z.object({ itemIds: z.array(uuid).min(1).max(2000).optional() }).strict();
const runner = z.string().regex(RUNNER_TOKEN_RE);
export const deviceClaimSchema = z
  .object({ device: text(DEVICE_LABEL_MAX), runner: runner.optional() })
  .strict();
export const deviceProgressSchema = z
  .object({
    done: z.array(uuid).max(200).optional(),
    failed: z.array(uuid).max(200).optional(),
    runner: runner.optional(),
  })
  .strict();
export const jobListQuerySchema = z.object({
  state: z.enum(['running', 'finished', 'failed']).default('running'),
  cursor: z.string().max(200).optional(),
});

const hex16 = z
  .string()
  .regex(/^[0-9a-fA-F]{16}$/)
  .transform((s) => s.toLowerCase());
export const aiSignalsSchema = z
  .object({
    v: z.literal(SIGNALS_VERSION),
    photos: z
      .array(
        z
          .object({
            id: uuid,
            phash: hex16,
            sharpness: z.number().finite().min(0).max(65025),
            brightness: z.number().finite().min(0).max(1),
            night: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const cleanupIgnoreSchema = z
  .object({ kind: z.enum(['duplicates', 'blurry']), photoIds: z.array(uuid).min(1).max(500) })
  .strict();

/** 128 float32 little-endian = 512 bytes = 684 base64 characters (683 + one '='). */
const embedding = z.string().regex(/^[A-Za-z0-9+/]{683}=$/);
const unit = z.number().finite().min(0).max(1);
export const facesSchema = z
  .object({
    v: z.literal(FACE_MODEL_VERSION),
    photos: z
      .array(
        z
          .object({
            id: uuid,
            faces: z
              .array(
                z
                  .object({
                    box: z
                      .tuple([unit, unit, unit, unit])
                      .refine(([x, y, w, h]) => w > 0 && h > 0 && x + w <= 1.0001 && y + h <= 1.0001),
                    score: z.number().finite().min(FACE_LIMITS.minScore).max(1),
                    embedding,
                  })
                  .strict(),
              )
              .max(FACE_LIMITS.perPhoto),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const personPatchSchema = z
  .object({
    name: z
      .string()
      .transform(clean)
      .pipe(z.string().max(PERSON_NAME_MAX))
      .transform((s) => s || null)
      .nullable(),
    hidden: z.boolean(),
    coverFaceId: uuid,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'no changes');
export const personMergeSchema = z.object({ from: z.array(uuid).min(1).max(50) }).strict();
const targets = {
  photoIds: z.array(uuid).min(1).max(500).optional(),
  faceIds: z.array(uuid).min(1).max(500).optional(),
};
const oneTarget = (b: { photoIds?: string[]; faceIds?: string[] }) =>
  (b.photoIds ? 1 : 0) + (b.faceIds ? 1 : 0) === 1;
export const personFacesSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('remove'), ...targets }).strict(),
    z.object({ action: z.literal('confirm'), ...targets }).strict(),
    z.object({ action: z.literal('move'), to: z.union([uuid, z.literal('new')]), ...targets }).strict(),
  ])
  .refine(oneTarget, 'photoIds or faceIds');

export const sceneSchema = z.enum(SCENES);

// ---- admin ---------------------------------------------------------------------------------------------
const usd = z
  .number()
  .finite()
  .min(0)
  .max(10_000)
  .transform((n) => Math.round(n * 100) / 100);
const micros = z.number().int().min(0).max(1_000_000);
export const aiSettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    cloudPaused: z.boolean(),
    features: z
      .object(Object.fromEntries(AI_FEATURES.map((f) => [f, z.boolean()])))
      .partial()
      .strict(),
    bgProvider: z.enum(BG_PROVIDERS),
    bgFallback: z.enum([...BG_PROVIDERS, 'none']),
    runwareModel: z.string().regex(/^runware:\d{1,6}@\d{1,4}$/),
    falModel: z
      .string()
      .regex(/^fal-ai\/[a-z0-9][a-z0-9/_.-]{1,100}$/)
      .refine((m) => !m.includes('..') && !m.includes('//'), 'no path tricks'),
    sceneModel: z
      .string()
      .regex(/^@cf\/[a-z0-9][a-z0-9/_.-]{1,100}$/i)
      .refine((m) => !m.includes('..') && !m.includes('//'), 'no path tricks'),
    bgCreditsPerPhoto: z.number().int().min(1).max(20),
    costs: z.object({ runwareMicros: micros, falMicros: micros, sceneMicros: micros }).partial().strict(),
    caps: z.object({ total: usd, bgRemoval: usd, sceneTags: usd, perUser: usd }).partial().strict(),
    alerts: z
      .array(
        z.union(
          CAP_ALERTS.map((a) => z.literal(a)) as unknown as [
            z.ZodLiteral<50>,
            z.ZodLiteral<80>,
            z.ZodLiteral<100>,
          ],
        ),
      )
      .max(3)
      .transform((a) => [...new Set(a)].sort((x, y) => x - y)),
    atCap: z.enum(['pause', 'alert_only']),
    alertTo: z.enum(['owners', 'owners_finance']),
    memberJobsPerMinute: z.number().int().min(1).max(600),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'no changes')
  .refine((p) => !(p.bgProvider && p.bgFallback && p.bgProvider === p.bgFallback), 'fallback must differ');
