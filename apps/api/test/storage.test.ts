import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN8_API, STORE_ID_RE } from '@zephyr/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { retryPublishes, sweepOrphans, sweepStaging } from '../src/jobs';
import { purgeNow } from '../src/library/storage';
import { secretName, storeConfigError, storeConfigs, storeFor } from '../src/storage/config';
import { checkStore, recordCheck, runHealthCron } from '../src/storage/health';
import { md5 } from '../src/storage/md5';
import {
  copyVerified,
  deleteOldCopy,
  followMove,
  followRecorded,
  followUnknown,
  handleStorageBatch,
  type MigrationItem,
  migrateItem,
  runFollowups,
  runMigrationBatch,
  runMigrationCron,
} from '../src/storage/migrate';
import { r2Store } from '../src/storage/r2';
import { type Fetcher, s3Store } from '../src/storage/s3';
import { StoreError } from '../src/storage/types';
import { decodeXml, parseList } from '../src/storage/xml';
import {
  accessToken,
  call,
  credential,
  env,
  initKeys,
  installFetch,
  type Jar,
  jar,
  LANDING,
  must,
  read,
  resetWorld,
  sbToken,
  storageQueue,
  world,
} from './helpers';
import { MockR2 } from './r2';

beforeAll(initKeys);
beforeEach(() => {
  resetWorld();
  installFetch();
  storageQueue.sent.length = 0;
  storageQueue.fail = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const streamOf = (b: Uint8Array, chunk = 3) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk));
      c.close();
    },
  });
const rpcCalls = (fn: string) => world.calls.filter((c) => c.url.endsWith(`/rpc/${fn}`));

// ---- a mock S3 server (path-style or virtual-host), as a Fetcher -------------------------------------------
interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array;
}
class MockS3 {
  objects = new Map<string, { bytes: Uint8Array; type: string; etag: string }>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  seen: Seen[] = [];
  /** Forces the next response (status, body). */
  next: { status: number; body: string } | null = null;
  /** Corrupts every GET body (the read-back of a copy). */
  corrupt = false;
  completeError = false;
  deleteError = false;
  /** Every request fails with 503 (a store that's down). */
  down = false;
  pageSize = 1000;
  constructor(
    readonly bucket = 'zephyr',
    readonly vhost = false,
  ) {}

  keyOf(url: URL): string | null {
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (!this.vhost) {
      if (parts[0] !== this.bucket) throw new Error(`wrong bucket ${parts[0]}`);
      parts.shift();
    } else if (!url.hostname.startsWith(`${this.bucket}.`)) throw new Error('wrong host');
    const k = parts.join('/');
    return k === '' ? null : k;
  }

  fetcher: Fetcher = async (req) => {
    const url = new URL(req.url);
    const body = req.body ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array();
    this.seen.push({ method: req.method, url, headers: new Headers(req.headers), body });
    if (this.next) {
      const n = this.next;
      this.next = null;
      return new Response(n.body, { status: n.status });
    }
    if (this.down) return new Response('', { status: 503 });
    const key = this.keyOf(url);
    const q = url.searchParams;
    const xml = (s: string, status = 200) =>
      new Response(`<?xml version="1.0" encoding="UTF-8"?>${s}`, {
        status,
        headers: { 'content-type': 'application/xml' },
      });
    const etag = () => `"${createHash('md5').update(crypto.randomUUID()).digest('hex')}"`;
    if (key === null && req.method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const after = q.get('continuation-token') ?? '';
      const max = Math.min(Number(q.get('max-keys') ?? 1000), this.pageSize);
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      return xml(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${this.bucket}</Name><IsTruncated>${truncated}</IsTruncated>${page
          .map((k) => {
            const o = this.objects.get(k) as { bytes: Uint8Array; etag: string };
            return `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>2026-11-01T10:00:00.000Z</LastModified><ETag>&quot;${o.etag.replace(/"/g, '')}&quot;</ETag><Size>${o.bytes.length}</Size></Contents>`;
          })
          .join(
            '',
          )}${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
    }
    if (key === null && req.method === 'POST' && q.has('delete')) {
      const keys = [...new TextDecoder().decode(body).matchAll(/<Key>(.*?)<\/Key>/g)].map((m) =>
        decodeXml(m[1] as string),
      );
      for (const k of keys) this.objects.delete(k);
      return xml(
        `<DeleteResult>${this.deleteError ? '<Error><Key>x</Key><Code>AccessDenied</Code></Error>' : ''}</DeleteResult>`,
      );
    }
    if (key === null) return xml('<Error><Code>MethodNotAllowed</Code></Error>', 405);
    if (req.method === 'POST' && q.has('uploads')) {
      const id = `up-${crypto.randomUUID()}`;
      this.uploads.set(id, { key, parts: new Map() });
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${this.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (req.method === 'PUT' && q.has('uploadId')) {
      const up = this.uploads.get(q.get('uploadId') as string);
      if (!up) return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
      up.parts.set(Number(q.get('partNumber')), body);
      return new Response(null, { status: 200, headers: { etag: `"part-${q.get('partNumber')}"` } });
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const up = this.uploads.get(q.get('uploadId') as string);
      if (!up) return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
      if (this.completeError)
        return xml('<Error><Code>InternalError</Code><Message>try again</Message></Error>');
      const order = [...new TextDecoder().decode(body).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
        (m) => Number(m[1]),
      );
      const all = order.map((n) => up.parts.get(n) as Uint8Array);
      const merged = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of all) {
        merged.set(p, o);
        o += p.length;
      }
      this.objects.set(key, { bytes: merged, type: 'application/octet-stream', etag: etag() });
      this.uploads.delete(q.get('uploadId') as string);
      return xml('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>');
    }
    if (req.method === 'DELETE' && q.has('uploadId')) {
      if (!this.uploads.delete(q.get('uploadId') as string))
        return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
      return new Response(null, { status: 204 });
    }
    if (req.method === 'PUT') {
      const declared = Number(req.headers.get('content-length'));
      if (Number.isFinite(declared) && declared !== body.length)
        return xml('<Error><Code>IncompleteBody</Code></Error>', 400);
      const e = etag();
      this.objects.set(key, { bytes: body, type: req.headers.get('content-type') ?? '', etag: e });
      return new Response(null, { status: 200, headers: { etag: e } });
    }
    const o = this.objects.get(key);
    if (!o)
      return req.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : xml('<Error><Code>NoSuchKey</Code></Error>', 404);
    const h = {
      'content-type': o.type,
      etag: o.etag,
      'last-modified': 'Sun, 01 Nov 2026 10:00:00 GMT',
    };
    if (req.method === 'HEAD')
      return new Response(null, { headers: { ...h, 'content-length': String(o.bytes.length) } });
    let b = o.bytes;
    const range = req.headers.get('range');
    if (range) {
      const [a, z] = range.replace('bytes=', '').split('-').map(Number) as [number, number];
      b = o.bytes.slice(a, z + 1);
      return new Response(b, {
        status: 206,
        headers: {
          ...h,
          'content-length': String(b.length),
          'content-range': `bytes ${a}-${z}/${o.bytes.length}`,
        },
      });
    }
    if (this.corrupt) b = new Uint8Array([...b.slice(0, -1), (b.at(-1) ?? 0) ^ 0xff]);
    return new Response(b, { headers: { ...h, 'content-length': String(b.length) } });
  };
}

const CREDS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test-key' };
const s3 = (mock: MockS3, pathStyle = true) =>
  s3Store(
    { id: 'b2-eu', endpoint: 'https://s3.example.test', bucket: mock.bucket, region: 'eu-test-1', pathStyle },
    CREDS,
    mock.fetcher,
  );

// ================================================================ s3Store
describe('s3Store', () => {
  it('signs every request with SigV4 and streams puts with Content-Length and UNSIGNED-PAYLOAD', async () => {
    const mock = new MockS3();
    const store = s3(mock);
    const body = bytes('hello, zephyr!');
    const put = await store.put('u/o/p/1/original', streamOf(body), {
      contentType: 'image/jpeg',
      length: body.length,
    });
    expect(put.size).toBe(body.length);
    const req = must(mock.seen[0]);
    expect(req.method).toBe('PUT');
    expect(req.url.toString()).toBe('https://s3.example.test/zephyr/u/o/p/1/original');
    expect(req.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-test-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(req.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(req.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(req.headers.get('content-length')).toBe(String(body.length));
    expect(req.headers.get('authorization')).not.toContain('secret-test-key');
    expect(mock.objects.get('u/o/p/1/original')?.bytes).toEqual(body);
    // A stream without a length is refused before anything is sent.
    await expect(store.put('k', streamOf(body), { contentType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'length_required',
    });
  });

  it('addresses buckets virtual-host style when the config says so', async () => {
    const mock = new MockS3('zephyr', true);
    const store = s3(mock, false);
    await store.put('a b/c+d.jpg', bytes('x'), { contentType: 'image/jpeg' });
    expect(must(mock.seen[0]).url.toString()).toBe('https://zephyr.s3.example.test/a%20b/c%2Bd.jpg');
    expect((await store.get('a b/c+d.jpg'))?.size).toBe(1);
  });

  it('reads objects, ranges and heads; a missing key is null', async () => {
    const mock = new MockS3();
    const store = s3(mock);
    await store.put('k', bytes('0123456789'), { contentType: 'image/webp' });
    const whole = must(await store.get('k'));
    expect(whole.contentType).toBe('image/webp');
    expect(new TextDecoder().decode(await whole.bytes())).toBe('0123456789');
    const part = must(await store.get('k', { range: { offset: 2, length: 3 } }));
    expect(must(mock.seen.at(-1)).headers.get('range')).toBe('bytes=2-4');
    expect(part.size).toBe(10);
    expect(new TextDecoder().decode(await part.bytes())).toBe('234');
    const head = must(await store.head('k'));
    expect(head.size).toBe(10);
    expect(head.etag).not.toContain('"');
    expect(await store.head('nope')).toBeNull();
    expect(await store.get('nope')).toBeNull();
  });

  it('lists with continuation tokens and decodes XML entities', async () => {
    const mock = new MockS3();
    mock.pageSize = 2;
    const store = s3(mock);
    for (const k of ['u/a/1', 'u/a/2', 'u/a/3&4', 'v/other'])
      await store.put(k, bytes(k), { contentType: 'x/y' });
    const first = await store.list('u/', { limit: 1000 });
    expect(first.objects.map((o) => o.key)).toEqual(['u/a/1', 'u/a/2']);
    expect(first.cursor).toBe('u/a/2');
    const second = await store.list('u/', { cursor: first.cursor });
    expect(must(mock.seen.at(-1)).url.searchParams.get('continuation-token')).toBe('u/a/2');
    expect(second.objects.map((o) => o.key)).toEqual(['u/a/3&4']);
    expect(second.objects[0]?.size).toBe('u/a/3&4'.length);
    expect(second.objects[0]?.uploaded.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(second.cursor).toBeNull();
  });

  it('parses list XML without a DOM, including truncation', () => {
    const r = parseList(
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&lt;b&#x41;</Key><Size>7</Size><ETag>"e1"</ETag><LastModified>bad</LastModified></Contents><NextContinuationToken>t&amp;1</NextContinuationToken></ListBucketResult>',
    );
    expect(r).toMatchObject({
      truncated: true,
      next: 't&1',
      objects: [{ key: 'a<bA', size: 7, etag: 'e1' }],
    });
    expect(r.objects[0]?.lastModified.getTime()).toBe(0);
  });

  it('deletes in one signed DeleteObjects call with Content-MD5 and a hashed body', async () => {
    const mock = new MockS3();
    const store = s3(mock);
    await store.put('a&b', bytes('1'), { contentType: 'x/y' });
    await store.put('c', bytes('2'), { contentType: 'x/y' });
    await store.delete(['a&b', 'c', 'missing']);
    const req = must(mock.seen.at(-1));
    expect(req.method).toBe('POST');
    expect(req.url.search).toBe('?delete');
    expect(req.headers.get('content-md5')).toBe(createHash('md5').update(req.body).digest('base64'));
    expect(req.headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update(req.body).digest('hex'));
    expect(new TextDecoder().decode(req.body)).toContain('<Key>a&amp;b</Key>');
    expect(mock.objects.size).toBe(0);
    await expect(store.delete(Array.from({ length: 1001 }, (_, i) => `k${i}`))).rejects.toMatchObject({
      code: 'too_many_keys',
    });
    mock.deleteError = true;
    await expect(store.delete(['x'])).rejects.toMatchObject({ code: 'delete_partial' });
  });

  it('runs multipart uploads: create, parts, complete (including a 200 with an error), abort', async () => {
    const mock = new MockS3();
    const store = s3(mock);
    const id = await store.createMultipart('u/o/p/1/original', 'image/x-canon-cr3');
    const e2 = await store.uploadPart('u/o/p/1/original', id, 2, streamOf(bytes('world')), 5);
    const e1 = await store.uploadPart('u/o/p/1/original', id, 1, bytes('hello '), 6);
    expect(e1).toBe('part-1');
    const partReq = must(mock.seen.find((s) => s.url.searchParams.get('partNumber') === '2'));
    expect(partReq.headers.get('content-length')).toBe('5');
    expect(partReq.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    await store.completeMultipart('u/o/p/1/original', id, [
      { partNumber: 2, etag: e2 },
      { partNumber: 1, etag: e1 },
    ]);
    expect(new TextDecoder().decode(mock.objects.get('u/o/p/1/original')?.bytes)).toBe('hello world');
    const done = must(mock.seen.at(-1));
    expect(new TextDecoder().decode(done.body)).toMatch(
      /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>/,
    );

    const id2 = await store.createMultipart('k2', 'image/jpeg');
    await store.uploadPart('k2', id2, 1, bytes('x'), 1);
    mock.completeError = true;
    await expect(
      store.completeMultipart('k2', id2, [{ partNumber: 1, etag: 'part-1' }]),
    ).rejects.toMatchObject({
      code: 'InternalError',
    });
    await store.abortMultipart('k2', id2);
    expect(mock.uploads.size).toBe(0);
    await store.abortMultipart('k2', id2); // already gone: not an error
  });

  it('maps failures to short codes and never surfaces the error body', async () => {
    const mock = new MockS3();
    const store = s3(mock);
    mock.next = {
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Message>bucket zephyr-secret-bucket key AKIDTEST</Message></Error>',
    };
    const err = await store.get('k').catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: 'AccessDenied', status: 403 });
    expect(String(err.message)).not.toContain('zephyr-secret-bucket');
    mock.next = { status: 500, body: '<html>oops</html>' };
    await expect(store.list('u/')).rejects.toMatchObject({ code: 'http_500' });
    mock.next = { status: 400, body: '<Error><Code>Bad"Code<script></Code></Error>' };
    await expect(store.list('u/')).rejects.toMatchObject({ code: 'BadCodescript' });
    const down = s3Store(
      { id: 'x1', endpoint: 'https://s3.example.test', bucket: 'zephyr', region: 'auto', pathStyle: true },
      CREDS,
      async () => {
        throw new TypeError('connect ECONNREFUSED 10.0.0.5');
      },
    );
    await expect(down.head('k')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('md5 matches node:crypto (Content-MD5 has to be exact)', () => {
    for (const s of ['', 'a', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)]) {
      expect(Buffer.from(md5(bytes(s))).toString('hex')).toBe(createHash('md5').update(s).digest('hex'));
    }
  });
});

// ================================================================ config and fetchers
const STORES = [
  {
    id: 'b2-eu',
    name: 'Backblaze B2',
    kind: 's3',
    connection: 'https',
    endpoint: 'https://s3.example.test',
    bucket: 'zephyr',
    region: 'eu-test-1',
    pathStyle: true,
    costPerTbMonthUsd: 6,
    encryptionAtRest: true,
  },
  {
    id: 'studio-nas',
    name: 'Studio NAS',
    kind: 's3',
    connection: 'vpc',
    binding: 'VPC_GARAGE',
    endpoint: 'http://garage.internal:3900',
    bucket: 'zephyr',
    region: 'garage',
    capacityBytes: 1_000_000,
    encryptionAtRest: true,
  },
  {
    id: 'tunnel-nas',
    name: 'Tunnel NAS',
    kind: 's3',
    connection: 'tunnel',
    endpoint: 'https://s3.studio.test',
    bucket: 'zephyr',
    encryptionAtRest: false,
  },
];
const mocks = { b2: new MockS3(), vpc: new MockS3(), tunnel: new MockS3() };
const vpcBinding = { fetch: vi.fn((req: Request) => mocks.vpc.fetcher(req)) };
function storageEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ...env,
    STORAGE_STORES: JSON.stringify(STORES),
    STORE_B2_EU_ACCESS_KEY_ID: 'AK-B2',
    STORE_B2_EU_SECRET: 'SK-B2',
    STORE_STUDIO_NAS_ACCESS_KEY_ID: 'AK-NAS',
    STORE_STUDIO_NAS_SECRET: 'SK-NAS',
    STORE_TUNNEL_NAS_ACCESS_KEY_ID: 'AK-T',
    STORE_TUNNEL_NAS_SECRET: 'SK-T',
    STORE_TUNNEL_NAS_ACCESS_CLIENT_ID: 'cf-client.access',
    STORE_TUNNEL_NAS_ACCESS_CLIENT_SECRET: 'cf-client-secret',
    VPC_GARAGE: vpcBinding,
    ...extra,
  } as unknown as Env;
}
/** Routes the S3 hosts the tests use to their mocks (on top of the usual fake services). */
function routeS3() {
  const base = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) {
        const host = new URL(input.url).host;
        if (host === 's3.example.test') return mocks.b2.fetcher(input);
        if (host === 's3.studio.test') return mocks.tunnel.fetcher(input);
      }
      return base(input, init);
    }),
  );
}

describe('store config and connections', () => {
  beforeEach(() => {
    mocks.b2 = new MockS3();
    mocks.vpc = new MockS3();
    mocks.tunnel = new MockS3();
    vpcBinding.fetch.mockClear();
    routeS3();
  });

  it('the database accepts exactly the store ids the config does (one rule: dashes, mapped to underscores in secrets)', () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/20261115100100_storage.sql', import.meta.url).href),
      'utf8',
    );
    const m = /_store_id_ok\(p text\)[\s\S]*?select p ~ '([^']+)'/.exec(sql);
    expect(m?.[1]).toBe(STORE_ID_RE.source);
    expect(STORE_ID_RE.test('studio-nas')).toBe(true);
    expect(STORE_ID_RE.test('studio_nas')).toBe(false);
    expect(secretName('studio-nas', 'SECRET')).toBe('STORE_STUDIO_NAS_SECRET');
  });
  it("always has 'r2', and names secrets after the store id", () => {
    expect(storeConfigs({ ...env } as Env).map((s) => s.id)).toEqual(['r2']);
    expect(storeConfigs(storageEnv()).map((s) => s.id)).toEqual(['r2', 'b2-eu', 'studio-nas', 'tunnel-nas']);
    expect(secretName('studio-nas', 'SECRET')).toBe('STORE_STUDIO_NAS_SECRET');
    // A JSON value straight from wrangler.jsonc vars works too.
    expect(storeConfigs({ ...env, STORAGE_STORES: STORES } as unknown as Env)).toHaveLength(4);
  });

  it('an invalid config leaves only r2 and is reported, without logging its content', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const bad of [
      '{not json',
      JSON.stringify([{ ...STORES[0], endpoint: 'http://s3.example.test' }]), // public endpoint without TLS
      JSON.stringify([{ ...STORES[0], endpoint: 'https://user:pw@s3.example.test' }]),
      JSON.stringify([STORES[0], STORES[0]]),
      JSON.stringify([{ ...STORES[1], binding: undefined }]),
      JSON.stringify([{ ...STORES[0], accessKeyId: 'AK' }]), // credentials never belong here
    ]) {
      const e = { ...env, STORAGE_STORES: bad } as Env;
      expect(storeConfigs(e).map((s) => s.id)).toEqual(['r2']);
      expect(storeConfigError(e)).toBe('config_invalid');
    }
    expect(log.mock.calls.flat().join(' ')).not.toContain('s3.example.test');
  });

  it('a public S3 store goes over fetch, signed with its own secrets', async () => {
    const store = storeFor(storageEnv(), 'b2-eu');
    await store.put('k', bytes('x'), { contentType: 'x/y' });
    const req = must(mocks.b2.seen[0]);
    expect(req.headers.get('authorization')).toContain('Credential=AK-B2/');
    expect(req.headers.has('cf-access-client-id')).toBe(false);
  });

  it('a Workers VPC store goes through the binding, path-style, to its internal endpoint', async () => {
    const store = storeFor(storageEnv(), 'studio-nas');
    await store.put('k', bytes('x'), { contentType: 'x/y' });
    expect(vpcBinding.fetch).toHaveBeenCalledTimes(1);
    const req = must(mocks.vpc.seen[0]);
    expect(req.url.toString()).toBe('http://garage.internal:3900/zephyr/k');
    expect(req.headers.get('authorization')).toContain('Credential=AK-NAS/');
    expect(world.calls.some((c) => c.url.includes('garage.internal'))).toBe(false); // never the public fetch
    await expect(async () =>
      storeFor(storageEnv({ VPC_GARAGE: undefined }), 'studio-nas'),
    ).rejects.toMatchObject({
      code: 'binding_missing',
    });
  });

  it('a tunnel store adds the Access service token to every request, after signing', async () => {
    const store = storeFor(storageEnv(), 'tunnel-nas');
    await store.list('u/');
    const req = must(mocks.tunnel.seen[0]);
    expect(req.headers.get('cf-access-client-id')).toBe('cf-client.access');
    expect(req.headers.get('cf-access-client-secret')).toBe('cf-client-secret');
    const signed = /SignedHeaders=([^,]+)/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
    expect(signed).not.toContain('cf-access');
    await expect(async () =>
      storeFor(storageEnv({ STORE_TUNNEL_NAS_ACCESS_CLIENT_SECRET: undefined }), 'tunnel-nas'),
    ).rejects.toMatchObject({ code: 'credentials_missing' });
  });

  it('an unknown store or a missing key is a StoreError', async () => {
    await expect(async () => storeFor(storageEnv(), 'nope')).rejects.toMatchObject({ code: 'unknown_store' });
    await expect(async () => storeFor(storageEnv({ STORE_B2_EU_SECRET: '' }), 'b2-eu')).rejects.toMatchObject(
      {
        code: 'credentials_missing',
      },
    );
  });
});

// ================================================================ migration
const OWNER = '20000000-0000-0000-0000-000000000001';
const PHOTO = '30000000-0000-0000-0000-000000000001';
const MIGRATION = '40000000-0000-0000-0000-000000000001';
const PHOTO2 = '30000000-0000-0000-0000-000000000002';
const prefix = `u/${OWNER}/p/${PHOTO}/`;

describe('migration copy and verify', () => {
  let r2b: MockR2;
  let menv: Env;
  const TOKEN = '50000000-0000-0000-0000-000000000001';
  const item = (over: Partial<MigrationItem> = {}): MigrationItem => ({
    photoId: PHOTO,
    ownerId: OWNER,
    from: 'r2',
    to: 'b2-eu',
    attempts: 1,
    token: TOKEN,
    ...over,
  });
  beforeEach(() => {
    mocks.b2 = new MockS3();
    routeS3();
    r2b = new MockR2();
    menv = storageEnv({ PHOTOS: r2b });
    // The lease renewal: the keys the database records for the photo and the original's size.
    world.rpc.storage_item_touch = (a) =>
      a.p_token === TOKEN ? { keys: [`${prefix}original`, `${prefix}thumb`], minBytes: 18 } : null;
  });

  async function seed() {
    await r2b.put(`${prefix}original`, bytes('the original bytes'), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await r2b.put(`${prefix}thumb`, bytes('thumb'), { httpMetadata: { contentType: 'image/webp' } });
    await r2b.put(`u/${OWNER}/p/other/original`, bytes('not this photo'));
  }

  it('renews the lease, streams every object under the photo prefix, verifies its SHA-256 and marks the item verified with its token', async () => {
    await seed();
    const marks: Record<string, unknown>[] = [];
    world.rpc.storage_item_mark = (a) => {
      marks.push(a);
      return null;
    };
    expect(await migrateItem(menv, MIGRATION, item())).toBe('verified');
    expect(rpcCalls('storage_item_touch')[0]?.body).toEqual({
      p_migration: MIGRATION,
      p_photo: PHOTO,
      p_token: TOKEN,
    });
    expect([...mocks.b2.objects.keys()].sort()).toEqual([`${prefix}original`, `${prefix}thumb`]);
    expect(mocks.b2.objects.get(`${prefix}original`)?.type).toBe('image/jpeg');
    expect(marks).toEqual([
      {
        p_migration: MIGRATION,
        p_photo: PHOTO,
        p_state: 'verified',
        p_bytes: 'the original bytes'.length + 'thumb'.length,
        p_error: null,
        p_retry_after_s: null,
        p_token: TOKEN,
        p_store: null,
      },
    ]);
    // The old copy stays until the hold has passed.
    expect(r2b.objects.has(`${prefix}original`)).toBe(true);
  });

  it('a lease that was taken over is skipped: nothing is copied or reported', async () => {
    await seed();
    world.rpc.storage_item_mark = () => {
      throw new Error('must not report');
    };
    expect(await migrateItem(menv, MIGRATION, item({ token: '50000000-0000-0000-0000-0000000000ff' }))).toBe(
      'skipped',
    );
    expect(mocks.b2.objects.size).toBe(0);
  });

  it('a copy missing a recorded key, or with nothing in it, never counts as verified', async () => {
    await seed();
    const marks: Record<string, unknown>[] = [];
    world.rpc.storage_item_mark = (a) => {
      marks.push(a);
      return null;
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The database records an edited preview the source doesn't have.
    world.rpc.storage_item_touch = () => ({
      keys: [`${prefix}original`, `${prefix}thumb`, `${prefix}edit-1-preview-${'a'.repeat(32)}`],
      minBytes: 18,
    });
    expect(await migrateItem(menv, MIGRATION, item())).toBe('pending');
    expect(marks[0]).toMatchObject({ p_state: 'pending', p_error: 'source_incomplete', p_token: TOKEN });
    // An empty listing (the source lost everything): not a copy either, even if no keys were listed.
    r2b.objects.clear();
    world.rpc.storage_item_touch = () => ({ keys: [], minBytes: 0 });
    expect(await migrateItem(menv, MIGRATION, item())).toBe('pending');
    expect(marks[1]).toMatchObject({ p_state: 'pending', p_error: 'source_incomplete' });
    // A copy lighter than the original.
    await seed();
    world.rpc.storage_item_touch = () => ({ keys: [`${prefix}original`], minBytes: 10_000 });
    expect(await migrateItem(menv, MIGRATION, item())).toBe('pending');
    expect(marks[2]).toMatchObject({ p_state: 'pending', p_error: 'source_incomplete' });
  });

  it('a hash mismatch on read-back retries with a backoff, then fails on the fifth attempt (attempts come from the claim)', async () => {
    await seed();
    mocks.b2.corrupt = true;
    const marks: Record<string, unknown>[] = [];
    world.rpc.storage_item_mark = (a) => {
      marks.push(a);
      return null;
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await migrateItem(menv, MIGRATION, item({ attempts: 1 }))).toBe('pending');
    expect(marks[0]).toMatchObject({ p_state: 'pending', p_error: 'hash_mismatch', p_retry_after_s: 60 });
    expect(await migrateItem(menv, MIGRATION, item({ attempts: 4 }))).toBe('pending');
    expect(await migrateItem(menv, MIGRATION, item({ attempts: 5 }))).toBe('failed');
    expect(marks[2]).toMatchObject({
      p_state: 'failed',
      p_error: 'hash_mismatch',
      p_bytes: 0,
      p_token: TOKEN,
    });
    await expect(
      copyVerified(r2Store(r2b as unknown as R2Bucket), storeFor(menv, 'b2-eu'), `${prefix}thumb`),
    ).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
  });

  it('claims batches of 20, queues the next batch when full, and acks the message', async () => {
    await seed();
    const items = Array.from({ length: 20 }, () => item());
    world.rpc.storage_migration_batch = (a) => {
      expect(a).toEqual({ p_migration: MIGRATION, p_limit: 20 });
      return items;
    };
    world.rpc.storage_item_mark = () => null;
    expect(await runMigrationBatch(menv, MIGRATION)).toBe(20);
    expect(storageQueue.sent).toEqual([{ t: 'migrate', migration: MIGRATION }]);
    world.rpc.storage_migration_batch = () => [];
    const ack = vi.fn();
    const retry = vi.fn();
    await handleStorageBatch(
      {
        queue: 'zephyr-storage',
        messages: [{ body: { t: 'migrate', migration: MIGRATION }, ack, retry }],
      } as unknown as MessageBatch<import('../src/env').StorageMessage>,
      menv,
    );
    expect(ack).toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(storageQueue.sent).toHaveLength(1);
  });

  const due = { migrationId: MIGRATION, photoId: PHOTO, ownerId: OWNER, from: 'r2', to: 'b2-eu' };

  it("old copies: claimed first; late writes are copied to the photo's store, then the old store is emptied for that photo only", async () => {
    await seed();
    const from = r2Store(r2b as unknown as R2Bucket);
    const to = storeFor(menv, 'b2-eu');
    await copyVerified(from, to, `${prefix}original`); // thumb never reached the new store
    world.rpc.storage_old_copy_claim = (a) => {
      expect(a).toEqual({ p_migration: MIGRATION, p_photo: PHOTO, p_store: 'r2' });
      return { copyTo: 'b2-eu' };
    };
    expect(await deleteOldCopy(menv, due)).toBe(2);
    expect(mocks.b2.objects.has(`${prefix}thumb`)).toBe(true);
    expect(r2b.objects.has(`${prefix}original`)).toBe(false);
    expect(r2b.objects.has(`u/${OWNER}/p/other/original`)).toBe(true);
  });

  it("old copies of a photo that's gone (or a partial copy never used) are deleted without copying anything back", async () => {
    await seed();
    world.rpc.storage_old_copy_claim = () => ({ copyTo: null });
    expect(await deleteOldCopy(menv, due)).toBe(2);
    expect(mocks.b2.objects.size).toBe(0);
    expect(r2b.objects.has(`${prefix}original`)).toBe(false);
  });

  it("an old copy the database won't let go of (a rollback, the photo back on that store) is left alone", async () => {
    await seed();
    world.rpc.storage_old_copy_claim = () => null;
    expect(await deleteOldCopy(menv, due)).toBeNull();
    expect(r2b.objects.has(`${prefix}original`)).toBe(true);
  });

  it('the cron keeps a migration moving (holding included) and deletes old copies once due, reporting the store', async () => {
    await seed();
    await copyVerified(r2Store(r2b as unknown as R2Bucket), storeFor(menv, 'b2-eu'), `${prefix}original`);
    await copyVerified(r2Store(r2b as unknown as R2Bucket), storeFor(menv, 'b2-eu'), `${prefix}thumb`);
    world.rpc.storage_status = () => ({
      writeStore: 'b2-eu',
      migration: { id: MIGRATION, state: 'holding' },
      cleanupPending: true,
    });
    world.rpc.storage_old_copies_due = () => [due];
    world.rpc.storage_old_copy_claim = () => ({ copyTo: 'b2-eu' });
    const marks: Record<string, unknown>[] = [];
    world.rpc.storage_item_mark = (a) => {
      marks.push(a);
      return null;
    };
    expect(await runMigrationCron(menv)).toEqual({ enqueued: true, oldCopiesDeleted: 2, followupsCopied: 0 });
    expect(storageQueue.sent).toEqual([{ t: 'migrate', migration: MIGRATION }]);
    expect(marks[0]).toMatchObject({ p_state: 'deleted', p_photo: PHOTO, p_store: 'r2', p_token: null });
    expect(r2b.objects.has(`${prefix}thumb`)).toBe(false);
  });

  it('followMove copies an object written to the old store after its photo moved', async () => {
    await seed();
    world.rpc.storage_photo_store = (a) => (a.p_photo === PHOTO ? 'b2-eu' : null);
    await followMove(menv, PHOTO, 'r2', [`${prefix}thumb`]);
    expect(mocks.b2.objects.has(`${prefix}thumb`)).toBe(true);
    // Recorded first, cleared once copied.
    expect(rpcCalls('storage_followup_add')[0]?.body).toEqual({
      p_photo: PHOTO,
      p_from: 'r2',
      p_keys: [`${prefix}thumb`],
    });
    expect(rpcCalls('storage_followup_done')[0]?.body).toEqual({
      p_photo: PHOTO,
      p_key: `${prefix}thumb`,
      p_from: 'r2',
      p_ok: true,
    });
    // Not moved (or gone): nothing to do, nothing recorded.
    mocks.b2.objects.clear();
    await followMove(menv, PHOTO, 'b2-eu', [`${prefix}thumb`]);
    world.rpc.storage_photo_store = () => null;
    await followMove(menv, PHOTO, 'r2', [`${prefix}thumb`]);
    expect(mocks.b2.objects.size).toBe(0);
    expect(rpcCalls('storage_followup_add')).toHaveLength(1);
  });

  it('a followMove copy that fails stays recorded, and the cron copies it to wherever the photo is then', async () => {
    await seed();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    world.rpc.storage_photo_store = () => 'b2-eu';
    mocks.b2.next = { status: 503, body: '' };
    await followMove(menv, PHOTO, 'r2', [`${prefix}thumb`]);
    expect(rpcCalls('storage_followup_add')).toHaveLength(1);
    expect(rpcCalls('storage_followup_done')).toHaveLength(0);
    expect(mocks.b2.objects.has(`${prefix}thumb`)).toBe(false);
    // The cron's retry.
    world.rpc.storage_followups_due = () => [
      { photoId: PHOTO, key: `${prefix}thumb`, from: 'r2', to: 'b2-eu' },
    ];
    expect(await runFollowups(menv)).toBe(1);
    expect(mocks.b2.objects.has(`${prefix}thumb`)).toBe(true);
    expect(rpcCalls('storage_followup_done').at(-1)?.body).toMatchObject({ p_ok: true });
    // Already there, the photo gone, or back on the store it was written to: just cleared.
    world.rpc.storage_followups_due = () => [
      { photoId: PHOTO, key: `${prefix}thumb`, from: 'r2', to: 'b2-eu' },
      { photoId: PHOTO, key: `${prefix}original`, from: 'r2', to: null },
      { photoId: PHOTO, key: `${prefix}original`, from: 'r2', to: 'r2' },
    ];
    expect(await runFollowups(menv)).toBe(0);
    expect(mocks.b2.objects.has(`${prefix}original`)).toBe(false);
    expect(
      rpcCalls('storage_followup_done')
        .slice(-3)
        .map((c) => (c.body as { p_ok: boolean }).p_ok),
    ).toEqual([true, true, true]);
    // A failed retry backs off.
    mocks.b2.objects.clear();
    mocks.b2.next = { status: 503, body: '' };
    world.rpc.storage_followups_due = () => [
      { photoId: PHOTO, key: `${prefix}thumb`, from: 'r2', to: 'b2-eu' },
    ];
    expect(await runFollowups(menv)).toBe(0);
    expect(rpcCalls('storage_followup_done').at(-1)?.body).toMatchObject({ p_ok: false });
  });

  it('followUnknown records a follow-up without copying (the cron decides once the outcome is known)', async () => {
    await seed();
    await followUnknown(menv, PHOTO, 'r2', [`${prefix}thumb`]);
    expect(rpcCalls('storage_followup_add')[0]?.body).toEqual({
      p_photo: PHOTO,
      p_from: 'r2',
      p_keys: [`${prefix}thumb`],
    });
    expect(mocks.b2.objects.size).toBe(0);
  });

  it("followRecorded copies a recorded object to its photo's store from whichever store has it", async () => {
    await seed();
    world.rpc.storage_photo_store = () => 'b2-eu';
    await followRecorded(menv, PHOTO, `${prefix}thumb`);
    expect(mocks.b2.objects.has(`${prefix}thumb`)).toBe(true);
    expect(rpcCalls('storage_followup_add')[0]?.body).toMatchObject({
      p_from: 'r2',
      p_keys: [`${prefix}thumb`],
    });
    // Already on the photo's store, or the photo gone: nothing more.
    await followRecorded(menv, PHOTO, `${prefix}thumb`);
    world.rpc.storage_photo_store = () => null;
    await followRecorded(menv, PHOTO, `${prefix}original`);
    expect(rpcCalls('storage_followup_add')).toHaveLength(1);
    expect(mocks.b2.objects.has(`${prefix}original`)).toBe(false);
  });

  it('the cron drops follow-ups older than 7 days before retrying the rest', async () => {
    await runFollowups(menv);
    const fns = world.calls.map((c) => c.url.split('/rpc/')[1]).filter(Boolean);
    expect(fns.indexOf('storage_followups_expire')).toBeGreaterThanOrEqual(0);
    expect(fns.indexOf('storage_followups_expire')).toBeLessThan(fns.indexOf('storage_followups_due'));
  });

  it('a rollback accepts a recorded key that is already on the destination (a follow-up copy that never reached the new store)', async () => {
    await seed();
    const marks: Record<string, unknown>[] = [];
    world.rpc.storage_item_mark = (a) => {
      marks.push(a);
      return null;
    };
    // The edited preview was written to R2 (the destination of the copy back) and never reached b2-eu.
    const edited = `${prefix}edit-1-preview-${'a'.repeat(32)}`;
    await r2b.put(edited, bytes('edited'));
    await copyVerified(r2Store(r2b as unknown as R2Bucket), storeFor(menv, 'b2-eu'), `${prefix}original`);
    await copyVerified(r2Store(r2b as unknown as R2Bucket), storeFor(menv, 'b2-eu'), `${prefix}thumb`);
    world.rpc.storage_item_touch = () => ({
      keys: [`${prefix}original`, `${prefix}thumb`, edited],
      minBytes: 18,
    });
    expect(await migrateItem(menv, MIGRATION, item({ from: 'b2-eu', to: 'r2' }))).toBe('verified');
    expect(marks[0]).toMatchObject({
      p_state: 'verified',
      p_bytes: 'the original bytes'.length + 'thumb'.length + 'edited'.length,
    });
    // Missing on both: still not a copy.
    r2b.objects.delete(edited);
    expect(await migrateItem(menv, MIGRATION, item({ from: 'b2-eu', to: 'r2' }))).toBe('pending');
  });

  it('a truncated S3 listing with no continuation token is an error, never a complete list', async () => {
    mocks.b2.next = {
      status: 200,
      body: '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
    };
    await expect(storeFor(menv, 'b2-eu').list(prefix, { limit: 10 })).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('photos on another store: purges and the orphan sweep', () => {
  let r2b: MockR2;
  let menv: Env;
  beforeEach(() => {
    mocks.b2 = new MockS3();
    routeS3();
    r2b = new MockR2();
    menv = storageEnv({ PHOTOS: r2b });
  });

  it("permanent deletes remove the objects on each photo's own store", async () => {
    await r2b.put(`${prefix}original`, bytes('on r2'));
    await storeFor(menv, 'b2-eu').put(`u/${OWNER}/p/${PHOTO2}/original`, bytes('on b2'), {
      contentType: 'image/jpeg',
    });
    world.rpc.confirm_photo_purges = (a) => (a.p_ids as string[]).length;
    await purgeNow(menv, [
      { photoId: PHOTO, keys: [`${prefix}original`], storeId: 'r2' },
      { photoId: PHOTO2, keys: [`u/${OWNER}/p/${PHOTO2}/original`], storeId: 'b2-eu' },
    ]);
    expect(r2b.objects.has(`${prefix}original`)).toBe(false);
    expect(mocks.b2.objects.has(`u/${OWNER}/p/${PHOTO2}/original`)).toBe(false);
    expect(rpcCalls('confirm_photo_purges')[0]?.body).toEqual({ p_ids: [PHOTO, PHOTO2] });
  });

  it('staged variants older than 2 days are swept on stores other than R2 (R2 has its lifecycle rule)', async () => {
    const staged = `staging/${OWNER}/${PHOTO2}/thumb`;
    await storeFor(menv, 'b2-eu').put(staged, bytes('staged'), { contentType: 'image/webp' });
    await r2b.put(`staging/${OWNER}/${PHOTO}/thumb`, bytes('on r2'));
    r2b.backdate(`staging/${OWNER}/${PHOTO}/thumb`, 5 * 24 * 3600 * 1000);
    const cursors = new Map<string, unknown>();
    world.rpc.get_job_state = (a) => cursors.get(String(a.p_key)) ?? null;
    world.rpc.set_job_state = (a) => {
      cursors.set(String(a.p_key), a.p_value);
      return null;
    };
    // The mock S3 lists objects as modified on 1 November 10:00: a day later they're kept.
    expect(await sweepStaging(menv, Date.parse('2026-11-02T10:00:00Z'))).toBe(0);
    expect(mocks.b2.objects.has(staged)).toBe(true);
    expect(await sweepStaging(menv, Date.parse('2026-11-04T10:00:00Z'))).toBe(1);
    expect(mocks.b2.objects.has(staged)).toBe(false);
    expect(r2b.objects.has(`staging/${OWNER}/${PHOTO}/thumb`)).toBe(true);
    expect(cursors.has('staging_sweep_cursor:b2-eu')).toBe(true);
    expect([...cursors.keys()].some((k) => k.endsWith(':r2'))).toBe(false);
  });

  it("publishing: one photo whose store fails doesn't hold up the others, and a staged copy waiting 2 days is given up on", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const P3 = '30000000-0000-0000-0000-000000000003';
    // PHOTO: on a store that isn't configured (throws). PHOTO2: staged copy of the right size. P3: a staged
    // copy of the wrong size, stale.
    await r2b.put(`staging/${OWNER}/${PHOTO2}/thumb`, bytes('12345'), {
      httpMetadata: { contentType: 'image/webp' },
    });
    await r2b.put(`staging/${OWNER}/${P3}/thumb`, bytes('123'), {
      httpMetadata: { contentType: 'image/webp' },
    });
    const finished: Record<string, unknown>[] = [];
    world.rpc.finish_publish = (a) => {
      finished.push(a);
      return true;
    };
    world.rpc.due_publishes = () => [
      { photoId: PHOTO, ownerId: OWNER, thumbBytes: 5, previewBytes: 0, storeId: 'gone' },
      { photoId: PHOTO2, ownerId: OWNER, thumbBytes: 5, previewBytes: 0, storeId: 'r2' },
      { photoId: P3, ownerId: OWNER, thumbBytes: 5, previewBytes: 0, storeId: 'r2', stale: false },
    ];
    expect(await retryPublishes(menv)).toEqual({ published: 1, lost: 0 });
    expect(finished.map((f) => f.p_photo)).toEqual([PHOTO2]);
    expect(r2b.objects.has(`u/${OWNER}/p/${PHOTO2}/thumb`)).toBe(true);
    // Not stale: the wrong-size staged copy waits.
    expect(r2b.objects.has(`staging/${OWNER}/${P3}/thumb`)).toBe(true);
    world.rpc.due_publishes = () => [
      { photoId: P3, ownerId: OWNER, thumbBytes: 5, previewBytes: 0, storeId: 'r2', stale: true },
    ];
    expect(await retryPublishes(menv)).toEqual({ published: 0, lost: 1 });
    expect(finished.at(-1)).toMatchObject({ p_photo: P3, p_lost_thumb: true, p_lost_preview: false });
    expect(r2b.objects.has(`staging/${OWNER}/${P3}/thumb`)).toBe(false);
  });

  it("a copy away from its photo's store is kept while a finished or rolled-back migration still holds old copies", async () => {
    await r2b.put(`${prefix}original`, bytes('old copy'));
    world.rpc.get_job_state = () => null;
    world.rpc.set_job_state = () => null;
    world.rpc.sweep_photo_rows = () => [
      { id: PHOTO, ownerId: OWNER, status: 'ready', activeUpload: false, storeId: 'b2-eu', maskKeys: [] },
    ];
    const later = Date.now() + 3 * 60 * 60 * 1000;
    world.rpc.storage_status = () => ({ writeStore: 'r2', migration: null, cleanupPending: true });
    await sweepOrphans(menv, later);
    expect(r2b.objects.has(`${prefix}original`)).toBe(true);
    world.rpc.storage_status = () => ({ writeStore: 'r2', migration: null, cleanupPending: false });
    await sweepOrphans(menv, later);
    expect(r2b.objects.has(`${prefix}original`)).toBe(false);
    // The photo still points at its original, so it was copied to the photo's store before going.
    expect(new TextDecoder().decode(mocks.b2.objects.get(`${prefix}original`)?.bytes)).toBe('old copy');
  });

  it("never deletes a live copy away from its photo's store until the photo's store holds it", async () => {
    const edit = `${prefix}edit-3-thumb-${'a'.repeat(32)}`;
    const staleEdit = `${prefix}edit-2-thumb-${'b'.repeat(32)}`;
    const mask = `${prefix}m/${'c0000000-0000-4000-8000-000000000001'}.png`;
    await r2b.put(edit, bytes('only copy of the edit'));
    await r2b.put(staleEdit, bytes('replaced edit'));
    await r2b.put(mask, bytes('mask'));
    await r2b.put(`${prefix}thumb`, bytes('thumb'));
    await r2b.put(`${prefix}preview`, bytes('preview, already there'));
    mocks.b2.objects.set(`${prefix}preview`, {
      bytes: bytes('preview, already there'),
      type: 'image/webp',
      etag: '"p"',
    });
    world.rpc.get_job_state = () => null;
    world.rpc.set_job_state = () => null;
    world.rpc.storage_status = () => ({ writeStore: 'b2-eu', migration: null, cleanupPending: false });
    const row = {
      id: PHOTO,
      ownerId: OWNER,
      status: 'ready',
      activeUpload: false,
      storeId: 'b2-eu',
      editThumbKey: edit,
      editPreviewKey: null,
      maskKeys: [mask],
      hasThumb: false,
      hasPreview: true,
    };
    world.rpc.sweep_photo_rows = () => [row];
    const later = Date.now() + 3 * 60 * 60 * 1000;
    // The photo's store is down: nothing it still points at is deleted; the unrecorded keys go.
    mocks.b2.down = true;
    await sweepOrphans(menv, later);
    expect(r2b.objects.has(edit)).toBe(true);
    expect(r2b.objects.has(mask)).toBe(true);
    expect(r2b.objects.has(`${prefix}preview`)).toBe(true);
    expect(r2b.objects.has(staleEdit)).toBe(false);
    expect(r2b.objects.has(`${prefix}thumb`)).toBe(false);
    // Back up: the edit and mask are copied over (verified) first, the preview was already there; then all go.
    mocks.b2.down = false;
    await sweepOrphans(menv, later);
    expect(new TextDecoder().decode(mocks.b2.objects.get(edit)?.bytes)).toBe('only copy of the edit');
    expect(new TextDecoder().decode(mocks.b2.objects.get(mask)?.bytes)).toBe('mask');
    for (const k of [edit, mask, `${prefix}preview`]) expect(r2b.objects.has(k)).toBe(false);
    // A photo being purged, or still uploading: nothing is rescued, and an upload's copies are left alone.
    await r2b.put(`${prefix}original`, bytes('purging'));
    world.rpc.sweep_photo_rows = () => [{ ...row, status: 'purging' }];
    await sweepOrphans(menv, later);
    expect(r2b.objects.has(`${prefix}original`)).toBe(false);
    expect(mocks.b2.objects.has(`${prefix}original`)).toBe(false);
    await r2b.put(`${prefix}original`, bytes('uploading'));
    world.rpc.sweep_photo_rows = () => [{ ...row, status: 'uploading', activeUpload: true }];
    await sweepOrphans(menv, later);
    expect(r2b.objects.has(`${prefix}original`)).toBe(true);
  });
});

// ================================================================ health and auto read-only
describe('health checks and auto read-only', () => {
  let streak: { fail: number; ok: number; auto: boolean };
  let readOnly: { on: boolean; reason: string }[];
  beforeEach(() => {
    mocks.b2 = new MockS3();
    mocks.vpc = new MockS3();
    routeS3();
    streak = { fail: 0, ok: 0, auto: false };
    readOnly = [];
    world.rpc.storage_status = () => ({ writeStore: 'b2-eu', migration: null });
    world.rpc.storage_check_record = (a) => {
      const ok = (a.p_result as { reachable: boolean; roundTrip: boolean }).roundTrip;
      streak = ok ? { ...streak, ok: streak.ok + 1, fail: 0 } : { ...streak, fail: streak.fail + 1, ok: 0 };
      return { failStreak: streak.fail, okStreak: streak.ok, autoReadOnly: streak.auto };
    };
    world.rpc.read_only_auto = (a) => {
      readOnly.push({ on: Boolean(a.p_on), reason: String(a.p_reason) });
      const changed = streak.auto !== Boolean(a.p_on);
      streak.auto = Boolean(a.p_on);
      return { changed };
    };
    world.rpc.ai_alert_recipients = (a) => {
      expect(a).toEqual({ p_who: 'owners' });
      return ['owner@zephyr.test'];
    };
    world.rpc.storage_usage = () => [{ storeId: 'studio-nas', objects: 3, bytes: 900_000 }];
  });

  it('a check does a signed round trip under _health/ and leaves nothing behind', async () => {
    const check = await checkStore(storageEnv(), 'b2-eu', false);
    expect(check).toMatchObject({ reachable: true, roundTrip: true, uploadMBps: null, error: null });
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    const puts = mocks.b2.seen.filter((s) => s.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(must(puts[0]).url.pathname).toMatch(/^\/zephyr\/_health\/[0-9a-f]{32}$/);
    expect(mocks.b2.objects.size).toBe(0);
  });

  it('the full check adds a 4 MB upload and free space from the declared capacity', async () => {
    const check = await checkStore(storageEnv(), 'studio-nas', true);
    expect(check.roundTrip).toBe(true);
    expect(check.uploadMBps).toBeGreaterThan(0);
    expect(mocks.vpc.seen.some((s) => s.method === 'PUT' && s.body.length === 4 * 1024 * 1024)).toBe(true);
    expect(check).toMatchObject({ capacityBytes: 1_000_000, freeBytes: 100_000 });
    expect(mocks.vpc.objects.size).toBe(0);
  });

  it('three failures turn read-only on and email the Owners; two successes turn it off', async () => {
    const e = storageEnv();
    mocks.b2.next = null;
    const failing = () => {
      // Reachable (list works) but writes are refused.
      mocks.b2.fetcher = (async (req: Request) =>
        req.method === 'PUT'
          ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
          : new MockS3().fetcher(req)) as Fetcher;
    };
    const healthy = new MockS3();
    failing();
    for (let i = 0; i < 2; i++) expect(await runHealthCron(e)).toEqual({ store: 'b2-eu', ok: false });
    expect(readOnly).toEqual([]);
    await runHealthCron(e);
    expect(readOnly).toEqual([{ on: true, reason: 'storage_unreachable' }]);
    expect(world.emails).toHaveLength(1);
    expect(world.emails[0]?.subject).toContain('Read-only mode is on');
    expect(world.emails[0]?.text).toContain('AccessDenied');
    expect(world.emails[0]?.text).not.toContain('s3.example.test');
    await runHealthCron(e); // a fourth failure: already on, nothing more
    expect(readOnly).toHaveLength(1);

    mocks.b2.fetcher = healthy.fetcher;
    await runHealthCron(e);
    expect(readOnly).toHaveLength(1);
    await runHealthCron(e);
    expect(readOnly.at(-1)).toEqual({ on: false, reason: 'storage_recovered' });
    expect(world.emails.at(-1)?.subject).toContain('Read-only mode is off');
    await runHealthCron(e);
    expect(readOnly).toHaveLength(2);
  });

  it('a manual read-only is never turned off by the health check', async () => {
    // The database answers changed: false (it only turns off what it turned on itself).
    world.rpc.read_only_auto = (a) => {
      readOnly.push({ on: Boolean(a.p_on), reason: String(a.p_reason) });
      return { changed: false };
    };
    streak.auto = true;
    const check = await checkStore(storageEnv(), 'b2-eu', false);
    await recordCheck(storageEnv(), 'b2-eu', check, true);
    expect((await recordCheck(storageEnv(), 'b2-eu', check, true)).readOnly).toBeNull();
    expect(world.emails).toHaveLength(0);
  });

  it('checks of a store that is not the write store never change read-only mode', async () => {
    const bad = {
      at: '',
      reachable: false,
      latencyMs: null,
      roundTrip: false,
      uploadMBps: null,
      freeBytes: null,
      capacityBytes: null,
      error: 'unreachable',
    };
    for (let i = 0; i < 5; i++) await recordCheck(storageEnv(), 'studio-nas', bad, false);
    expect(readOnly).toEqual([]);
  });
});

// ================================================================ admin storage routes
async function staffSession(
  email: string,
  o: { authAgo?: number } = {},
): Promise<{ j: Jar; access: string }> {
  const u = must(world.users.find((x) => x.email === email));
  const access = await accessToken(email);
  world.passkeyUser = u;
  const j = jar();
  const res = await call('/admin/api/v1/auth/passkey/verify', {
    body: { challengeId: 'ch-auth', credential: credential('webauthn.get', LANDING) },
    jar: j,
    access,
  });
  expect(res.status).toBe(200);
  if (o.authAgo) {
    j.cookies.set(
      '__Host-za-at',
      await sbToken({ sub: u.id, email: u.email, amr: ['passkey'], authAgo: o.authAgo }),
    );
  }
  return { j, access };
}

describe('admin storage routes', () => {
  const recentCheck = () => ({
    at: new Date().toISOString(),
    reachable: true,
    latencyMs: 40,
    roundTrip: true,
    uploadMBps: 20,
    freeBytes: null,
    capacityBytes: null,
    error: null,
  });
  let checks: { storeId: string; result: unknown }[];
  beforeEach(() => {
    mocks.b2 = new MockS3();
    routeS3();
    // The app reads the shared test env: give it the stores and secrets for this block.
    Object.assign(env, storageEnv());
    checks = [{ storeId: 'b2-eu', result: recentCheck() }];
    world.rpc.admin_storage = () => ({
      writeStore: 'r2',
      migration: null,
      usage: [
        { storeId: 'r2', objects: 10, bytes: 1000 },
        { storeId: 'old-store', objects: 1, bytes: 5 },
      ],
      checks,
      autoReadOnly: false,
    });
    world.rpc.storage_status = () => ({ writeStore: 'r2', migration: null });
    world.rpc.storage_check_record = () => ({ failStreak: 0, okStreak: 1, autoReadOnly: false });
    world.rpc.storage_usage = () => [];
    world.rpc.ai_alert_recipients = () => ['owner@zephyr.test'];
    world.rpc.storage_switch = (a) => {
      expect(a).toMatchObject({ p_to: 'b2-eu', p_reason: 'Cheaper storage' });
      return { migrationId: MIGRATION, from: 'r2', to: 'b2-eu' };
    };
    world.rpc.storage_migration_action = () => ({ migrationId: MIGRATION, from: 'r2', to: 'b2-eu' });
  });
  afterEach(() => {
    for (const k of Object.keys(storageEnv()))
      if (!(k in envBefore)) delete (env as unknown as Record<string, unknown>)[k];
    Object.assign(env, envBefore);
  });
  const envBefore = { ...env };

  it('shows stores to Owner and Admin only, with no endpoints, buckets or keys', async () => {
    const { j, access } = await staffSession('admin@zephyr.test');
    const res = await call(ADMIN8_API.storage, { method: 'GET', jar: j, access });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.stores.map((s: { id: string }) => s.id)).toEqual([
      'r2',
      'b2-eu',
      'studio-nas',
      'tunnel-nas',
      'old-store',
    ]);
    expect(body.stores[0]).toMatchObject({ current: true, objects: 10, health: 'unknown' });
    expect(body.stores[1]).toMatchObject({ health: 'healthy', costPerTbMonthUsd: 6 });
    expect(body.stores[4]).toMatchObject({ health: 'unreachable', lastCheck: { error: 'unknown_store' } });
    expect(body.totals).toEqual({ photos: 11, bytes: 1005 });
    const text = JSON.stringify(body);
    for (const secret of ['s3.example.test', 'garage.internal', 'VPC_GARAGE', 'AK-B2', 'SK-B2', 'zephyr"']) {
      expect(text).not.toContain(secret);
    }
    const support = await staffSession('support@zephyr.test');
    const denied = await call(ADMIN8_API.storage, { method: 'GET', jar: support.j, access: support.access });
    expect(denied.status).toBe(403);
  });

  it('runs a full check on demand and records it', async () => {
    const { j, access } = await staffSession('owner@zephyr.test');
    const res = await call(ADMIN8_API.storageCheck('b2-eu'), { body: {}, jar: j, access });
    expect(res.status).toBe(200);
    const recorded = must(rpcCalls('storage_check_record')[0]).body as {
      p_store: string;
      p_result: { roundTrip: boolean; uploadMBps: number };
    };
    expect(recorded.p_store).toBe('b2-eu');
    expect(recorded.p_result.roundTrip).toBe(true);
    expect(recorded.p_result.uploadMBps).toBeGreaterThan(0);
    const unknown = await call(ADMIN8_API.storageCheck('nope'), { body: {}, jar: j, access });
    expect(unknown.status).toBe(404);
  });

  it('the switch needs a recent passkey, a passing check and encryption at rest, then emails every Owner', async () => {
    const stale = await staffSession('owner@zephyr.test', { authAgo: 3600 });
    const body = { to: 'b2-eu', reason: 'Cheaper storage' };
    const r1 = await call(ADMIN8_API.storageSwitch, { body, jar: stale.j, access: stale.access });
    expect(r1.status).toBe(403);
    expect(await read(r1)).toMatchObject({ error: 'reauth_required' });
    expect(rpcCalls('storage_switch')).toHaveLength(0);

    const { j, access } = await staffSession('owner@zephyr.test');
    // Declared without encryption at rest: refused.
    const r2 = await call(ADMIN8_API.storageSwitch, {
      body: { to: 'tunnel-nas', reason: 'Try it' },
      jar: j,
      access,
    });
    expect(r2.status).toBe(400);
    // No recent passing check: refused.
    checks = [];
    const r3 = await call(ADMIN8_API.storageSwitch, { body, jar: j, access });
    expect(r3.status).toBe(409);
    checks = [{ storeId: 'b2-eu', result: recentCheck() }];
    const ok = await call(ADMIN8_API.storageSwitch, { body, jar: j, access });
    expect(ok.status).toBe(200);
    expect(rpcCalls('storage_switch')).toHaveLength(1);
    expect(storageQueue.sent).toEqual([{ t: 'migrate', migration: MIGRATION }]);
    await vi.waitFor(() => expect(world.emails).toHaveLength(1));
    expect(world.emails[0]?.subject).toContain('r2 → b2-eu');
    expect(world.emails[0]?.text).not.toContain('s3.example.test');

    const support = await staffSession('support@zephyr.test');
    const denied = await call(ADMIN8_API.storageSwitch, { body, jar: support.j, access: support.access });
    expect(denied.status).toBe(403);
  });

  it('pause saves at once; rollback needs a recent passkey and emails the Owners', async () => {
    const stale = await staffSession('admin@zephyr.test', { authAgo: 3600 });
    const pause = await call(ADMIN8_API.storageMigration, {
      body: { action: 'pause', reason: 'Studio uplink busy' },
      jar: stale.j,
      access: stale.access,
    });
    expect(pause.status).toBe(200);
    expect(storageQueue.sent).toEqual([]);
    const rb = await call(ADMIN8_API.storageMigration, {
      body: { action: 'rollback', reason: 'Too slow' },
      jar: stale.j,
      access: stale.access,
    });
    expect(rb.status).toBe(403);
    expect(await read(rb)).toMatchObject({ error: 'reauth_required' });

    const fresh = await staffSession('admin@zephyr.test');
    const ok = await call(ADMIN8_API.storageMigration, {
      body: { action: 'rollback', reason: 'Too slow' },
      jar: fresh.j,
      access: fresh.access,
    });
    expect(ok.status).toBe(200);
    expect(storageQueue.sent).toEqual([{ t: 'migrate', migration: MIGRATION }]);
    await vi.waitFor(() => expect(world.emails.some((m) => m.subject.includes('rolled back'))).toBe(true));
    world.rpc.storage_migration_action = () => ({ error: 'conflict' });
    const none = await call(ADMIN8_API.storageMigration, {
      body: { action: 'resume', reason: 'Go on' },
      jar: fresh.j,
      access: fresh.access,
    });
    expect(none.status).toBe(409);
  });

  it('abandoning old copies: Owner only, with a passkey, only on a store that fails a check now or is gone, and emails the Owners', async () => {
    world.rpc.storage_abandon_old_copies = (a) =>
      a.p_store === 'old-store' || a.p_store === 'b2-eu'
        ? { store: a.p_store, copies: 3, migrations: 1 }
        : { error: 'not_found' };
    const body = { store: 'old-store', reason: 'The old NAS died' };
    const admin = await staffSession('admin@zephyr.test');
    const denied = await call(ADMIN8_API.storageAbandon, { body, jar: admin.j, access: admin.access });
    expect(denied.status).toBe(403);
    const stale = await staffSession('owner@zephyr.test', { authAgo: 3600 });
    const reauth = await call(ADMIN8_API.storageAbandon, { body, jar: stale.j, access: stale.access });
    expect(await read(reauth)).toMatchObject({ error: 'reauth_required' });
    expect(rpcCalls('storage_abandon_old_copies')).toHaveLength(0);

    const { j, access } = await staffSession('owner@zephyr.test');
    // A configured store whose last recorded check failed but which answers now: a fresh check runs (and is
    // recorded), passes, and nothing is abandoned: the cron deletes its old copies itself.
    checks = [
      {
        storeId: 'b2-eu',
        result: { ...recentCheck(), reachable: false, roundTrip: false, error: 'timeout' },
      },
    ];
    const recovered = await call(ADMIN8_API.storageAbandon, {
      body: { store: 'b2-eu', reason: 'It was down last week' },
      jar: j,
      access,
    });
    expect(recovered.status).toBe(409);
    expect(rpcCalls('storage_check_record').map((c) => (c.body as { p_store: string }).p_store)).toEqual([
      'b2-eu',
    ]);
    expect(rpcCalls('storage_abandon_old_copies')).toHaveLength(0);

    // A store the deployment no longer declares (the config parses cleanly).
    const ok = await call(ADMIN8_API.storageAbandon, { body, jar: j, access });
    expect(ok.status).toBe(200);
    expect(rpcCalls('storage_abandon_old_copies')[0]?.body).toEqual({
      p_staff: '10000000-0000-0000-0000-000000000001',
      p_store: 'old-store',
      p_reason: 'The old NAS died',
      p_ack: false,
    });
    await vi.waitFor(() =>
      expect(world.emails.some((m) => m.subject.includes('abandoned on old-store'))).toBe(true),
    );
    expect(world.emails.find((m) => m.subject.includes('abandoned on old-store'))?.text).toContain(
      "Don't delete them by hand",
    );

    // A configured store that fails the check run now; the acknowledgement is passed on.
    mocks.b2.down = true;
    const failing = await call(ADMIN8_API.storageAbandon, {
      body: { store: 'b2-eu', reason: 'Unreachable for days', acknowledgeRollbackEnds: true },
      jar: j,
      access,
    });
    expect(failing.status).toBe(200);
    expect(rpcCalls('storage_abandon_old_copies').at(-1)?.body).toMatchObject({
      p_store: 'b2-eu',
      p_ack: true,
    });
    world.rpc.storage_abandon_old_copies = () => ({ error: 'rollback_ends' });
    const ends = await call(ADMIN8_API.storageAbandon, {
      body: { store: 'b2-eu', reason: 'Unreachable for days' },
      jar: j,
      access,
    });
    expect(ends.status).toBe(409);
    world.rpc.storage_abandon_old_copies = () => ({ error: 'not_found' });
    const none = await call(ADMIN8_API.storageAbandon, { body, jar: j, access });
    expect(none.status).toBe(404);
  });

  it("refuses to abandon anything while the stores config doesn't parse (every store would look undeclared)", async () => {
    Object.assign(env, { STORAGE_STORES: '{not json' });
    world.rpc.storage_abandon_old_copies = () => ({ store: 'old-store', copies: 1, migrations: 1 });
    const { j, access } = await staffSession('owner@zephyr.test');
    const res = await call(ADMIN8_API.storageAbandon, {
      body: { store: 'old-store', reason: 'Config broke' },
      jar: j,
      access,
    });
    expect(res.status).toBe(409);
    expect(rpcCalls('storage_abandon_old_copies')).toHaveLength(0);
  });

  it('giving up a failed rollback: Owner only, with a passkey; re-checks the new write store and emails the Owners', async () => {
    world.rpc.storage_rollback_give_up = () => ({
      migrationId: MIGRATION,
      from: 'r2',
      to: 'b2-eu',
      photos: 4,
    });
    world.rpc.storage_check_record = () => ({ failStreak: 0, okStreak: 1, autoReadOnly: true });
    const readOnly: Record<string, unknown>[] = [];
    world.rpc.read_only_auto = (a) => {
      readOnly.push(a);
      return { changed: true };
    };
    const body = { reason: 'The NAS is gone for good' };
    const admin = await staffSession('admin@zephyr.test');
    expect((await call(ADMIN8_API.storageGiveUp, { body, jar: admin.j, access: admin.access })).status).toBe(
      403,
    );
    const stale = await staffSession('owner@zephyr.test', { authAgo: 3600 });
    const reauth = await call(ADMIN8_API.storageGiveUp, { body, jar: stale.j, access: stale.access });
    expect(await read(reauth)).toMatchObject({ error: 'reauth_required' });
    expect(rpcCalls('storage_rollback_give_up')).toHaveLength(0);

    const { j, access } = await staffSession('owner@zephyr.test');
    const bad = await call(ADMIN8_API.storageGiveUp, { body: { reason: 'x' }, jar: j, access });
    expect(bad.status).toBe(400);
    const ok = await call(ADMIN8_API.storageGiveUp, { body, jar: j, access });
    expect(ok.status).toBe(200);
    expect(rpcCalls('storage_rollback_give_up')[0]?.body).toEqual({
      p_staff: '10000000-0000-0000-0000-000000000001',
      p_reason: 'The NAS is gone for good',
    });
    // The new write store answered: automatic read-only (for the store that stopped answering) goes off now.
    expect(rpcCalls('storage_check_record').map((c) => (c.body as { p_store: string }).p_store)).toEqual([
      'b2-eu',
    ]);
    expect(readOnly).toEqual([{ p_on: false, p_reason: 'storage_recovered' }]);
    await vi.waitFor(() =>
      expect(world.emails.some((m) => m.subject.includes('Rollback given up'))).toBe(true),
    );

    // A new write store that doesn't answer leaves read-only as it is.
    readOnly.length = 0;
    mocks.b2.down = true;
    expect((await call(ADMIN8_API.storageGiveUp, { body, jar: j, access })).status).toBe(200);
    expect(readOnly).toEqual([]);
    world.rpc.storage_rollback_give_up = () => ({ error: 'conflict' });
    expect((await call(ADMIN8_API.storageGiveUp, { body, jar: j, access })).status).toBe(409);
  });

  it('the overview passes on the old copies waiting per store and the follow-up counts', async () => {
    const base = world.rpc.admin_storage as () => Record<string, unknown>;
    world.rpc.admin_storage = () => ({
      ...base(),
      oldCopies: [{ storeId: 'old-store', copies: 4 }],
      followups: { pending: 2, dropped30d: 1 },
    });
    const { j, access } = await staffSession('admin@zephyr.test');
    const res = await call(ADMIN8_API.storage, { method: 'GET', jar: j, access });
    expect(await read(res)).toMatchObject({
      oldCopies: [{ storeId: 'old-store', copies: 4 }],
      followups: { pending: 2, dropped30d: 1 },
    });
  });
});

// ================================================================ the seam holds
describe('every photo-library byte goes through the storage seam', () => {
  it('no env.PHOTOS outside src/storage/', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url).href);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (relative(root, p) !== 'storage') walk(p);
        } else if (/\.ts$/.test(name)) {
          const src = readFileSync(p, 'utf8');
          // env.PHOTOS, c.env.PHOTOS, env['PHOTOS'], destructuring { PHOTOS } from an env.
          if (
            /\.PHOTOS\b|\[\s*['"`]PHOTOS['"`]\s*\]|\{\s*[^}]*\bPHOTOS\b[^}]*\}\s*=\s*(c\.)?env\b/.test(src)
          ) {
            offenders.push(relative(root, p));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
