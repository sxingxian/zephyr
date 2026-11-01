// Writes dist/_headers after `vite build`: a strict Content-Security-Policy (with hashes for any inline
// scripts in the HTML) plus security and caching headers. Fails the build on inline event handlers.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const TURNSTILE = 'https://challenges.cloudflare.com';
const csp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' lets hash-wasm compile its SHA-256 WebAssembly (upload fingerprinting). It allows
  // WebAssembly compilation only, not JavaScript eval; the worker script itself is 'self'.
  `script-src 'self' 'wasm-unsafe-eval' ${TURNSTILE} ${[...hashes].join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${TURNSTILE}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

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
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Robots-Tag: noindex
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/icons/*
  Cache-Control: public, max-age=86400

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-cache
${guestBlock('/guest')}${guestBlock('/guest.html')}`;
writeFileSync(join(dist, '_headers'), headers);
console.log(`_headers written · ${pages.length} page(s) · ${hashes.size} inline script hash(es)`);
