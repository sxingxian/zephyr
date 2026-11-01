import { describe, expect, it } from 'vitest';
import { cleanBase, guestDownloadName } from '../src/share/names';

describe('guest download names', () => {
  it('gallery name and zero-padded position, never the member file name', () => {
    expect(guestDownloadName('Smith Wedding', 0, 'web')).toBe('Smith Wedding 001-web.jpg');
    expect(guestDownloadName('Smith Wedding', 41, 'full')).toBe('Smith Wedding 042-full.jpg');
    expect(guestDownloadName('Big', 1233, 'web')).toBe('Big 1234-web.jpg');
  });

  it('strips path, control, bidi and invisible characters', () => {
    expect(guestDownloadName('../../etc/passwd', 0, 'web')).toBe('_.._etc_passwd 001-web.jpg');
    expect(guestDownloadName('a‮gpj.exe', 0, 'web')).toBe('a_gpj.exe 001-web.jpg');
    expect(guestDownloadName('x\u0000y\r\nz', 0, 'web')).toBe('x_y_z 001-web.jpg');
    expect(guestDownloadName('zero​width⁠here', 0, 'web')).toBe('zero_widthhere 001-web.jpg');
    expect(guestDownloadName('  ...  ', 0, 'web')).toBe('Photo 001-web.jpg');
    expect(guestDownloadName('a\ud800b', 0, 'web')).toBe('ab 001-web.jpg');
  });

  it('prefixes Windows device names and keeps within 120 code points (position never cut)', () => {
    expect(cleanBase('CON')).toBe('_CON');
    expect(cleanBase('lpt1')).toBe('_lpt1');
    const long = guestDownloadName('😀'.repeat(200), 6, 'web');
    expect(long.endsWith(' 007-web.jpg')).toBe(true);
    expect([...long.replace(/\.jpg$/, '')].length).toBeLessThanOrEqual(120);
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
