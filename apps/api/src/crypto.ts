const enc = new TextEncoder();

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** HMAC-SHA-256 of the client's network key (see ip.ts), keyed by IP_HASH_SECRET. Raw IPs are never stored or logged. */
export async function hashIp(ip: string, secret: string): Promise<Uint8Array> {
  return hmac(ip, secret);
}

/** HMAC-SHA-256 of any value (e.g. a normalised email for per-address limits). */
export async function hmac(value: string, secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value)));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

/** PostgREST takes bytea as a hex string prefixed with \x. */
export const toPgBytea = (bytes: Uint8Array): string =>
  `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A new invite token: 32 random bytes as base64url (43 characters), and its SHA-256 for storage. */
export async function newInviteToken(): Promise<{ token: string; hash: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: toPgBytea(await sha256(token)) };
}

export const inviteTokenHash = async (token: string) => toPgBytea(await sha256(token));

/** Signs "value" as "value.signature" (base64url HMAC-SHA-256). */
export async function sign(value: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value));
  return `${value}.${base64url(new Uint8Array(sig))}`;
}

/** Returns the value if the signature is valid (constant-time check by WebCrypto), else null. */
export async function unsign(signed: string, secret: string): Promise<string | null> {
  const i = signed.lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const sig = signed.slice(i + 1);
  let bytes: Uint8Array;
  try {
    const b64 = sig.replace(/-/g, '+').replace(/_/g, '/');
    bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, enc.encode(value));
  return ok ? value : null;
}
