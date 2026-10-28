/** How much of a RAW file to scan for embedded JPEG previews. Camera previews sit near the start. */
export const RAW_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * End offset (exclusive) of the JPEG that starts at `start` (an SOI marker), or -1 if it isn't a complete
 * JPEG. Walks the marker segments by their lengths, so EOI bytes inside an embedded EXIF thumbnail don't end
 * it early, then scans entropy-coded data, where 0xFF is always stuffed (FF 00) or a restart marker.
 */
export function jpegEnd(buf: Uint8Array, start: number): number {
  const len = buf.length;
  const b = (k: number): number => buf[k] ?? -1;
  if (b(start) !== 0xff || b(start + 1) !== 0xd8) return -1;
  let i = start + 2;
  while (i + 1 < len) {
    if (b(i) !== 0xff) return -1;
    const m = b(i + 1);
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd9) return i + 2; // EOI
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2; // markers without a length
      continue;
    }
    if (i + 3 >= len) return -1;
    const segLen = (b(i + 2) << 8) | b(i + 3);
    if (segLen < 2) return -1;
    i += 2 + segLen;
    if (m === 0xda) {
      // Start of scan: skip entropy-coded data up to the next real marker.
      while (i + 1 < len) {
        if (b(i) === 0xff) {
          const n = b(i + 1);
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            i += 2;
            continue;
          }
          if (n === 0xff) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
    }
  }
  return -1;
}

/** Byte range of the largest complete JPEG found in the buffer (SOI FF D8 FF … EOI FF D9), or null. */
export function largestEmbeddedJpeg(buf: Uint8Array): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0xff || buf[i + 1] !== 0xd8 || buf[i + 2] !== 0xff) continue;
    const end = jpegEnd(buf, i);
    if (end < 0) continue;
    if (!best || end - i > best.end - best.start) best = { start: i, end };
  }
  return best;
}

/** The camera's embedded preview of a RAW file as a JPEG blob, or null if there isn't a usable one. */
export async function rawPreview(file: Blob): Promise<Blob | null> {
  const head = new Uint8Array(await file.slice(0, RAW_SCAN_BYTES).arrayBuffer());
  const r = largestEmbeddedJpeg(head);
  if (!r || r.end - r.start < 8 * 1024) return null;
  return new Blob([head.slice(r.start, r.end)], { type: 'image/jpeg' });
}
