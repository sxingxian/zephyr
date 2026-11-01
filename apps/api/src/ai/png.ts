/**
 * Background masks (docs/phase-6.md, Cloud work step 4). What a provider returns is untrusted: this reader
 * accepts only 8-bit, non-interlaced PNGs of colour type 0 (grey), 4 (grey + alpha) or 6 (RGBA), refuses
 * anything larger than it should be before inflating it, and keeps only one channel (alpha, or grey for
 * type 0). The provider's RGB pixels are dropped. Masks are stored re-encoded as 8-bit greyscale PNGs.
 */
import { Unzlib, zlibSync } from 'fflate';

export class MaskError extends Error {
  constructor(readonly reason: string) {
    super(`mask: ${reason}`);
    this.name = 'MaskError';
  }
}

export interface Mask {
  width: number;
  height: number;
  /** One byte per pixel, row by row. */
  data: Uint8Array;
}

/** Largest dimension a provider's PNG may have (masks are stored at ≤ 2048). */
export const PNG_MAX_EDGE = 4096;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 4: 2, 6: 4 };

const u32 = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) * 0x1000000 + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;

/**
 * Reads a provider's PNG and returns its mask channel. `maxBytes` bounds the compressed input.
 * Throws MaskError for anything unexpected.
 */
export function readMask(png: Uint8Array, maxBytes: number): Mask {
  if (png.byteLength > maxBytes) throw new MaskError('too_large');
  if (png.byteLength < 8 + 25 || SIGNATURE.some((v, i) => png[i] !== v)) throw new MaskError('not_png');
  let i = 8;
  let width = 0;
  let height = 0;
  let type = -1;
  let sawHeader = false;
  let sawEnd = false;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let chunks = 0;
  while (i + 12 <= png.byteLength) {
    if (++chunks > 100_000) throw new MaskError('chunks');
    const len = u32(png, i);
    const kind = String.fromCharCode(png[i + 4] ?? 0, png[i + 5] ?? 0, png[i + 6] ?? 0, png[i + 7] ?? 0);
    const start = i + 8;
    const end = start + len;
    if (len > 0x7fffffff || end + 4 > png.byteLength) throw new MaskError('truncated');
    if (!sawHeader) {
      if (kind !== 'IHDR' || len !== 13) throw new MaskError('no_header');
      width = u32(png, start);
      height = u32(png, start + 4);
      const depth = png[start + 8];
      type = png[start + 9] ?? -1;
      const [compression, filter, interlace] = [png[start + 10], png[start + 11], png[start + 12]];
      if (depth !== 8 || !(type in CHANNELS)) throw new MaskError('format');
      if (compression !== 0 || filter !== 0 || interlace !== 0) throw new MaskError('format');
      if (width < 1 || height < 1 || width > PNG_MAX_EDGE || height > PNG_MAX_EDGE)
        throw new MaskError('size');
      sawHeader = true;
    } else if (kind === 'IDAT') {
      idat.push(png.subarray(start, end));
      idatBytes += len;
    } else if (kind === 'IEND') {
      sawEnd = true;
      break;
    } else if (kind === 'PLTE' || kind === 'IHDR') {
      throw new MaskError('format');
    }
    // Other ancillary chunks (gAMA, sRGB, tEXt…) are ignored.
    i = end + 4; // skip the CRC
  }
  if (!sawHeader || !sawEnd || idatBytes === 0) throw new MaskError('truncated');

  const channels = CHANNELS[type] as number;
  const stride = width * channels;
  const expected = height * (stride + 1);
  // Inflate into exactly the expected size: any more is refused as it streams (no decompression bomb).
  const raw = new Uint8Array(expected);
  let filled = 0;
  let overflow = false;
  const z = new Unzlib((chunk) => {
    if (filled + chunk.byteLength > expected) {
      overflow = true;
      return;
    }
    raw.set(chunk, filled);
    filled += chunk.byteLength;
  });
  try {
    for (let k = 0; k < idat.length; k++) {
      z.push(idat[k] as Uint8Array, k === idat.length - 1);
      if (overflow) throw new MaskError('bomb');
    }
  } catch (err) {
    if (err instanceof MaskError) throw err;
    throw new MaskError('inflate');
  }
  if (overflow) throw new MaskError('bomb');
  if (filled !== expected) throw new MaskError('truncated');

  // Unfilter row by row, keeping one channel.
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const pick = type === 0 ? 0 : channels - 1;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const f = raw[base] as number;
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x] as number;
      const a = x >= channels ? (cur[x - channels] as number) : 0;
      const b = prev[x] as number;
      const c = x >= channels ? (prev[x - channels] as number) : 0;
      let r: number;
      switch (f) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new MaskError('filter');
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) out[y * width + x] = cur[x * channels + pick] as number;
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

/** True when two sizes have the same aspect ratio within `tolerance` (relative). */
export function sameAspect(
  a: { width: number; height: number },
  b: { width: number; height: number },
  tolerance: number,
) {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / rb <= tolerance;
}

/** Bilinear resize of a one-channel image. */
export function resizeMask(m: Mask, width: number, height: number): Mask {
  if (m.width === width && m.height === height) return m;
  const out = new Uint8Array(width * height);
  const sx = m.width / width;
  const sy = m.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(m.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(m.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(m.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(m.width - 1, x0 + 1);
      const tx = fx - x0;
      const p = (yy: number, xx: number) => m.data[yy * m.width + xx] as number;
      const top = p(y0, x0) * (1 - tx) + p(y0, x1) * tx;
      const bottom = p(y1, x0) * (1 - tx) + p(y1, x1) * tx;
      out[y * width + x] = Math.round(top * (1 - ty) + bottom * ty);
    }
  }
  return { width, height, data: out };
}

// ---- encoder ------------------------------------------------------------------------------------------
let CRC_TABLE: Uint32Array | null = null;
function crc32(parts: Uint8Array[]): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const p of parts)
    for (let i = 0; i < p.length; i++) c = (CRC_TABLE[(c ^ (p[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.byteLength);
  const k = new Uint8Array([...kind].map((ch) => ch.charCodeAt(0)));
  out.set(k, 4);
  out.set(data, 8);
  v.setUint32(8 + data.byteLength, crc32([k, data]));
  return out;
}

/** Encodes a one-channel mask as an 8-bit greyscale PNG (Up filter, deflate level 6). */
export function encodeMask(m: Mask): Uint8Array {
  const raw = new Uint8Array(m.height * (m.width + 1));
  for (let y = 0; y < m.height; y++) {
    const o = y * (m.width + 1);
    raw[o] = y === 0 ? 0 : 2;
    for (let x = 0; x < m.width; x++) {
      const v = m.data[y * m.width + x] as number;
      raw[o + 1 + x] = y === 0 ? v : (v - (m.data[(y - 1) * m.width + x] as number)) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, m.width);
  dv.setUint32(4, m.height);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Test helper and bake-off support: encodes RGBA/grey pixels as a PNG of the given colour type. */
export function encodePng(width: number, height: number, type: 0 | 4 | 6, pixels: Uint8Array): Uint8Array {
  const ch = CHANNELS[type] as number;
  const raw = new Uint8Array(height * (width * ch + 1));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * ch, (y + 1) * width * ch), y * (width * ch + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, type, 0, 0, 0], 8);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
