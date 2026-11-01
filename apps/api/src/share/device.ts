/**
 * Coarse context for the access log (Studio): an approximate place from Cloudflare's request metadata and a
 * browser/OS family from the User-Agent. Never an IP address, never a full UA string.
 */
import type { Context } from 'hono';

const REGIONS =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;
const clean = (s: unknown, max: number) =>
  typeof s === 'string'
    ? s
        .replace(/[^\p{L}\p{M}\p{N} .,'()-]/gu, '')
        .trim()
        .slice(0, max) || null
    : null;

/** "Singapore", "Johor Bahru, Malaysia", or null. */
export function placeOf(c: Context): string | null {
  const cf = (c.req.raw as Request & { cf?: Record<string, unknown> }).cf;
  if (!cf) return null;
  const code = typeof cf.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : null;
  let country: string | null = null;
  try {
    country = code ? (REGIONS?.of(code) ?? code) : null;
  } catch {
    country = code;
  }
  const city = clean(cf.city, 60);
  if (city && country && city !== country) return `${city}, ${country}`;
  return city ?? country;
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** "Safari on iPhone", "Chrome on Windows", or null. */
export function deviceOf(ua: string | undefined): string | null {
  if (!ua) return null;
  const s = ua.slice(0, 512);
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(s))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? null;
}
