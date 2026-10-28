import { z } from 'zod';
import { MAX_UPLOAD_BATCH } from './library-types';

/** Server-side request schemas for the phase 3 library API. */
const uuid = z.string().uuid();
/** Display filename: no path, no control characters. */
export const filenameSchema = z
  .string()
  .transform((s) => s.split(/[\\/]/).pop() ?? '')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  .transform((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
  .pipe(z.string().min(1).max(255));

export const uploadCreateSchema = z.object({
  files: z
    .array(
      z.object({
        name: filenameSchema,
        size: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 ** 3),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        lastModified: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(MAX_UPLOAD_BATCH),
});
const short = (n: number) => z.string().trim().max(n);
export const photoMetadataSchema = z
  .object({
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
    takenAt: z.iso.datetime({ offset: true }),
    cameraMake: short(64),
    cameraModel: short(64),
    lens: short(96),
    focalLengthMm: z.number().min(0).max(5000),
    aperture: z.number().min(0).max(128),
    exposureSeconds: z.number().min(0).max(3600),
    iso: z.number().int().min(0).max(10_000_000),
    orientation: z.number().int().min(1).max(8),
  })
  .partial();
export const uploadCompleteSchema = z.object({ metadata: photoMetadataSchema });
export const photoListQuerySchema = z.object({
  view: z.enum(['library', 'favourites', 'raw', 'trash']).optional(),
  albumId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(['taken', 'added']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const photoPatchSchema = z
  .object({ favourite: z.boolean(), filename: filenameSchema })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'no changes');
export const bulkSchema = z
  .object({
    ids: z.array(uuid).min(1).max(500),
    action: z.enum([
      'favourite',
      'unfavourite',
      'trash',
      'restore',
      'delete_forever',
      'add_to_album',
      'remove_from_album',
    ]),
    albumId: uuid.optional(),
  })
  .refine((b) => !b.action.endsWith('album') || Boolean(b.albumId), 'albumId required');
export const albumCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  photoIds: z.array(uuid).max(500).optional(),
});
export const albumPatchSchema = z
  .object({ name: z.string().trim().min(1).max(80), coverPhotoId: uuid.nullable() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'no changes');
export const deleteAccountSchema = z.object({ confirm: z.literal('DELETE') });
