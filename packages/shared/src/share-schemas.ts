import { z } from 'zod';
import {
  BRAND_ACCENTS,
  GALLERY_MESSAGE_MAX,
  GALLERY_NAME_MAX,
  GUEST_NAME_MAX,
  GUEST_NOTE_MAX,
  MAX_GALLERY_PHOTOS,
  PASSCODE_RE,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
} from './share-types';

/** Server-side request schemas for the phase 5 sharing API. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Plain text: control and bidi-override characters removed, whitespace collapsed, trimmed. */
const text = (max: number) =>
  z
    .string()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .transform((s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ''))
    .transform((s) =>
      s
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    )
    .pipe(z.string().max(max));
const line = (max: number) => text(max).transform((s) => s.replace(/\s+/g, ' '));
const extras = z
  .object({ favourites: z.boolean(), watermark: z.boolean(), branding: z.boolean(), accessLog: z.boolean() })
  .partial()
  .strict();
const downloads = z.enum(['none', 'web', 'full']);

export const galleryCreateSchema = z
  .object({
    name: line(GALLERY_NAME_MAX).pipe(z.string().min(1)),
    photoIds: z.array(uuid).min(1).max(MAX_GALLERY_PHOTOS),
    passcode: z.boolean().default(true),
    expiresOn: z.iso.date(),
    downloads,
    extras: extras.default({}),
    message: text(GALLERY_MESSAGE_MAX).optional(),
  })
  .strict();
export const galleryPatchSchema = z
  .object({
    name: line(GALLERY_NAME_MAX).pipe(z.string().min(1)),
    expiresOn: z.iso.date(),
    downloads,
    extras,
    message: text(GALLERY_MESSAGE_MAX).nullable(),
    unpause: z.literal(true),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'no changes');
export const galleryPhotosSchema = z
  .object({ add: z.array(uuid).max(MAX_GALLERY_PHOTOS), remove: z.array(uuid).max(MAX_GALLERY_PHOTOS) })
  .partial()
  .strict()
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, 'no changes');
export const brandingSchema = z
  .object({
    studioName: line(60).nullable(),
    accent: z.enum(BRAND_ACCENTS).nullable(),
    watermark: z
      .object({
        kind: z.enum(['text', 'logo']),
        text: line(60).nullable(),
        position: z.enum(['bottom-right', 'bottom-left', 'centre', 'tiled']),
        opacity: z.number().int().min(10).max(90),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export const guestUnlockSchema = z
  .object({ passcode: z.string().regex(PASSCODE_RE), turnstileToken: z.string().min(1).max(2048).optional() })
  .strict();
export const guestSendSchema = z
  .object({ name: line(GUEST_NAME_MAX).pipe(z.string().min(1)), note: text(GUEST_NOTE_MAX).optional() })
  .strict();
export const guestReportSchema = z
  .object({
    reason: z.enum(REPORT_REASONS),
    photoId: uuid.optional(),
    details: text(REPORT_DETAILS_MAX).optional(),
    turnstileToken: z.string().min(1).max(2048),
  })
  .strict();
