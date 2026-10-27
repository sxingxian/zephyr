// Copies brand assets (logo, mascot, sample scenes) from @zephyr/brand into public/brand so the
// landing page can serve them as static files. public/brand is generated; don't edit it by hand.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const brand = dirname(require.resolve('@zephyr/brand/package.json'));
const out = join(here, '..', 'public', 'brand');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const d of ['logo', 'mascot', 'samples'])
  cpSync(join(brand, 'assets', d), join(out, d), { recursive: true });
console.log('brand assets synced to public/brand');
