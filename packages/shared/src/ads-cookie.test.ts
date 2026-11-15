import { describe, expect, it } from 'vitest';
import { readCookie, signAdsCookie, verifyAdsCookie } from './ads-cookie';

const SECRET = 'a-secret-of-sufficient-length';
const USER = '11111111-2222-4333-8444-555555555555';

describe('AdSense cookie value', () => {
  it('verifies for the member it was signed for, until it expires', async () => {
    const now = 1_800_000_000;
    const v = await signAdsCookie(SECRET, USER.toUpperCase(), now + 900);
    expect(v).toMatch(/^v1\.\d+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyAdsCookie(SECRET, v, now)).toBe(USER);
    expect(await verifyAdsCookie(SECRET, v, now + 900)).toBeNull();
  });

  it('refuses anything page script could write, another key, tampering, or no secret', async () => {
    const now = 1_800_000_000;
    const v = await signAdsCookie(SECRET, USER, now + 900);
    const [ver, exp, user, mac] = v.split('.') as [string, string, string, string];
    for (const bad of [
      '1',
      '',
      `${ver}.${Number(exp) + 1000}.${user}.${mac}`,
      `${ver}.${exp}.22222222-2222-4333-8444-555555555555.${mac}`,
      `v2.${exp}.${user}.${mac}`,
      `${v}.x`,
      `${ver}.${exp}.${user}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
    ])
      expect(await verifyAdsCookie(SECRET, bad, now), bad).toBeNull();
    expect(await verifyAdsCookie('another-secret-of-length', v, now)).toBeNull();
    expect(await verifyAdsCookie(undefined, v, now)).toBeNull();
    expect(await verifyAdsCookie('short', v, now)).toBeNull();
  });

  it('reads the first cookie of a name', () => {
    expect(readCookie('a=1; __Host-zads=v1.x; b=2', '__Host-zads')).toBe('v1.x');
    expect(readCookie('x__Host-zads=1', '__Host-zads')).toBeNull();
    expect(readCookie(null, '__Host-zads')).toBeNull();
  });
});
