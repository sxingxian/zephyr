import { describe, expect, it } from 'vitest';
import { galleryCreateSchema, guestSendSchema, guestUnlockSchema } from './share-schemas';
import { GALLERY_TOKEN_RE } from './share-types';

const id = '7d3f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
describe('sharing schemas', () => {
  it('cleans names and defaults the passcode on', () => {
    const g = galleryCreateSchema.parse({
      name: '  Tan‮ &  Wei ',
      photoIds: [id],
      expiresOn: '2026-12-01',
      downloads: 'web',
    });
    expect(g.name).toBe('Tan & Wei');
    expect(g.passcode).toBe(true);
    expect(g.extras).toEqual({});
  });
  it('rejects unknown keys, upper-case ids and empty selections', () => {
    const base = { name: 'x', photoIds: [id], expiresOn: '2026-12-01', downloads: 'web' };
    expect(galleryCreateSchema.safeParse({ ...base, evil: 1 }).success).toBe(false);
    expect(galleryCreateSchema.safeParse({ ...base, photoIds: [id.toUpperCase()] }).success).toBe(false);
    expect(galleryCreateSchema.safeParse({ ...base, photoIds: [] }).success).toBe(false);
  });
  it('passcodes are exactly six digits', () => {
    expect(guestUnlockSchema.safeParse({ passcode: '042719' }).success).toBe(true);
    for (const p of ['42719', '4271930', '42719a', ' 427193', '٤٢٧١٩٣'])
      expect(guestUnlockSchema.safeParse({ passcode: p }).success).toBe(false);
  });
  it('guest names are one line of plain text', () => {
    expect(guestSendSchema.parse({ name: ' Li\nYing\u0007 ', note: 'a\n\n\n\nb' })).toEqual({
      name: 'Li Ying',
      note: 'a\n\nb',
    });
    expect(guestSendSchema.safeParse({ name: '   ' }).success).toBe(false);
  });
  it('link tokens are 43 base64url characters', () => {
    expect(GALLERY_TOKEN_RE.test('k7Qx2mVb9RtL4wNp8sZcJ3dF6hYq1aE0-_abcdefghi')).toBe(true);
    expect(GALLERY_TOKEN_RE.test('k7Qx2mVb9RtL4wNp8sZcJ3dF6hYq1aE0/_abcdefghi')).toBe(false);
  });
});
