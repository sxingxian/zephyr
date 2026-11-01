import type { CleanupPhoto } from '@zephyr/shared/client';
import { describe, expect, it } from 'vitest';
import { groupCleanup, hamming, hashBits, MAX_BURST_NEIGHBOURS } from './cleanup';
import { groupCleanupOffThread } from './cleanupRun';

let n = 0;
const P = (phash: string, o: Partial<CleanupPhoto> = {}): CleanupPhoto => ({
  id: `p${String(++n).padStart(3, '0')}`,
  phash,
  sharpness: 400,
  takenAt: '2026-10-12T10:00:00+08:00',
  createdAt: '2026-10-13T00:00:00Z',
  sizeBytes: 1000,
  width: 4000,
  height: 3000,
  dupIgnored: false,
  blurIgnored: false,
  ...o,
});
/** Flips the given bit positions (0 = most significant) of a 16-hex hash. */
const flip = (hex: string, ...pos: number[]) => {
  let v = BigInt(`0x${hex}`);
  for (const p of pos) v ^= 1n << BigInt(63 - p);
  return v.toString(16).padStart(16, '0');
};

describe('cleanup grouping', () => {
  it('measures Hamming distance', () => {
    expect(hamming(hashBits('ffffffffffffffff') as bigint, hashBits('0000000000000000') as bigint)).toBe(64);
    expect(hashBits('xyz')).toBeNull();
  });

  it('groups near-identical photos at any time apart, keeps the sharpest, and skips ignored ones', () => {
    const base = 'a5c3f00f12345678';
    const a = P(base, { sharpness: 300, takenAt: '2020-01-01T00:00:00Z' });
    const b = P(flip(base, 1, 20, 40, 63), { sharpness: 900, sizeBytes: 500 }); // 4 bits, years later
    const c = P(flip(base, 0, 13, 26, 39, 52)); // 5 bits: too far
    const d = P(base, { dupIgnored: true });
    const r = groupCleanup([a, b, c, d]);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]?.photos.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(r.duplicates[0]?.keep).toBe(b.id);
    expect(r.duplicates[0]?.savings).toBe(1000);
  });

  it('finds similar bursts only when taken close together', () => {
    const base = '0f0f0f0f0f0f0f0f';
    const near = flip(base, 2, 9, 17, 25, 33, 41, 49, 57); // 8 bits
    const t0 = '2026-10-12T10:00:00Z';
    const r = groupCleanup([
      P(base, { takenAt: t0 }),
      P(near, { takenAt: '2026-10-12T10:00:30Z' }),
      P(flip(base, 3, 10, 18, 26, 34, 42, 50, 58), { takenAt: '2026-10-12T11:00:00Z' }), // an hour later: not the burst
    ]);
    expect(r.duplicates).toHaveLength(0);
    expect(r.bursts).toHaveLength(1);
    expect(r.bursts[0]?.photos).toHaveLength(2);
  });

  it('flags blurry photos against their burst or day, unless kept', () => {
    const day = '2026-10-14T09:00:00Z';
    const r = groupCleanup([
      P('1111111111111111', { takenAt: day, sharpness: 500 }),
      P('2222222222222222', { takenAt: day, sharpness: 520 }),
      P('3333333333333333', { takenAt: day, sharpness: 20 }),
      P('4444444444444444', { takenAt: day, sharpness: 15, blurIgnored: true }),
      P('5555555555555555', { takenAt: day, sharpness: 450 }),
    ]);
    expect(r.blurry.map((p) => p.sharpness)).toEqual([20]);
  });

  it('stays fast when thousands of photos share one time (a camera with no clock), client review #9', () => {
    // Random-looking hashes so no duplicates; every photo at the same instant.
    let x = 0x9e3779b97f4a7c15n;
    const photos = Array.from({ length: 6000 }, () => {
      x = (x * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return P(x.toString(16).padStart(16, '0'), { takenAt: '2001-01-01T00:00:00Z' });
    });
    const t0 = performance.now();
    groupCleanup(photos);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(MAX_BURST_NEIGHBOURS).toBeLessThanOrEqual(64);
  });

  it('groups on the main thread when there are no workers (tests, old browsers)', async () => {
    const base = 'a5c3f00f12345678';
    const r = await groupCleanupOffThread([P(base), P(flip(base, 3))]);
    expect(r.duplicates).toHaveLength(1);
  });
});
