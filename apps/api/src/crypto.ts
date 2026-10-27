const enc = new TextEncoder();

/** HMAC-SHA-256 of the client's network key (see ip.ts), keyed by IP_HASH_SECRET. Raw IPs are never stored or logged. */
export async function hashIp(ip: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(ip)));
}

/** PostgREST takes bytea as a hex string prefixed with \x. */
export const toPgBytea = (bytes: Uint8Array): string =>
  `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
