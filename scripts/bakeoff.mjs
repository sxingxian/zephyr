#!/usr/bin/env node
/**
 * Background-removal bake-off (docs/phase-6.md, launch gates): runs the same photos through Runware's
 * BiRefNet and fal's Bria RMBG 2.0 and writes a side-by-side page to judge them on.
 *
 *   RUNWARE_API_KEY=… FAL_KEY=… node scripts/bakeoff.mjs <folder of ≤ 50 JPEGs, ≤ 2048 px> <output folder>
 *
 * Optional: RUNWARE_MODEL (default runware:112@5), FAL_MODEL (default fal-ai/bria/background/remove).
 * Calls the providers directly (no gateway), sends fal's no-storage header, and never writes the keys anywhere.
 * Use photos you have the rights to; nothing here uploads them anywhere else.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const [, , inDir, outDir] = process.argv;
/** Read at run time only (a local script; not a Turborepo task input). */
const envVar = (name) => process.env[name];
const RUNWARE_KEY = envVar('RUNWARE_API_KEY');
const FAL_KEY = envVar('FAL_KEY');
const RUNWARE_MODEL = envVar('RUNWARE_MODEL') || 'runware:112@5';
const FAL_MODEL = envVar('FAL_MODEL') || 'fal-ai/bria/background/remove';
if (!inDir || !outDir || !RUNWARE_KEY || !FAL_KEY) {
  console.error(
    'Usage: RUNWARE_API_KEY=… FAL_KEY=… node scripts/bakeoff.mjs <photos folder> <output folder>',
  );
  process.exit(2);
}
if (
  !/^runware:\d{1,6}@\d{1,4}$/.test(RUNWARE_MODEL) ||
  !/^fal-ai\/[a-z0-9][a-z0-9/_.-]{1,100}$/.test(FAL_MODEL)
) {
  console.error('Unexpected model id.');
  process.exit(2);
}

const MAX = 50;
const TIMEOUT = 60_000;
const files = (await readdir(inDir))
  .filter((f) => /\.(jpe?g)$/i.test(f))
  .sort()
  .slice(0, MAX);
if (!files.length) {
  console.error('No JPEGs found.');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

async function runware(b64) {
  const t0 = Date.now();
  const res = await fetch('https://api.runware.ai/v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RUNWARE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        taskType: 'removeBackground',
        taskUUID: crypto.randomUUID(),
        model: RUNWARE_MODEL,
        inputs: { image: `data:image/jpeg;base64,${b64}` },
        outputType: 'base64Data',
        outputFormat: 'PNG',
        includeCost: true,
      },
    ]),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
  const json = await res.json();
  const task = (json.data ?? []).find((t) => typeof t?.imageBase64Data === 'string');
  if (!task) return { ok: false, ms, error: 'no image' };
  return {
    ok: true,
    ms,
    png: Buffer.from(task.imageBase64Data, 'base64'),
    cost: typeof task.cost === 'number' ? task.cost : null,
  };
}

async function fal(b64) {
  const t0 = Date.now();
  const res = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json', 'X-Fal-Store-IO': '0' },
    body: JSON.stringify({ image_url: `data:image/jpeg;base64,${b64}`, sync_mode: true }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
  const json = await res.json();
  const url = json?.image?.url;
  if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,'))
    return { ok: false, ms, error: 'no inline image' };
  return {
    ok: true,
    ms,
    png: Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'),
    cost: 0.018,
  };
}

async function attempt(fn, b64) {
  try {
    return await fn(b64);
  } catch (err) {
    return { ok: false, ms: TIMEOUT, error: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

const rows = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    const bytes = await readFile(join(inDir, f));
    const b64 = bytes.toString('base64');
    const stem = basename(f, extname(f)).replace(/[^A-Za-z0-9_-]/g, '_');
    await writeFile(join(outDir, `${stem}.jpg`), bytes);
    const [r, b] = await Promise.all([attempt(runware, b64), attempt(fal, b64)]);
    if (r.ok) await writeFile(join(outDir, `${stem}.runware.png`), r.png);
    if (b.ok) await writeFile(join(outDir, `${stem}.fal.png`), b.png);
    rows.push({ stem, r, b });
    console.log(`${f}: runware ${r.ok ? `${r.ms} ms` : r.error} · fal ${b.ok ? `${b.ms} ms` : b.error}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
rows.sort((x, y) => x.stem.localeCompare(y.stem));

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const median = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const summary = (key) => {
  const ok = rows.filter((x) => x[key].ok);
  const cost = ok.reduce((n, x) => n + (x[key].cost ?? 0), 0);
  return `${ok.length}/${rows.length} ok · median ${median(ok.map((x) => x[key].ms)) ?? '–'} ms · US$${cost.toFixed(4)}`;
};
const cell = (stem, side, res) =>
  res.ok
    ? `<figure><img src="${esc(stem)}.${side}.png" alt="${esc(side)} cut-out of ${esc(stem)}"><figcaption>${res.ms} ms</figcaption></figure>`
    : `<figure class="fail"><div>${esc(res.error)}</div></figure>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Zephyr background-removal bake-off</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#0d1117}
table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #e3e6eb;vertical-align:top;text-align:left}
img{max-width:320px;max-height:240px;display:block}
.chk img{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
.bg-dark .chk img{background:#0d1117}
figure{margin:0}figcaption{color:#566070;font-size:12px}.fail div{width:200px;height:120px;display:grid;place-items:center;background:#fdecec;color:#b42318}
</style></head><body>
<h1>Background-removal bake-off</h1>
<p>Runware ${esc(RUNWARE_MODEL)}: ${esc(summary('r'))}<br>fal ${esc(FAL_MODEL)}: ${esc(summary('b'))}</p>
<p><label><input type="checkbox" id="dark"> Dark background</label> · Judge hair, fine edges, holes and shadows; note which you prefer per row.</p>
<table><thead><tr><th>Photo</th><th>Runware</th><th>fal · Bria</th></tr></thead><tbody>
${rows
  .map(
    (x) =>
      `<tr><td><figure><img src="${esc(x.stem)}.jpg" alt="${esc(x.stem)}"><figcaption>${esc(x.stem)}</figcaption></figure></td><td class="chk">${cell(x.stem, 'runware', x.r)}</td><td class="chk">${cell(x.stem, 'fal', x.b)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>
<script>document.getElementById('dark').addEventListener('change',e=>document.body.classList.toggle('bg-dark',e.target.checked))</script>
</body></html>`;
await writeFile(join(outDir, 'index.html'), html);
console.log(`Wrote ${resolve(outDir, 'index.html')}`);
