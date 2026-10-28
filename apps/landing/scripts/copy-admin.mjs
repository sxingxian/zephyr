// Copies the admin console build (apps/admin/dist) into dist/admin so the landing Worker serves it at
// /admin. Turbo builds @zephyr/admin first (it's a devDependency of this package).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const adminDist = join(dirname(require.resolve('@zephyr/admin/package.json')), 'dist');
if (!existsSync(join(adminDist, 'index.html'))) {
  throw new Error(
    'apps/admin/dist is missing: run `pnpm --filter @zephyr/admin build` (turbo does this for you).',
  );
}
const out = join(here, '..', 'dist', 'admin');
rmSync(out, { recursive: true, force: true });
cpSync(adminDist, out, { recursive: true });
console.log('admin console copied to dist/admin');
