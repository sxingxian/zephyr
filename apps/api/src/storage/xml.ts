/**
 * The few S3 XML responses the store reads (ListObjectsV2, InitiateMultipartUpload, Error), parsed with plain
 * string scanning: Workers has no DOMParser, and these documents are flat. Only element text is read; nothing
 * is evaluated, and entity decoding covers the five XML entities and numeric references.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e] ?? '';
  });
}

export function encodeXml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`,
  );
}

/** Every `<tag>…</tag>` body (namespaces and attributes on the opening tag are allowed). */
export function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  const close = `</${tag}>`;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const start = m.index + m[0].length;
    const end = xml.indexOf(close, start);
    if (end < 0) break;
    out.push(xml.slice(start, end));
    open.lastIndex = end + close.length;
  }
  return out;
}

/** The decoded text of the first `<tag>`, or null. */
export function text(xml: string, tag: string): string | null {
  const b = blocks(xml, tag)[0];
  return b === undefined ? null : decodeXml(b.trim());
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
}
export function parseList(xml: string): { objects: ListedObject[]; truncated: boolean; next: string | null } {
  const objects = blocks(xml, 'Contents').flatMap((c) => {
    const key = text(c, 'Key');
    if (key === null) return [];
    const size = Number(text(c, 'Size') ?? '0');
    const lm = new Date(text(c, 'LastModified') ?? '');
    return [
      {
        key,
        size: Number.isFinite(size) ? size : 0,
        lastModified: Number.isNaN(lm.getTime()) ? new Date(0) : lm,
        etag: (text(c, 'ETag') ?? '').replace(/"/g, ''),
      },
    ];
  });
  return {
    objects,
    truncated: (text(xml, 'IsTruncated') ?? 'false').toLowerCase() === 'true',
    next: text(xml, 'NextContinuationToken'),
  };
}
