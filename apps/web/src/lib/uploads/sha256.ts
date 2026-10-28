import { createSHA256 } from 'hash-wasm';

/** Chunk size for incremental hashing: big enough to be fast, small enough to keep memory flat. */
export const HASH_CHUNK = 4 * 1024 * 1024;

/** Incremental SHA-256 of a Blob, read slice by slice (lowercase hex). Shared by the worker and the fallback. */
export async function sha256Blob(blob: Blob, onProgress?: (done: number) => void): Promise<string> {
  const h = await createSHA256();
  h.init();
  for (let off = 0; off < blob.size; off += HASH_CHUNK) {
    const chunk = new Uint8Array(await blob.slice(off, off + HASH_CHUNK).arrayBuffer());
    h.update(chunk);
    onProgress?.(Math.min(blob.size, off + HASH_CHUNK));
  }
  return h.digest('hex');
}
