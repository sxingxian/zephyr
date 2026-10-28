/**
 * File checks for the photo library: types from extensions, magic-number signatures, variant image
 * headers (format and dimensions), download names and byte ranges. Pure functions, no I/O.
 */
import { FILE_TYPES, type FileTypeId } from '@zephyr/shared';

/** The file type an upload's name declares (by extension), or null if the server doesn't know it. */
export function fileTypeFromName(name: string): FileTypeId | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const [id, t] of Object.entries(FILE_TYPES)) {
    if ((t.exts as readonly string[]).includes(ext)) return id as FileTypeId;
  }
  return null;
}

/** Bytes needed to check any signature. */
export const SIGNATURE_BYTES = 12;

const byteAt = (b: Uint8Array, i: number) => b[i] ?? -1;
const bytesAt = (b: Uint8Array, i: number, ...want: number[]) => want.every((x, k) => byteAt(b, i + k) === x);
const asciiAt = (b: Uint8Array, i: number, s: string) =>
  [...s].every((ch, k) => byteAt(b, i + k) === ch.charCodeAt(0));
const isTiff = (b: Uint8Array) =>
  bytesAt(b, 0, 0x49, 0x49, 0x2a, 0x00) || bytesAt(b, 0, 0x4d, 0x4d, 0x00, 0x2a);

/** Whether the file's first bytes match its declared type (docs/phase-3.md, Uploading step 2). */
export function signatureMatches(type: FileTypeId, head: Uint8Array): boolean {
  switch (type) {
    case 'jpeg':
      return bytesAt(head, 0, 0xff, 0xd8, 0xff);
    case 'png':
      return bytesAt(head, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'webp':
      return asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP');
    case 'cr2':
      return isTiff(head) && asciiAt(head, 8, 'CR');
    case 'nef':
    case 'arw':
      return isTiff(head);
    default:
      return false;
  }
}

export interface ImageInfo {
  format: 'jpeg' | 'webp';
  width: number;
  height: number;
}

/** Format and dimensions of a browser-made variant (JPEG or WEBP), read from its header. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (bytesAt(b, 0, 0xff, 0xd8, 0xff)) return jpegInfo(b);
  if (asciiAt(b, 0, 'RIFF') && asciiAt(b, 8, 'WEBP')) return webpInfo(b);
  return null;
}

function jpegInfo(b: Uint8Array): ImageInfo | null {
  const u16 = (i: number) => (byteAt(b, i) << 8) | byteAt(b, i + 1);
  let i = 2;
  while (i + 9 < b.length) {
    if (byteAt(b, i) !== 0xff) return null;
    const m = byteAt(b, i + 1);
    if (m === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // markers without a length
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // end of image or scan data before any frame header
    const len = u16(i + 2);
    if (len < 2) return null;
    // Start-of-frame markers (C0–CF except DHT C4, JPG C8 and DAC CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = u16(i + 5);
      const width = u16(i + 7);
      return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  const u = (i: number) => byteAt(b, i);
  let width: number;
  let height: number;
  if (asciiAt(b, 12, 'VP8 ')) {
    if (!bytesAt(b, 23, 0x9d, 0x01, 0x2a)) return null;
    width = (u(26) | (u(27) << 8)) & 0x3fff;
    height = (u(28) | (u(29) << 8)) & 0x3fff;
  } else if (asciiAt(b, 12, 'VP8L')) {
    if (u(20) !== 0x2f) return null;
    const bits = (u(21) | (u(22) << 8) | (u(23) << 16) | (u(24) << 24)) >>> 0;
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (asciiAt(b, 12, 'VP8X')) {
    width = 1 + (u(24) | (u(25) << 8) | (u(26) << 16));
    height = 1 + (u(27) | (u(28) << 8) | (u(29) << 16));
  } else {
    return null;
  }
  return width > 0 && height > 0 ? { format: 'webp', width, height } : null;
}

/** The download name: the photo's name, with the right extension added if it doesn't have one. */
export function downloadName(filename: string, type: FileTypeId): string {
  const exts = FILE_TYPES[type].exts as readonly string[];
  const dot = filename.lastIndexOf('.');
  const ext = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  return exts.includes(ext) ? filename : `${filename}.${exts[0]}`;
}

/** `attachment` with an ASCII fallback and the exact name per RFC 5987/6266. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150) || 'photo';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * A single `Range: bytes=…` against a file of `size` bytes. undefined: no usable range (serve the
 * whole file; multiple ranges are ignored too). null: not satisfiable (416).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m) return undefined;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return null;
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (start >= size) return null;
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return undefined;
  return { offset: start, length: end - start + 1 };
}
