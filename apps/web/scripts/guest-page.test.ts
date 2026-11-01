import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The guest page's own HTML: no inline script (its CSP has no hashes), never the member app's service worker.
// Tests run from this package's folder.
const html = readFileSync(join(process.cwd(), 'guest.html'), 'utf8');

describe('guest.html', () => {
  it('has no inline scripts and loads only its own module', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain('src="/src/guest/main.tsx"');
    expect(scripts[0]?.[2]?.trim()).toBe('');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
  it('never registers the service worker and keeps the link token out of search engines and Referers', () => {
    expect(html).not.toMatch(/registerSW|serviceWorker|manifest/);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
    expect(html).toContain('<meta name="referrer" content="strict-origin" />');
  });
});
