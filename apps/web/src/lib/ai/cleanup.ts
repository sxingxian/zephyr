import { CLEANUP, type CleanupPhoto } from '@zephyr/shared/client';

/**
 * Cleanup grouping (phase 6, on the device, Pro and Studio) over every photo's quality signals:
 *
 * - duplicates: pHash distance ≤ CLEANUP.duplicateBits, however far apart in time. Found with chunk buckets:
 *   the 64 bits are split into 5 chunks, and two hashes within 4 bits of each other share at least one chunk
 *   exactly (pigeonhole), so only photos sharing a chunk are compared.
 * - similar bursts: distance ≤ CLEANUP.burstBits and taken ≤ CLEANUP.burstSeconds apart (a time-sorted sweep),
 *   not already in a duplicate group.
 * - blurry: sharpness below CLEANUP.blurSharpness and below 40 % of the median of its burst or, outside a
 *   burst, of its day (a day with fewer than 3 photos has nothing to compare with: the threshold alone decides).
 *
 * Each group is ordered best first: sharpest, then largest file, then earliest. The best one is kept; the
 * others are offered for the Trash. Photos marked "Not duplicates" / "Keep" are left out.
 */
export interface CleanupGroup {
  /** Best first. */
  photos: CleanupPhoto[];
  keep: string;
  /** Bytes freed by moving all but the best to the Trash. */
  savings: number;
}
export interface CleanupResult {
  duplicates: CleanupGroup[];
  bursts: CleanupGroup[];
  blurry: CleanupPhoto[];
}

const CHUNKS: [number, number][] = [
  [0, 13],
  [13, 13],
  [26, 13],
  [39, 13],
  [52, 12],
];

/** 64-bit pHash as a BigInt (null if malformed). */
export function hashBits(hex: string): bigint | null {
  return /^[0-9a-f]{16}$/i.test(hex) ? BigInt(`0x${hex}`) : null;
}
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}
const chunkOf = (h: bigint, [start, len]: [number, number]) =>
  (h >> BigInt(64 - start - len)) & ((1n << BigInt(len)) - 1n);

const timeOf = (p: CleanupPhoto) => Date.parse(p.takenAt ?? p.createdAt);
/** Best first: sharpest, then largest file, then earliest. */
export function bestFirst(a: CleanupPhoto, b: CleanupPhoto): number {
  return (
    b.sharpness - a.sharpness || b.sizeBytes - a.sizeBytes || timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : 1)
  );
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    while (p !== (this.parent.get(p) ?? p)) p = this.parent.get(p) ?? p;
    this.parent.set(x, p);
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // The smaller id becomes the root (string order, so results don't depend on input order).
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

function toGroups(members: Map<string, CleanupPhoto[]>): CleanupGroup[] {
  const out: CleanupGroup[] = [];
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const photos = [...list].sort(bestFirst);
    const keep = (photos[0] as CleanupPhoto).id;
    out.push({ photos, keep, savings: photos.slice(1).reduce((s, p) => s + p.sizeBytes, 0) });
  }
  // Biggest savings first.
  return out.sort((a, b) => b.savings - a.savings || (a.keep < b.keep ? -1 : 1));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export function groupCleanup(photos: CleanupPhoto[]): CleanupResult {
  const hashes = new Map<string, bigint>();
  for (const p of photos) {
    const h = hashBits(p.phash);
    if (h !== null) hashes.set(p.id, h);
  }

  // Duplicates.
  const dupCandidates = photos.filter((p) => !p.dupIgnored && hashes.has(p.id));
  const uf = new UnionFind();
  for (const chunk of CHUNKS) {
    const buckets = new Map<bigint, string[]>();
    for (const p of dupCandidates) {
      const key = chunkOf(hashes.get(p.id) as bigint, chunk);
      const b = buckets.get(key);
      if (b) b.push(p.id);
      else buckets.set(key, [p.id]);
    }
    for (const ids of buckets.values()) {
      if (ids.length < 2 || ids.length > 2000) continue; // a degenerate bucket (flat images) is skipped
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i] as string;
          const b = ids[j] as string;
          if (uf.find(a) === uf.find(b)) continue;
          if (hamming(hashes.get(a) as bigint, hashes.get(b) as bigint) <= CLEANUP.duplicateBits)
            uf.union(a, b);
        }
    }
  }
  const dupMembers = new Map<string, CleanupPhoto[]>();
  for (const p of dupCandidates) {
    const r = uf.find(p.id);
    const l = dupMembers.get(r);
    if (l) l.push(p);
    else dupMembers.set(r, [p]);
  }
  const duplicates = toGroups(dupMembers);
  const inDup = new Set(duplicates.flatMap((g) => g.photos.map((p) => p.id)));

  // Similar bursts: a sweep over photos sorted by when they were taken.
  const timed = photos
    .filter((p) => !p.dupIgnored && p.takenAt && hashes.has(p.id) && !inDup.has(p.id))
    .map((p) => ({ p, t: Date.parse(p.takenAt as string) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t || (a.p.id < b.p.id ? -1 : 1));
  const ufb = new UnionFind();
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i] as { p: CleanupPhoto; t: number };
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j] as { p: CleanupPhoto; t: number };
      if (b.t - a.t > CLEANUP.burstSeconds * 1000) break;
      if (hamming(hashes.get(a.p.id) as bigint, hashes.get(b.p.id) as bigint) <= CLEANUP.burstBits)
        ufb.union(a.p.id, b.p.id);
    }
  }
  const burstMembers = new Map<string, CleanupPhoto[]>();
  for (const { p } of timed) {
    const r = ufb.find(p.id);
    const l = burstMembers.get(r);
    if (l) l.push(p);
    else burstMembers.set(r, [p]);
  }
  const bursts = toGroups(burstMembers);

  // Blurry: low on its own, and low against its burst (or its day).
  const burstOf = new Map<string, CleanupGroup>();
  for (const g of bursts) for (const p of g.photos) burstOf.set(p.id, g);
  const dayOf = (p: CleanupPhoto) => (p.takenAt ?? p.createdAt).slice(0, 10);
  const days = new Map<string, number[]>();
  for (const p of photos) {
    const d = dayOf(p);
    const l = days.get(d);
    if (l) l.push(p.sharpness);
    else days.set(d, [p.sharpness]);
  }
  const blurry = photos
    .filter((p) => !p.blurIgnored && p.sharpness < CLEANUP.blurSharpness)
    .filter((p) => {
      const group = burstOf.get(p.id);
      const ref = group
        ? median(group.photos.map((x) => x.sharpness))
        : median(days.get(dayOf(p)) ?? [p.sharpness]);
      return p.sharpness < 0.4 * ref || (!group && (days.get(dayOf(p))?.length ?? 0) < 3);
    })
    .sort((a, b) => a.sharpness - b.sharpness || (a.id < b.id ? -1 : 1));
  return { duplicates, bursts, blurry };
}
