// Renders the PWA icons (PNG) from the brand mark with the bundled Chromium. Run after changing the mark:
//   node apps/web/scripts/icons.mjs     (outputs are committed in public/icons)
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const mark = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><g transform="translate(-8 2)"><circle cx="100" cy="128" r="54" fill="${fill}"/><g fill="none" stroke="${fill}" stroke-width="30" stroke-linecap="round"><path d="M80 92 L72 26"/><path d="M118 90 C120 58 132 38 168 30"/></g></g></svg>`;
const page = (size, scale, radius) =>
  `<html><body style="margin:0"><div style="width:${size}px;height:${size}px;background:#2D5FD3;border-radius:${radius}px;display:flex;align-items:center;justify-content:center"><div style="width:${size * scale}px;height:${size * scale}px">${mark('#FFFFFF')}</div></div></body></html>`;

const jobs = [
  ['icon-192.png', 192, 0.62, 0],
  ['icon-512.png', 512, 0.62, 0],
  ['icon-maskable-512.png', 512, 0.5, 0], // content inside the 80% safe zone
  ['apple-touch-icon.png', 180, 0.62, 0],
];
const browser = await chromium.launch();
for (const [name, size, scale, radius] of jobs) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  await p.setContent(page(size, scale, radius));
  await p.screenshot({ path: join(out, name), omitBackground: false });
  await p.close();
}
await browser.close();
console.log('icons written to', out);
