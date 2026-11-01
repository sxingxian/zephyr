/**
 * Secrets and signatures for shared galleries (docs/phase-5.md): link tokens, passcodes, guests' unlock and
 * favourites cookies, and signed media URLs. Every comparison is constant-time (WebCrypto verify, or a
 * fixed-length XOR fold).
 */
import { GALLERY_TOKEN_BYTES, GUEST_UNLOCK_HOURS } from '@zephyr/shared';
import { base64url, hmac, sha256, toPgBytea } from '../crypto';
import type { Env } from '../env';

const enc = new TextEncoder();

const fromB64url = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Constant-time equality of two byte strings of the same length (false otherwise). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function verifyHmac(secret: string, value: string, sig: string): Promise<boolean> {
  const bytes = fromB64url(sig);
  if (bytes?.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, bytes, enc.encode(value));
}
const signHmac = async (secret: string, value: string) => base64url(await hmac(value, secret));

// ---- link tokens ------------------------------------------------------------------------------------------
/** A new gallery link token (256 bits, base64url, 43 characters) and its SHA-256 for storage. */
export async function newGalleryToken(): Promise<{ token: string; hash: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(GALLERY_TOKEN_BYTES)));
  return { token, hash: toPgBytea(await sha256(token)) };
}
export const tokenHash = async (token: string) => toPgBytea(await sha256(token));

// ---- links at rest ----------------------------------------------------------------------------------------
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
async function linkKey(env: Env): Promise<CryptoKey> {
  const raw = fromB64url(
    env.GALLERY_LINK_KEY.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  );
  if (raw?.byteLength !== 32) throw new Error('GALLERY_LINK_KEY must be 32 random bytes, base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/** The token encrypted with AES-256-GCM (random 96-bit IV, the gallery id as additional data), as bytea. */
export async function encryptLink(
  env: Env,
  galleryId: string,
  token: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(galleryId) },
    await linkKey(env),
    enc.encode(token),
  );
  return { ciphertext: toPgBytea(new Uint8Array(ct)), iv: toPgBytea(iv) };
}
/** The token back, or null if the ciphertext, IV or gallery id don't match (GCM authenticates all three). */
export async function decryptLink(
  env: Env,
  galleryId: string,
  ciphertextHex: string,
  ivHex: string,
): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(ivHex), additionalData: enc.encode(galleryId) },
      await linkKey(env),
      fromHex(ciphertextHex),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ---- passcodes --------------------------------------------------------------------------------------------
/** A uniformly random 6-digit code (rejection sampling, so no digit is more likely). */
export function newPasscode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0] as number;
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0');
  }
}
/** HMAC-SHA256(GALLERY_PEPPER, galleryId|generation|code). */
export const passcodeHmac = (env: Env, galleryId: string, generation: number, code: string) =>
  hmac(`${galleryId}|${generation}|${code}`, env.GALLERY_PEPPER);

/** Checks a code against the stored HMAC (hex), in constant time. */
export async function passcodeMatches(
  env: Env,
  galleryId: string,
  generation: number,
  code: string,
  storedHex: string,
): Promise<boolean> {
  const mine = await passcodeHmac(env, galleryId, generation, code);
  // Compare hex strings as bytes: both are 64 characters for a 32-byte HMAC.
  return sameBytes(enc.encode(toHex(mine)), enc.encode(storedHex.toLowerCase()));
}

// ---- guest cookies ----------------------------------------------------------------------------------------
/** `__Host-zg-<first 12 hex of the gallery id>`: one unlock cookie per gallery. */
export const unlockCookieName = (galleryId: string) =>
  `__Host-zg-${galleryId.replace(/-/g, '').slice(0, 12)}`;
/** The browser's random favourites id (90 days). */
export const GUEST_ID_COOKIE = '__Host-zv';
const UNLOCK_SECONDS = GUEST_UNLOCK_HOURS * 3600;
const GUEST_ID_SECONDS = 90 * 24 * 3600;

/** Set-Cookie for an unlock: `<generation>.<expiry>.<HMAC(GUEST_COOKIE_SECRET, id|generation|expiry)>`. */
export async function unlockCookie(
  env: Env,
  galleryId: string,
  generation: number,
  now = Date.now(),
): Promise<string> {
  const exp = Math.floor(now / 1000) + UNLOCK_SECONDS;
  const sig = await signHmac(env.GUEST_COOKIE_SECRET, `${galleryId}|${generation}|${exp}`);
  return `${unlockCookieName(galleryId)}=${generation}.${exp}.${sig}; Path=/; Max-Age=${UNLOCK_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** True if the cookie unlocks this gallery now: signed by us, same passcode generation, not expired. */
export async function unlocked(
  env: Env,
  cookieValue: string | undefined,
  galleryId: string,
  generation: number,
  now = Date.now(),
): Promise<boolean> {
  if (!cookieValue) return false;
  const m = /^([1-9][0-9]{0,9})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue);
  if (!m) return false;
  const gen = Number(m[1]);
  const exp = Number(m[2]);
  if (gen !== generation || exp * 1000 <= now || exp * 1000 > now + UNLOCK_SECONDS * 1000 + 60_000)
    return false;
  return verifyHmac(env.GUEST_COOKIE_SECRET, `${galleryId}|${gen}|${exp}`, m[3] as string);
}

/** A new random favourites id and its Set-Cookie. */
export function newGuestId(): { value: string; cookie: string } {
  const value = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return {
    value,
    cookie: `${GUEST_ID_COOKIE}=${value}; Path=/; Max-Age=${GUEST_ID_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  };
}
export const validGuestId = (v: string | undefined): v is string => !!v && /^[A-Za-z0-9_-]{43}$/.test(v);
/** What the database stores for a favourites id: an HMAC, never the cookie. */
export const guestIdHash = async (env: Env, value: string) =>
  toPgBytea(await hmac(`guest:${value}`, env.IP_HASH_SECRET));

// ---- media URLs -------------------------------------------------------------------------------------------
/** Guest media sizes: renditions (grid, view, full) and the download forms (web = view, as a file). */
export type MediaSize = 'grid' | 'view' | 'web' | 'full' | 'logo';
const MEDIA_SECONDS = 3600;

/** Expiry for URLs issued now: the next hour boundary plus an hour (so URLs in one page repeat, and cache). */
export const mediaExpiry = (now = Date.now()) => (Math.floor(now / 1000 / MEDIA_SECONDS) + 2) * MEDIA_SECONDS;

export async function signMedia(
  env: Env,
  galleryId: string,
  photoId: string,
  size: MediaSize,
  generation: number,
  exp: number,
): Promise<string> {
  return signHmac(env.MEDIA_URL_SECRET, `${galleryId}|${photoId}|${size}|${generation}|${exp}`);
}

/** `?e=<exp>&s=<sig>` for a media path. */
export async function mediaQuery(
  env: Env,
  galleryId: string,
  photoId: string,
  size: MediaSize,
  generation: number,
  exp: number,
): Promise<string> {
  return `?e=${exp}&s=${await signMedia(env, galleryId, photoId, size, generation, exp)}`;
}

export async function mediaSignatureOk(
  env: Env,
  galleryId: string,
  photoId: string,
  size: MediaSize,
  generation: number,
  e: string | undefined,
  s: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!e || !s || !/^[0-9]{1,12}$/.test(e)) return false;
  const exp = Number(e);
  if (exp * 1000 <= now || exp * 1000 > now + 2 * MEDIA_SECONDS * 1000 + 60_000) return false;
  return verifyHmac(env.MEDIA_URL_SECRET, `${galleryId}|${photoId}|${size}|${generation}|${exp}`, s);
}
