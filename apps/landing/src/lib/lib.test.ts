import { describe, expect, it } from 'vitest';
import { anim, anim2, viewAnim } from './motion';
import { kindAt, seeded } from './site';

describe('motion attributes', () => {
  it('encodes a preset, a range and from-values', () => {
    expect(anim('flyIn', 0.02, 0.26, { x: -300 })).toEqual({
      'data-anim': 'flyIn',
      'data-range': '0.020 0.260',
      'data-from': '{"x":-300}',
    });
  });
  it('joins two animations with a pipe', () => {
    const a = anim2(['flyIn', 0, 0.2, { y: 10 }], ['dimOut', 0.8, 0.86]);
    expect(a['data-anim']).toBe('flyIn|dimOut');
    expect(a['data-range']).toBe('0.000 0.200|0.800 0.860');
    expect(a['data-from']).toBe('{"y":10}|');
  });
  it('marks view-driven animations', () => {
    expect(viewAnim('develop')).toEqual({ 'data-view-anim': 'develop' });
  });
});

describe('seeded layout', () => {
  it('is deterministic so builds are reproducible', () => {
    const a = seeded(11);
    const b = seeded(11);
    expect([a.between(0, 100), a.between(0, 100)]).toEqual([b.between(0, 100), b.between(0, 100)]);
  });
  it('cycles sample scenes', () => {
    expect(kindAt(0)).toBe(kindAt(14));
  });
});
