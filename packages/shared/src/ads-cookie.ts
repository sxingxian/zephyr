/**
 * Phase 8: the value of the AdSense cookie (ADS_DOC_COOKIE). The API sets it for a member it shows AdSense; the
 * app Worker widens a document's CSP only when the request carries a valid one. The value is
 * `v1.<expiry seconds>.<member id>.<MAC>`, the MAC an HMAC-SHA-256 (base64url) over the rest, keyed with
 * ADS_COOKIE_SECRET, a secret both Workers hold. Page script can write a cookie of that name (`__Host-` cookies
 * can be set from `document.cookie`), but not a valid value, so it can't make the wider policy stick for another
 * member or a paid plan. Web Crypto only, so the API, the app Worker and tests share it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

const b64url = (bytes: ArrayBuffer): string => {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function mac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`zads|${payload}`)));
}

/** Constant-time string comparison (equal lengths are checked first; MACs are fixed-length). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The cookie value for `userId`, valid until `expiresAt` (seconds since the epoch). */
export async function signAdsCookie(secret: string, userId: string, expiresAt: number): Promise<string> {
  const payload = `v1.${Math.floor(expiresAt)}.${userId.toLowerCase()}`;
  return `${payload}.${await mac(secret, payload)}`;
}

/**
 * The member id a cookie value was issued for, when its MAC is valid and it hasn't expired; otherwise null. A
 * missing or short secret never verifies anything (the strict policy).
 */
export async function verifyAdsCookie(
  secret: string | undefined,
  value: string | null | undefined,
  nowSeconds = Date.now() / 1000,
): Promise<string | null> {
  if (!secret || secret.length < 16 || !value || value.length > 200) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [v, exp, user, sig] = parts as [string, string, string, string];
  if (v !== 'v1' || !/^\d{1,12}$/.test(exp) || !UUID.test(user) || !MAC.test(sig)) return null;
  if (Number(exp) <= nowSeconds) return null;
  try {
    return same(await mac(secret, `${v}.${exp}.${user}`), sig) ? user : null;
  } catch {
    return null;
  }
}

/** The value of a cookie in a Cookie header (the first one by that name), or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
