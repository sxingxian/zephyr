/**
 * The "network" a client IP belongs to, for rate limiting and hashing:
 * - IPv4: the address itself (a /32), e.g. `203.0.113.7`.
 * - IPv4-mapped IPv6 (`::ffff:203.0.113.7`): treated as that IPv4 address.
 * - IPv6: the /64 prefix, e.g. `2001:db8:1:2::/64`. One subscriber usually gets a whole /64 (or more),
 *   so limiting single IPv6 addresses would let one person rotate through billions of them.
 * Returns null for anything that isn't a valid IP.
 */
export function networkKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);

  const v4 = parseIPv4(ip);
  if (v4) return v4.join('.');

  const h = parseIPv6(ip);
  if (!h) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = h;
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 0xff, k >> 8, k & 0xff].join('.');
  }
  return `${[a, b, c, d].map((x) => x.toString(16)).join(':')}::/64`;
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // Decimal only, no leading zeros (which some parsers read as octal).
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(s: string): number[] | null {
  if (!s.includes(':') || s.split('::').length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    const out: number[] = [];
    for (const [i, p] of pieces.entries()) {
      if (i === pieces.length - 1 && p.includes('.')) {
        const v4 = parseIPv4(p);
        if (!v4) return null;
        const [w = 0, x = 0, y = 0, z = 0] = v4;
        out.push((w << 8) | x, (y << 8) | z);
      } else if (/^[0-9a-f]{1,4}$/.test(p)) {
        out.push(Number.parseInt(p, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const [headRaw, tailRaw] = s.split('::');
  const head = toGroups(headRaw ?? '');
  if (!head) return null;
  if (tailRaw === undefined) return head.length === 8 ? head : null;
  // An embedded IPv4 is only allowed at the very end.
  if (head.length && headRaw?.includes('.')) return null;
  const tail = toGroups(tailRaw);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}
