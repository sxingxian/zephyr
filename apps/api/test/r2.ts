/**
 * In-memory stand-in for an R2 bucket binding: objects, conditional and ranged gets, batched deletes,
 * prefix listing and multipart uploads. Bodies are read in full, so stream errors surface as they
 * would in R2.
 */
interface Stored {
  bytes: Uint8Array;
  contentType?: string;
  etag: string;
  uploaded?: Date;
}
interface Multipart {
  key: string;
  contentType?: string;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

const randomHex = () => crypto.randomUUID().replace(/-/g, '');

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('mock R2: unsupported body');
}

export class MockR2 {
  objects = new Map<string, Stored>();
  multiparts = new Map<string, Multipart>();
  /** Every key passed to delete(), in order. */
  deleted: string[] = [];
  /** Keys per delete() call (R2 allows at most 1,000). */
  deleteBatches: number[] = [];
  aborted: string[] = [];
  failDeletes = false;

  reset() {
    this.objects.clear();
    this.multiparts.clear();
    this.deleted = [];
    this.deleteBatches = [];
    this.aborted = [];
    this.failDeletes = false;
  }

  private meta(key: string, s: Stored) {
    return {
      key,
      version: s.etag,
      size: s.bytes.byteLength,
      etag: s.etag,
      httpEtag: `"${s.etag}"`,
      uploaded: s.uploaded ?? new Date(),
      httpMetadata: s.contentType ? { contentType: s.contentType } : {},
      customMetadata: {},
      checksums: {},
      storageClass: 'Standard',
      writeHttpMetadata: () => undefined,
    };
  }

  /** Makes an object look `ms` older (R2 list's `uploaded`). */
  backdate(key: string, ms: number) {
    const s = this.objects.get(key);
    if (s) s.uploaded = new Date(Date.now() - ms);
  }

  async head(key: string) {
    const s = this.objects.get(key);
    return s ? this.meta(key, s) : null;
  }

  async get(
    key: string,
    opts: { onlyIf?: Headers; range?: { offset?: number; length?: number; suffix?: number } } = {},
  ) {
    const s = this.objects.get(key);
    if (!s) return null;
    const inm = opts.onlyIf instanceof Headers ? opts.onlyIf.get('if-none-match') : null;
    if (inm && (inm.trim() === '*' || inm.split(',').some((t) => t.trim() === `"${s.etag}"`))) {
      return this.meta(key, s); // precondition failed: metadata only, no body
    }
    let bytes = s.bytes;
    let range: { offset: number; length: number } | undefined;
    if (opts.range) {
      const r = opts.range;
      const offset = r.suffix !== undefined ? Math.max(0, bytes.byteLength - r.suffix) : (r.offset ?? 0);
      const length =
        r.suffix !== undefined ? bytes.byteLength - offset : (r.length ?? bytes.byteLength - offset);
      bytes = bytes.subarray(offset, offset + length);
      range = { offset, length };
    }
    const copy = new Uint8Array(bytes);
    return {
      ...this.meta(key, s),
      range,
      body: new Response(copy).body as ReadableStream<Uint8Array>,
      arrayBuffer: async () => copy.buffer.slice(0),
    };
  }

  async put(key: string, value: unknown, opts: { httpMetadata?: { contentType?: string } } = {}) {
    const s: Stored = {
      bytes: await toBytes(value),
      contentType: opts.httpMetadata?.contentType,
      etag: randomHex(),
    };
    this.objects.set(key, s);
    return this.meta(key, s);
  }

  async delete(keys: string | string[]) {
    if (this.failDeletes) throw new Error('mock R2: delete failed');
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length > 1000) throw new Error('mock R2: more than 1000 keys');
    this.deleteBatches.push(list.length);
    for (const k of list) {
      this.objects.delete(k);
      this.deleted.push(k);
    }
  }

  /** Cursors continue after the last key returned (like R2's), so deletes between pages don't skip keys. */
  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const after = opts.cursor ?? '';
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && k > after).sort();
    const limit = opts.limit ?? 1000;
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    return {
      objects: page.map((k) => this.meta(k, this.objects.get(k) as Stored)),
      truncated,
      cursor: truncated ? page.at(-1) : undefined,
      delimitedPrefixes: [],
    };
  }

  async createMultipartUpload(key: string, opts: { httpMetadata?: { contentType?: string } } = {}) {
    const id = `mp-${randomHex()}`;
    this.multiparts.set(id, { key, contentType: opts.httpMetadata?.contentType, parts: new Map() });
    return this.resumeMultipartUpload(key, id);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const find = () => {
      const mp = this.multiparts.get(uploadId);
      if (!mp || mp.key !== key) throw new Error('mock R2: NoSuchUpload');
      return mp;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: unknown) => {
        const mp = find();
        const bytes = await toBytes(value);
        const etag = randomHex();
        mp.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      abort: async () => {
        find();
        this.multiparts.delete(uploadId);
        this.aborted.push(uploadId);
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const mp = find();
        const chunks = parts.map((p) => {
          const stored = mp.parts.get(p.partNumber);
          if (!stored || stored.etag !== p.etag) throw new Error('mock R2: InvalidPart');
          return stored.bytes;
        });
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        const s: Stored = { bytes, contentType: mp.contentType, etag: `${randomHex()}-${parts.length}` };
        this.objects.set(key, s);
        this.multiparts.delete(uploadId);
        return this.meta(key, s);
      },
    };
  }
}
