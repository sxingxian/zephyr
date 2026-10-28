// biome-ignore-all lint/suspicious/noConsole: command-line output
// Renders through the WebGL shader in Chromium and checks it against the CPU reference (develop.ts).
// Usage: node apps/web/e2e/shader-check.mjs   (needs Playwright's Chromium; fails if any pixel is off by > 2/255)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Playwright is resolved from wherever it's installed (CI image or a global install), not a workspace dependency.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { port: 0 } });
await server.listen();
const port = server.config.server.port ?? server.httpServer?.address()?.port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${port}/e2e/shader.html`);
  await page.waitForFunction(() => window.__result, null, { timeout: 120_000 });
  const res = await page.evaluate(() => window.__result);
  if (res.error) {
    console.error(res.error);
    failed = true;
  } else {
    for (const r of res.results) {
      const ok = r.maxDiff <= 2;
      if (!ok) failed = true;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(36)} max diff ${r.maxDiff}/255 over ${r.pixels} px`,
      );
    }
    console.log(
      `slider re-render at 1600×1067 from a 4000×2667 source: ${res.fps.toFixed(1)} fps (${res.renderer})`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
