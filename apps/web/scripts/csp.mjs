// Writes dist/_headers after `vite build`: a strict Content-Security-Policy (with hashes for any inline
// scripts in the HTML) plus security and caching headers. Fails the build on inline event handlers.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AD_PAGE_PATTERNS, adsAllowedOn } from '../worker/adPages.js';
import { ADSENSE_SOURCES, APP_HEADERS, APP_HEADERS_FILE, appCsp } from '../worker/appHeaders.js';
import { GUEST_HEADERS } from '../worker/guestHeaders.js';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const walk = (d) =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = walk(dist).filter((f) => f.endsWith('.html'));

const hashes = new Set();
for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  // The guest page's policy has no room for script hashes: it must not carry any inline script at all.
  if (file.endsWith('guest.html') && /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html))
    throw new Error('guest.html must not contain inline scripts');
  if (file.endsWith('guest.html') && /registerSW|serviceWorker/.test(html))
    throw new Error('guest.html must not register the service worker');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (/type="application\/(ld\+)?json"/.test(m[0])) continue;
    hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  }
  const handler = html.match(/\son[a-z]+=["']/i);
  if (handler) throw new Error(`Inline event handler in ${file}: ${handler[0]}`);
}

// Phase 8: the app Worker serves every HTML response with one of two policies, both built in
// worker/appHeaders.js: the default (written below) and, only while AdSense is on in Admin, a variant that
// adds Google's ad and consent hosts to four directives. Both are checked here before anything ships.
const hashList = [...hashes];
const csp = appCsp(hashList);
const adsenseCsp = appCsp(hashList, { adsense: true });
checkPolicies(csp, adsenseCsp);
checkAdPages();
checkServiceWorker();
writeFileSync(join(dist, APP_HEADERS_FILE.slice(1)), `${JSON.stringify({ hashes: hashList })}\n`);

// The guest page (served for /g/* by the Worker, which sets these same headers) replaces the app's policy.
const guestBlock = (path) =>
  `\n${path}\n${Object.keys(GUEST_HEADERS)
    .filter((k) => k !== 'Content-Type')
    .map((k) => `  ! ${k}`)
    .join('\n')}\n${Object.entries(GUEST_HEADERS)
    .filter(([k]) => k !== 'Content-Type')
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')}\n`;

const headers = `/*
  Content-Security-Policy: ${csp}
${Object.entries(APP_HEADERS)
  .map(([k, v]) => `  ${k}: ${v}`)
  .join('\n')}
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/icons/*
  Cache-Control: public, max-age=86400

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-store
${guestBlock('/guest')}${guestBlock('/guest.html')}`;
writeFileSync(join(dist, '_headers'), headers);

function directivesOf(policy) {
  return new Map(
    policy.split(';').map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k, v];
    }),
  );
}
function checkPolicies(strict, widened) {
  const a = directivesOf(strict);
  const b = directivesOf(widened);
  const fail = (m) => {
    throw new Error(`CSP check failed: ${m}`);
  };
  for (const [name, p] of [
    ['default', a],
    ['AdSense', b],
  ]) {
    const script = p.get('script-src') ?? [];
    if (script.some((s) => s === "'unsafe-inline'" || s === "'unsafe-eval'" || s === '*' || s === 'https:'))
      fail(`${name} script-src allows inline, eval or any host`);
    if (script.some((s) => s.includes('*'))) fail(`${name} script-src has a wildcard host`);
    for (const d of ['object-src', 'base-uri', 'frame-ancestors'])
      if ((p.get(d) ?? []).join(' ') !== "'none'") fail(`${name} ${d} must be 'none'`);
    if ((p.get('default-src') ?? []).join(' ') !== "'self'") fail(`${name} default-src must be 'self'`);
  }
  // The default policy names no Google host at all, and only Turnstile as a third party.
  if (/google|doubleclick|gstatic|adtrafficquality/.test(strict))
    fail('the default policy names a Google host');
  const thirdParty = [...a.values()].flat().filter((s) => /^https:\/\//.test(s));
  if (thirdParty.some((s) => s !== 'https://challenges.cloudflare.com'))
    fail('the default policy allows a third party other than Turnstile');
  // The AdSense variant differs only by adding the listed Google hosts to the four listed directives.
  if ([...a.keys()].join() !== [...b.keys()].join()) fail('the two policies have different directives');
  for (const [d, base] of a) {
    const wide = b.get(d) ?? [];
    const added = wide.filter((s) => !base.includes(s));
    if (base.some((s) => !wide.includes(s))) fail(`the AdSense policy drops a source from ${d}`);
    const allowed = ADSENSE_SOURCES[d] ?? [];
    if (added.some((s) => !allowed.includes(s))) fail(`the AdSense policy adds an unexpected source to ${d}`);
    if (allowed.length && added.length !== allowed.length)
      fail(`the AdSense policy is missing hosts in ${d}`);
  }
  for (const list of Object.values(ADSENSE_SOURCES))
    if (list.some((s) => !/^https:\/\/[a-z0-9.-]+$/.test(s)))
      fail('AdSense sources must be exact https hosts');
}
// The Worker gives the AdSense policy only to documents on these pages, and the app keeps Google's script only
// on them. They must stay anchored, and never cover a page with secrets or member actions.
function checkAdPages() {
  const fail = (m) => {
    throw new Error(`Ad pages check failed: ${m}`);
  };
  for (const re of AD_PAGE_PATTERNS)
    if (!re.source.startsWith('^\\/') || !re.source.endsWith('$') || re.flags) fail(`${re} must be anchored`);
  const sensitive = [
    '/index.html',
    '/sign-in',
    '/sign-in/code',
    '/sign-up',
    '/join',
    '/welcome/passkey',
    '/settings',
    '/settings/security',
    '/settings/sharing',
    '/settings/billing',
    '/settings/team',
    '/share/new',
    '/settings/ai',
    '/settings/invites',
    '/settings/about',
    '/billing/return',
    '/plans',
    '/team/accept',
    '/shared',
    '/shared/abc',
    '/shared/abc/settings',
    '/photo/abc',
    '/edit/abc',
    '/cleanup',
    '/trash',
    '/you',
    '/suspended',
    '/account-deleted',
    '/g/abc',
  ];
  for (const p of sensitive) if (adsAllowedOn(p)) fail(`${p} must not be an ad page`);
  if (!adsAllowedOn('/')) fail('the Library must be an ad page');
}

console.log(
  `_headers written · ${pages.length} page(s) · ${hashes.size} inline script hash(es) · CSP variants, ad pages and service worker checked (default, AdSense; no cache reads)`,
);

// Phase 8: Google's AdSense script runs in Free members' library pages with this origin, and Cache Storage is
// writable from there. The service worker must never serve anything from it: no precache list, no cache reads,
// no Workbox runtime (only deleting old caches is allowed).
function checkServiceWorker() {
  const fail = (m) => {
    throw new Error(`Service worker check failed: ${m}`);
  };
  const files = walk(dist).map((f) => f.slice(dist.length + 1));
  const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
  if (/__WB_MANIFEST|precache|workbox-(core|precaching|routing|strategies)/i.test(sw))
    fail('sw.js carries a precache list or Workbox runtime');
  const cacheCalls = [...sw.matchAll(/\bcaches\.(\w+)/g)].map((m) => m[1]);
  if (cacheCalls.some((c) => c !== 'keys' && c !== 'delete'))
    fail(`sw.js uses caches.${cacheCalls.join(', caches.')}`);
  if (/\.match\(|\.matchAll\(|cache\.put|\.addAll\(/.test(sw)) fail('sw.js reads or fills a cache');
  if (/\bimport\s*\(|importScripts|^\s*import\s|\bexport\s/m.test(sw)) fail('sw.js loads other code');
  if (files.some((f) => /^workbox-.*\.js$/.test(f))) fail('a Workbox runtime file was emitted');
}
