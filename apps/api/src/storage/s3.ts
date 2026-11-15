/**
 * An S3-compatible store (AWS S3, Backblaze B2, Wasabi, Garage, Ceph RGW, SeaweedFS…), signed with SigV4 by
 * aws4fetch. Bodies stream with an exact Content-Length and `UNSIGNED-PAYLOAD` (TLS or the private VPC link
 * protects them in transit); the small XML bodies (DeleteObjects, CompleteMultipartUpload) are hashed and
 * signed in full.
 *
 * Requests go through a `Fetcher`, so the same code runs over the public internet, a Workers VPC service
 * binding, or a Tunnel hostname behind a Cloudflare Access service token (config.ts builds the fetcher).
 *
 * Error responses are read only to pull out the S3 `<Code>`, which becomes a StoreError; the body itself is
 * never logged or returned (it can echo keys, bucket names and request ids).
 */
import { AwsV4Signer } from 'aws4fetch';
import { base64, md5 } from './md5';
import type { ByteRange, ObjectBody, ObjectStore, StoredObject } from './types';
import { StoreError, safeCode } from './types';
import { encodeXml, parseList, text } from './xml';

export type Fetcher = (req: Request) => Promise<Response>;

export interface S3Config {
  id: string;
  /** e.g. https://s3.eu-central-003.backblazeb2.com, or http://garage.internal:3900 behind Workers VPC. */
  endpoint: string;
  bucket: string;
  region: string;
  /** Path-style (`endpoint/bucket/key`) instead of virtual-host (`bucket.endpoint/key`). On-premises stores usually need it. */
  pathStyle: boolean;
}
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Small requests; streamed bodies get longer (a 16 MB part over a slow uplink). */
const TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 300_000;
/** An error body is read at most this far to find its <Code>. */
const ERROR_BODY_MAX = 4096;

const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split('/').map(rfc3986).join('/');

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (b: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', b));

const stripQuotes = (s: string | null) => (s ?? '').replace(/"/g, '');

/** A stream with its exact length: Workers sends Content-Length (not chunked) only for a FixedLengthStream. */
function sized(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === 'undefined') return body;
  const f = new FixedLengthStream(length);
  body.pipeTo(f.writable).catch(() => undefined);
  return f.readable as ReadableStream<Uint8Array>;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < ERROR_BODY_MAX) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      n += value.length;
    }
  } catch {
    /* a broken error body is still an error */
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all.slice(0, ERROR_BODY_MAX));
}

/** Maps a failed response to a StoreError with the S3 code (or the HTTP status). Never logs the body. */
async function failure(res: Response): Promise<StoreError> {
  const code = res.status === 404 && !res.body ? 'NoSuchKey' : text(await readCapped(res), 'Code');
  return new StoreError(safeCode(code, `http_${res.status}`), res.status);
}

function meta(key: string, h: Headers): StoredObject {
  const range = h.get('content-range'); // bytes 0-99/1234
  const total = range ? Number(range.split('/')[1]) : Number.NaN;
  const size = Number.isFinite(total) ? total : Number(h.get('content-length') ?? '0');
  const lm = new Date(h.get('last-modified') ?? '');
  return {
    key,
    size: Number.isFinite(size) ? size : 0,
    uploaded: Number.isNaN(lm.getTime()) ? new Date(0) : lm,
    contentType: h.get('content-type'),
    etag: stripQuotes(h.get('etag')),
  };
}

export function s3Store(config: S3Config, creds: S3Credentials, fetcher: Fetcher): ObjectStore {
  const base = new URL(config.endpoint);
  const origin = config.pathStyle ? base.origin : `${base.protocol}//${config.bucket}.${base.host}`;
  const prefix = (config.pathStyle ? `/${rfc3986(config.bucket)}` : '') + base.pathname.replace(/\/$/, '');

  function url(key: string | null, query: Record<string, string> = {}): string {
    const u = new URL(`${origin}${prefix}/${key === null ? '' : encodeKey(key)}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    // `?uploads` and `?delete` are valueless sub-resources.
    return u.toString().replace(/=(?=&|$)/g, '');
  }

  async function send(
    method: string,
    target: string,
    init: {
      headers?: Record<string, string>;
      body?: Uint8Array | ReadableStream<Uint8Array>;
      timeout?: number;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const body = init.body;
    if (body instanceof Uint8Array && body.length > 0 && !headers.has('x-amz-content-sha256')) {
      headers.set('x-amz-content-sha256', await sha256Hex(body));
    }
    const signed = await new AwsV4Signer({
      method,
      url: target,
      headers,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: config.region,
    }).sign();
    const req = new Request(signed.url.toString(), {
      method,
      headers: signed.headers,
      body: body ?? null,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS),
      // Node (tests) needs this for a stream body; Workers ignores it.
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
    try {
      return await fetcher(req);
    } catch (err) {
      if (err instanceof StoreError) throw err;
      const name = err instanceof Error ? err.name : '';
      throw new StoreError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable');
    }
  }

  const discard = (res: Response) => res.body?.cancel().catch(() => undefined);

  function streamBody(body: Uint8Array | ReadableStream<Uint8Array>, length: number) {
    return body instanceof ReadableStream ? sized(body, length) : body;
  }

  return {
    id: config.id,

    async put(key, body, opts) {
      const length = body instanceof Uint8Array ? body.length : opts.length;
      if (length === undefined) throw new StoreError('length_required');
      const res = await send('PUT', url(key), {
        headers: {
          'content-type': opts.contentType,
          'content-length': String(length),
          ...(opts.cacheControl ? { 'cache-control': opts.cacheControl } : {}),
        },
        body: streamBody(body, length),
        timeout: STREAM_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure(res);
      await discard(res);
      return {
        key,
        size: length,
        uploaded: new Date(),
        contentType: opts.contentType,
        etag: stripQuotes(res.headers.get('etag')),
      };
    },

    async get(key, opts: { range?: ByteRange } = {}) {
      const headers: Record<string, string> = {};
      if (opts.range)
        headers.range = `bytes=${opts.range.offset}-${opts.range.offset + opts.range.length - 1}`;
      const res = await send('GET', url(key), { headers, timeout: STREAM_TIMEOUT_MS });
      if (res.status === 404) {
        await discard(res);
        return null;
      }
      if (!res.ok || !res.body) throw await failure(res);
      const m = meta(key, res.headers);
      const out: ObjectBody = {
        ...m,
        body: res.body,
        bytes: async () => new Uint8Array(await res.arrayBuffer()),
      };
      return out;
    },

    async head(key) {
      const res = await send('HEAD', url(key));
      if (res.status === 404) return null;
      if (!res.ok) throw new StoreError(`http_${res.status}`, res.status);
      return meta(key, res.headers);
    },

    async delete(keys) {
      if (!keys.length) return;
      if (keys.length > 1000) throw new StoreError('too_many_keys');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${keys
        .map((k) => `<Object><Key>${encodeXml(k)}</Key></Object>`)
        .join('')}</Delete>`;
      const body = new TextEncoder().encode(xml);
      const res = await send('POST', url(null, { delete: '' }), {
        headers: {
          'content-type': 'application/xml',
          'content-md5': base64(md5(body)),
        },
        body,
      });
      if (!res.ok) throw await failure(res);
      // Quiet mode lists only the keys that failed. A missing key is never one of them.
      const errors = (await res.text()).includes('<Error>');
      if (errors) throw new StoreError('delete_partial', res.status);
    },

    async list(listPrefix, opts = {}) {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix: listPrefix,
        'max-keys': String(Math.min(Math.max(opts.limit ?? 1000, 1), 1000)),
      };
      if (opts.cursor) query['continuation-token'] = opts.cursor;
      const res = await send('GET', url(null, query));
      if (!res.ok) throw await failure(res);
      const parsed = parseList(await res.text());
      // A truncated listing without a token to continue from can't be trusted to be complete.
      if (parsed.truncated && !parsed.next) throw new StoreError('bad_response', res.status);
      return {
        objects: parsed.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.lastModified,
          contentType: null,
          etag: o.etag,
        })),
        cursor: parsed.truncated ? parsed.next : null,
      };
    },

    async createMultipart(key, contentType) {
      const res = await send('POST', url(key, { uploads: '' }), { headers: { 'content-type': contentType } });
      if (!res.ok) throw await failure(res);
      const id = text(await res.text(), 'UploadId');
      if (!id) throw new StoreError('bad_response', res.status);
      return id;
    },

    async uploadPart(key, uploadId, partNumber, body, length) {
      const res = await send('PUT', url(key, { partNumber: String(partNumber), uploadId }), {
        headers: { 'content-length': String(length) },
        body: streamBody(body, length),
        timeout: STREAM_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure(res);
      await discard(res);
      const etag = stripQuotes(res.headers.get('etag'));
      if (!etag) throw new StoreError('bad_response', res.status);
      return etag;
    },

    async completeMultipart(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${sorted
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${encodeXml(stripQuotes(p.etag))}"</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`;
      const res = await send('POST', url(key, { uploadId }), {
        headers: { 'content-type': 'application/xml' },
        body: new TextEncoder().encode(xml),
        timeout: STREAM_TIMEOUT_MS,
      });
      if (!res.ok) throw await failure(res);
      // S3 can answer 200 and then report an error in the body.
      const out = await res.text();
      if (out.includes('<Error>')) throw new StoreError(safeCode(text(out, 'Code'), 'complete_failed'), 200);
    },

    async abortMultipart(key, uploadId) {
      const res = await send('DELETE', url(key, { uploadId }));
      if (res.ok || res.status === 404) {
        await discard(res);
        return;
      }
      throw await failure(res);
    },
  };
}
