import type { PhotoItem, UploadDecision, UploadFileSpec, UploadStatus } from '@zephyr/shared/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../api';
import { EXIF_OPTIONS, EXIF_PICK, exifDateToIso, toMetadata } from './exif';
import { CONCURRENCY, fileTypeOf, type UploadDeps, UploadManager } from './manager';
import { bytesDone, partCount, partRange, partsToSend } from './parts';
import { jpegEnd, largestEmbeddedJpeg } from './raw';

const MiB = 1024 * 1024;

describe('part slicing', () => {
  it('counts parts, with at least one', () => {
    expect(partCount(0, 16 * MiB)).toBe(1);
    expect(partCount(1, 16 * MiB)).toBe(1);
    expect(partCount(16 * MiB, 16 * MiB)).toBe(1);
    expect(partCount(16 * MiB + 1, 16 * MiB)).toBe(2);
    expect(partCount(48 * MiB, 16 * MiB)).toBe(3);
  });
  it('slices [start, end) ranges with a short last part', () => {
    const size = 40 * MiB;
    expect(partRange(size, 16 * MiB, 1)).toEqual({ start: 0, end: 16 * MiB });
    expect(partRange(size, 16 * MiB, 2)).toEqual({ start: 16 * MiB, end: 32 * MiB });
    expect(partRange(size, 16 * MiB, 3)).toEqual({ start: 32 * MiB, end: 40 * MiB });
    // The parts cover the file exactly once.
    let total = 0;
    for (let n = 1; n <= partCount(size, 16 * MiB); n++) {
      const r = partRange(size, 16 * MiB, n);
      total += r.end - r.start;
    }
    expect(total).toBe(size);
  });
  it('rejects parts outside the file', () => {
    expect(() => partRange(10, 4, 0)).toThrow(RangeError);
    expect(() => partRange(10, 4, 4)).toThrow(RangeError);
    expect(() => partRange(10, 4, 1.5)).toThrow(RangeError);
  });
  it('works out what is left to send and what is done', () => {
    expect(partsToSend(4, [1, 3])).toEqual([2, 4]);
    expect(partsToSend(2, [1, 2])).toEqual([]);
    expect(bytesDone(40, 16, [1, 3])).toBe(16 + 8);
    expect(bytesDone(40, 16, [9])).toBe(0);
  });
});

/** A minimal but structurally valid JPEG of about `size` bytes: SOI, APP0, SOS + entropy data, EOI. */
function jpeg(size: number, opts: { nestedThumb?: boolean } = {}): number[] {
  const out = [0xff, 0xd8];
  if (opts.nestedThumb) {
    // APP1 carrying its own tiny JPEG (like an EXIF thumbnail) whose EOI must not end the outer image.
    const inner = [0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
    const len = inner.length + 2;
    out.push(0xff, 0xe1, len >> 8, len & 0xff, ...inner);
  }
  out.push(0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46);
  out.push(0xff, 0xda, 0x00, 0x02);
  const body = Math.max(0, size - out.length - 2);
  for (let i = 0; i < body; i++) {
    // Entropy-coded data with stuffed bytes (FF 00) and a restart marker now and then.
    if (i % 997 === 0) out.push(0xff, 0x00);
    else if (i % 4001 === 0) out.push(0xff, 0xd3);
    else out.push((i * 31) & 0x7f);
  }
  out.push(0xff, 0xd9);
  return out;
}

describe('RAW embedded preview', () => {
  it('finds the largest complete JPEG in a TIFF-like buffer', () => {
    const tiffHeader = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x43, 0x52];
    const small = jpeg(3_000);
    const big = jpeg(60_000, { nestedThumb: true });
    const junk = Array.from({ length: 500 }, (_, i) => (i * 7) & 0xff);
    const bytes = new Uint8Array([...tiffHeader, ...small, ...junk, ...big, ...junk]);
    const r = largestEmbeddedJpeg(bytes);
    const bigStart = tiffHeader.length + small.length + junk.length;
    expect(r).toEqual({ start: bigStart, end: bigStart + big.length });
  });
  it('skips EOI bytes inside an embedded thumbnail segment', () => {
    const j = new Uint8Array(jpeg(5_000, { nestedThumb: true }));
    expect(jpegEnd(j, 0)).toBe(j.length);
  });
  it('ignores truncated JPEGs and returns null when there is none', () => {
    const cut = new Uint8Array(jpeg(5_000).slice(0, 4_000));
    expect(jpegEnd(cut, 0)).toBe(-1);
    expect(largestEmbeddedJpeg(cut)).toBeNull();
    expect(largestEmbeddedJpeg(new Uint8Array([1, 2, 3, 0xff, 0xd8]))).toBeNull();
  });
});

describe('EXIF', () => {
  it('never reads location: the GPS block is off and no GPS tag is picked', () => {
    expect(EXIF_OPTIONS.gps).toBe(false);
    expect(EXIF_OPTIONS.pick.some((t) => /gps|latitude|longitude|altitude/i.test(t))).toBe(false);
    expect(EXIF_PICK.some((t) => /gps/i.test(t))).toBe(false);
    // Other blocks that can carry location are off too.
    expect(EXIF_OPTIONS.xmp).toBe(false);
    expect(EXIF_OPTIONS.iptc).toBe(false);
  });
  it('turns EXIF dates into ISO 8601 with the camera offset', () => {
    expect(exifDateToIso('2026:10:24 15:42:10', '+08:00')).toBe('2026-10-24T15:42:10+08:00');
    expect(exifDateToIso('2026:10:24 15:42:10')).toMatch(/^2026-10-24T15:42:10[+-]\d{2}:\d{2}$/);
    expect(exifDateToIso('0000:00:00 00:00:00')).toBeUndefined();
    expect(exifDateToIso('garbage')).toBeUndefined();
  });
  it('maps and sanitises tags, and drops GPS even if present', () => {
    const md = toMetadata({
      Make: 'Canon',
      Model: 'Canon EOS R6m2\u0000',
      LensModel: 'RF50mm F1.2 L USM',
      DateTimeOriginal: '2026:10:24 15:42:10',
      OffsetTimeOriginal: '+08:00',
      FNumber: 1.8,
      ExposureTime: 0.002,
      ISO: 200,
      FocalLength: 50,
      Orientation: 6,
      ExifImageWidth: 6000,
      ExifImageHeight: 4000,
      GPSLatitude: [1, 17, 0],
      latitude: 1.28,
    });
    expect(md).toEqual({
      cameraMake: 'Canon',
      cameraModel: 'Canon EOS R6m2',
      lens: 'RF50mm F1.2 L USM',
      takenAt: '2026-10-24T15:42:10+08:00',
      aperture: 1.8,
      exposureSeconds: 0.002,
      iso: 200,
      focalLengthMm: 50,
      orientation: 6,
      width: 6000,
      height: 4000,
    });
    expect(JSON.stringify(md)).not.toMatch(/lat|gps/i);
  });
});

// ---------------------------------------------------------------- upload manager
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 20) {
  for (let i = 0; i < n; i++) await tick();
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { lastModified: 1 });
const photo = (id: string): PhotoItem => ({
  id,
  filename: `${id}.jpg`,
  fileType: 'jpeg',
  sizeBytes: 10,
  width: 10,
  height: 10,
  takenAt: null,
  createdAt: '2026-10-28T00:00:00Z',
  favourite: false,
  hasThumb: true,
  hasPreview: true,
});

function makeDeps(over: Partial<UploadDeps> = {}) {
  let n = 0;
  const calls = {
    create: [] as UploadFileSpec[][],
    parts: [] as { id: string; n: number; size: number }[],
    variants: [] as string[],
    complete: [] as string[],
    abort: [] as string[],
    status: [] as string[],
  };
  const deps: UploadDeps = {
    rules: async () => ({ fileTypes: ['jpeg', 'png', 'webp'], maxFileBytes: 50_000_000, batchSize: 2 }),
    hash: async (f) => `hash-${f.name}`,
    prepare: async () => ({
      metadata: { width: 10, height: 10 },
      thumb: new Blob(['t'], { type: 'image/webp' }),
    }),
    create: async (files) => {
      calls.create.push(files);
      return files.map((f): UploadDecision => {
        n += 1;
        return {
          status: 'ready',
          uploadId: `up-${f.name}`,
          photoId: `ph-${n}`,
          partSize: 4,
          partCount: Math.max(1, Math.ceil(f.size / 4)),
          fileType: 'jpeg',
        };
      });
    },
    putVariant: async (id, kind) => {
      calls.variants.push(`${id}:${kind}`);
    },
    putPart: async (id, part, blob) => {
      calls.parts.push({ id, n: part, size: blob.size });
    },
    complete: async (id) => {
      calls.complete.push(id);
      return { photo: photo(id.replace('up-', 'ph-')) };
    },
    status: async (id): Promise<UploadStatus> => {
      calls.status.push(id);
      return { ok: true, uploadId: id, partsDone: [], variantsDone: [], expiresAt: '2026-10-29T00:00:00Z' };
    },
    abort: async (id) => {
      calls.abort.push(id);
    },
    ...over,
  };
  return { deps, calls };
}

describe('upload manager', () => {
  it('asks the server in batches no bigger than the plan allows and uploads every part in order', async () => {
    const { deps, calls } = makeDeps();
    const onPhoto = vi.fn();
    const onSettled = vi.fn();
    const m = new UploadManager({ ...deps, onPhoto, onSettled });
    await m.add(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].map((nm) => file(nm, 10)));
    await settle(60);
    expect(calls.create.length).toBeGreaterThanOrEqual(3);
    expect(calls.create.every((b) => b.length <= 2)).toBe(true);
    expect(
      calls.create
        .flat()
        .map((f) => f.name)
        .sort(),
    ).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
    expect(calls.create[0]?.[0]).toMatchObject({ name: 'a.jpg', size: 10, sha256: 'hash-a.jpg' });
    // 10 bytes in 4-byte parts: 4 + 4 + 2, sent in order.
    const aParts = calls.parts.filter((p) => p.id === 'up-a.jpg');
    expect(aParts.map((p) => [p.n, p.size])).toEqual([
      [1, 4],
      [2, 4],
      [3, 2],
    ]);
    expect(calls.complete).toHaveLength(5);
    expect(onPhoto).toHaveBeenCalledTimes(5);
    const s = m.getSnapshot();
    expect(s.done).toBe(5);
    expect(s.busy).toBe(false);
    expect(onSettled).toHaveBeenCalled();
  });

  it('runs at most three files at a time', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let running = 0;
    let peak = 0;
    const { deps } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 50 }),
      putPart: async (id) => {
        running++;
        peak = Math.max(peak, running);
        const g = deferred();
        gates.set(id, g);
        await g.promise;
        running--;
      },
    });
    const m = new UploadManager(deps);
    await m.add(Array.from({ length: 7 }, (_, i) => file(`f${i}.jpg`, 3)));
    await settle(40);
    expect(CONCURRENCY).toBe(3);
    expect(running).toBe(3);
    expect(m.getSnapshot().items.filter((i) => i.state === 'uploading')).toHaveLength(3);
    // Finishing files lets the next ones start, never exceeding three.
    for (let round = 0; round < 7; round++) {
      for (const [id, g] of gates) {
        gates.delete(id);
        g.resolve();
        break;
      }
      await settle(20);
    }
    await settle(40);
    expect(peak).toBe(3);
    expect(m.getSnapshot().done).toBe(7);
  });

  it('retries from the parts the server confirmed', async () => {
    let fail = true;
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 10 }),
      putPart: async (id, n, blob) => {
        calls.parts.push({ id, n, size: blob.size });
        if (n === 2 && fail) {
          fail = false;
          throw new ApiFailure('network', 0);
        }
      },
      status: async (id) => {
        calls.status.push(id);
        // The server got parts 1 and 2 (part 2 arrived even though the response was lost).
        return { ok: true, uploadId: id, partsDone: [1, 2], variantsDone: ['thumb'], expiresAt: 'x' };
      },
    });
    const m = new UploadManager(deps);
    await m.add([file('big.jpg', 12)]);
    await settle(30);
    const failed = m.getSnapshot().items[0];
    expect(failed?.state).toBe('failed');
    expect(failed?.message).toBe('Didn’t upload · connection dropped');
    expect(failed?.retryable).toBe(true);
    calls.parts.length = 0;
    calls.variants.length = 0;
    m.retry(failed?.key ?? '');
    await settle(30);
    expect(calls.status).toEqual(['up-big.jpg']);
    expect(calls.parts.map((p) => p.n)).toEqual([3]);
    expect(calls.variants).toEqual([]); // the thumb was already there; no preview was made
    expect(m.getSnapshot().items[0]?.state).toBe('done');
  });

  it('pauses and resumes, checking what the server has before continuing', async () => {
    const gate = deferred();
    let first = true;
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 10 }),
      putPart: async (id, n, blob, signal) => {
        calls.parts.push({ id, n, size: blob.size });
        if (first) {
          first = false;
          await new Promise((_, rej) => {
            signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
            gate.promise.then(() => {});
          });
        }
      },
    });
    const m = new UploadManager(deps);
    await m.add([file('p.jpg', 8)]);
    await settle(20);
    m.pauseAll();
    await settle(10);
    expect(m.getSnapshot().paused).toBe(true);
    expect(m.getSnapshot().items[0]?.state).toBe('paused');
    m.resumeAll();
    await settle(30);
    expect(calls.status).toEqual(['up-p.jpg']);
    expect(m.getSnapshot().items[0]?.state).toBe('done');
  });

  it('cancels a file: aborts the request, tells the server and drops the row', async () => {
    const gate = deferred();
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 10 }),
      putPart: async (_id, _n, _b, signal) =>
        new Promise((res, rej) => {
          signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
          gate.promise.then(res);
        }),
    });
    const m = new UploadManager(deps);
    await m.add([file('c.jpg', 8)]);
    await settle(20);
    const key = m.getSnapshot().items[0]?.key ?? '';
    m.cancel(key);
    await settle(10);
    expect(calls.abort).toEqual(['up-c.jpg']);
    expect(m.getSnapshot().items).toHaveLength(0);
    expect(calls.complete).toEqual([]);
    expect(m.getSnapshot().busy).toBe(false);
  });

  it('marks duplicates and server rejections with plain messages', async () => {
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 10 }),
      create: async (files) => {
        calls.create.push(files);
        const by: Record<string, UploadDecision> = {
          'a.jpg': { status: 'duplicate', photoId: 'ph-old' },
          'b.jpg': { status: 'rejected', reason: 'quota' },
          'c.jpg': { status: 'rejected', reason: 'too_large' },
        };
        return files.map((f) => by[f.name] as UploadDecision);
      },
    });
    const m = new UploadManager(deps);
    await m.add([file('a.jpg', 4), file('b.jpg', 4), file('c.jpg', 4)]);
    await settle(30);
    const [a, b, c] = m.getSnapshot().items;
    expect(a).toMatchObject({ state: 'duplicate', message: 'Already in your library · skipped' });
    expect(b).toMatchObject({ state: 'rejected', message: 'Storage full · free up space or upgrade' });
    expect(c?.state).toBe('rejected');
    expect(c?.message).toMatch(/^Too large/);
    expect(calls.parts).toEqual([]);
    expect(m.getSnapshot().busy).toBe(false);
  });

  it('turns away file types not on the plan and oversized files without asking the server', async () => {
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg', 'png', 'webp'], maxFileBytes: 20, batchSize: 10 }),
    });
    const m = new UploadManager(deps);
    await m.add([file('raw.CR2', 5), file('doc.pdf', 5), file('huge.jpg', 50), file('ok.png', 5)]);
    await settle(30);
    const byName = Object.fromEntries(m.getSnapshot().items.map((i) => [i.name, i]));
    expect(byName['raw.CR2']).toMatchObject({ state: 'rejected', message: 'RAW files need the Pro plan' });
    expect(byName['doc.pdf']).toMatchObject({
      state: 'rejected',
      message: 'Zephyr can’t open this file type',
    });
    expect(byName['huge.jpg']?.state).toBe('rejected');
    expect(byName['ok.png']?.state).toBe('done');
    expect(calls.create.flat().map((f) => f.name)).toEqual(['ok.png']);
  });

  it('asks for a new upload when the old one expired', async () => {
    let expired = true;
    const { deps, calls } = makeDeps({
      rules: async () => ({ fileTypes: ['jpeg'], maxFileBytes: 1e9, batchSize: 10 }),
      putPart: async (id, n, blob) => {
        calls.parts.push({ id, n, size: blob.size });
        if (expired) {
          expired = false;
          throw new ApiFailure('upload_expired', 410);
        }
      },
    });
    const m = new UploadManager(deps);
    await m.add([file('x.jpg', 4)]);
    await settle(30);
    const it0 = m.getSnapshot().items[0];
    expect(it0?.state).toBe('failed');
    m.retry(it0?.key ?? '');
    await settle(30);
    expect(calls.create).toHaveLength(2);
    expect(m.getSnapshot().items[0]?.state).toBe('done');
  });

  it('reports a file that finished first in another upload as already in the library', async () => {
    const onPhoto = vi.fn();
    const { deps } = makeDeps({
      complete: async () => ({ photo: photo('ph-existing'), duplicate: true }),
    });
    const m = new UploadManager({ ...deps, onPhoto });
    await m.add([file('twin.jpg', 4)]);
    await settle(30);
    expect(m.getSnapshot().items[0]).toMatchObject({
      state: 'duplicate',
      message: 'Already in your library · skipped',
    });
    expect(onPhoto).not.toHaveBeenCalled();
  });

  it('recognises file types by extension', () => {
    expect(fileTypeOf('IMG_1.JPEG')).toBe('jpeg');
    expect(fileTypeOf('a.b.nef')).toBe('nef');
    expect(fileTypeOf('noext')).toBeNull();
  });
});
