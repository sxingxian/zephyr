import { describe, expect, it } from 'vitest';
import { bulkSchema, filenameSchema, photoMetadataSchema, uploadCreateSchema } from './library-schemas';
import { MAX_UPLOAD_BATCH } from './library-types';

describe('library schemas', () => {
  it('keeps only the base name of an upload, without control characters', () => {
    expect(filenameSchema.parse('C:\\Users\\mei\\IMG_1.jpg')).toBe('IMG_1.jpg');
    expect(filenameSchema.parse('../../etc/passwd')).toBe('passwd');
    expect(filenameSchema.parse(' bell\u0007.png ')).toBe('bell.png');
    expect(filenameSchema.safeParse('dir/').success).toBe(false);
    expect(filenameSchema.safeParse('x'.repeat(256)).success).toBe(false);
  });

  it('checks upload batches: hash format, size and batch length', () => {
    const file = { name: 'a.jpg', size: 10, sha256: 'a'.repeat(64) };
    expect(uploadCreateSchema.safeParse({ files: [file] }).success).toBe(true);
    expect(uploadCreateSchema.safeParse({ files: [{ ...file, sha256: 'A'.repeat(64) }] }).success).toBe(
      false,
    );
    expect(uploadCreateSchema.safeParse({ files: [{ ...file, size: 0 }] }).success).toBe(false);
    expect(uploadCreateSchema.safeParse({ files: Array(MAX_UPLOAD_BATCH + 1).fill(file) }).success).toBe(
      false,
    );
  });

  it('range-checks EXIF metadata', () => {
    expect(photoMetadataSchema.safeParse({ iso: 400, takenAt: '2026-06-01T10:00:00+08:00' }).success).toBe(
      true,
    );
    expect(photoMetadataSchema.safeParse({ takenAt: '2026-06-01 10:00' }).success).toBe(false);
    expect(photoMetadataSchema.safeParse({ orientation: 9 }).success).toBe(false);
    expect(photoMetadataSchema.parse({ cameraModel: 'X-T5', GPSLatitude: 1.3 })).toEqual({
      cameraModel: 'X-T5',
    });
  });

  it('needs an album for album actions', () => {
    const ids = ['00000000-0000-4000-8000-000000000001'];
    expect(bulkSchema.safeParse({ ids, action: 'add_to_album' }).success).toBe(false);
    expect(bulkSchema.safeParse({ ids, action: 'trash' }).success).toBe(true);
  });
});
