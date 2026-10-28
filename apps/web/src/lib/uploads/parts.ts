/** Number of multipart parts for a file (at least one, even for an empty file). */
export function partCount(size: number, partSize: number): number {
  if (partSize <= 0) throw new RangeError('partSize must be positive');
  return Math.max(1, Math.ceil(size / partSize));
}

/** Byte range [start, end) of part `n` (1-based), for `file.slice(start, end)`. */
export function partRange(size: number, partSize: number, n: number): { start: number; end: number } {
  const count = partCount(size, partSize);
  if (!Number.isInteger(n) || n < 1 || n > count) throw new RangeError(`part ${n} is outside 1..${count}`);
  const start = (n - 1) * partSize;
  return { start, end: Math.min(size, start + partSize) };
}

/** Parts still to send, in order, given the ones the server already confirmed. */
export function partsToSend(count: number, done: Iterable<number>): number[] {
  const have = new Set(done);
  const out: number[] = [];
  for (let n = 1; n <= count; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** Bytes already confirmed by the server for the given parts. */
export function bytesDone(size: number, partSize: number, done: Iterable<number>): number {
  let total = 0;
  const count = partCount(size, partSize);
  for (const n of new Set(done)) {
    if (n < 1 || n > count) continue;
    const r = partRange(size, partSize, n);
    total += r.end - r.start;
  }
  return total;
}
