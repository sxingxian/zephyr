// biome-ignore-all lint/suspicious/noConsole: command-line output
// Manual check with a real camera RAW: node apps/web/e2e/raw-check.mjs <file.nef|cr2|arw> [outDir]
// Decodes it in Chromium through the RAW worker, renders it through the editor pipeline and writes PNGs.

import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const [file, outDir = '/tmp/zp4shots'] = process.argv.slice(2);
if (!file) {
  console.error('usage: raw-check.mjs <raw file> [outDir]');
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { port: 0 },
  plugins: [
    {
      name: 'raw-sample',
      configureServer(s) {
        s.middlewares.use('/__raw', (_req, res) => {
          res.setHeader('content-length', String(statSync(file).size));
          createReadStream(file).pipe(res);
        });
      },
    },
  ],
});
await server.listen();
const port = server.config.server.port ?? server.httpServer?.address()?.port;
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-precise-memory-info',
  ],
});
let code = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
  await page.goto(`http://localhost:${port}/e2e/raw.html`);
  await page.waitForFunction(() => window.__result, null, { timeout: 300_000 });
  const res = await page.evaluate(() => window.__result);
  if (res.error) {
    console.error(res.error);
    code = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    const save = (name, url) =>
      writeFileSync(`${outDir}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    if (res.preview) save('raw-camera-jpeg', res.preview.png);
    for (const [k, v] of Object.entries(res.shots)) save(`raw-${k}`, v);
    const { shots: _s, preview, ...rest } = res;
    console.log(JSON.stringify({ ...rest, preview: preview && { w: preview.w, h: preview.h } }));
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
