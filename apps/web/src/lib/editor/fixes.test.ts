import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { putEditVariant, saveEdit } from '../edits';
import { EXPECTED_USER_HEADER } from '../library';
import { endSession, setSessionUserId } from '../sessionGuard';
import type { UploadDeps } from '../uploads/manager';
import { UploadManager } from '../uploads/manager';
import '.';
import { runningExports, startExportJob } from './exportJob';
import { cleanExportName, exportName, ZIP_FULL_SIZE_LIMIT, ZIP_MEMORY_LIMIT, zipTooBig } from './names';
import { renderVariantsFrom } from './queue';
import { fullDecodeFits } from './rawCommon';
import { EditSession } from './session';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => setSessionUserId('u1'));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSessionUserId(null);
});

// ------------------------------------------------------------ exports belong to their member
describe('export jobs', () => {
  it('capture the member who started them and stop when that session ends', async () => {
    const job = startExportJob();
    expect(job.owner).toBe('u1');
    expect(runningExports()).toBe(1);
    await endSession('unauthenticated', false);
    expect(job.signal.aborted).toBe(true);
    expect(() => job.check()).toThrow(/stopped/);
    job.finish();
    expect(runningExports()).toBe(0);
  });

  it('refuse to continue once someone else is signed in, even without a session-end event', () => {
    const job = startExportJob();
    setSessionUserId('u2');
    expect(() => job.check()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    job.finish();
  });

  it('cannot start while signed out', () => {
    setSessionUserId(null);
    expect(() => startExportJob()).toThrow();
  });
});

function uploadDeps(owner: () => string | null): UploadDeps & { created: number } {
  const d = {
    created: 0,
    owner,
    rules: async () => ({ fileTypes: ['jpeg' as const], maxFileBytes: 50_000_000, batchSize: 25 }),
    hash: async () => 'h',
    prepare: async () => ({ metadata: {} }),
    create: async () => {
      d.created += 1;
      return [];
    },
    putVariant: async () => {},
    putPart: async () => {},
    complete: async () => {
      throw new Error('unused');
    },
    status: async () => {
      throw new Error('unused');
    },
    abort: async () => {},
  };
  return d;
}

describe('upload queue owner check', () => {
  const file = () => new File(['x'], 'a-edited.jpg', { type: 'image/jpeg' });
  it('queues nothing when the expected member is no longer the one signed in', async () => {
    const d = uploadDeps(() => 'u2');
    const m = new UploadManager(d);
    expect(await m.add([file()], { expectedOwner: 'u1' })).toBe('owner_changed');
    expect(m.getSnapshot().items).toHaveLength(0);
    expect(d.created).toBe(0);
  });
  it('queues nothing while signed out', async () => {
    const m = new UploadManager(uploadDeps(() => null));
    expect(await m.add([file()], { expectedOwner: 'u1' })).toBe('signed_out');
    expect(m.getSnapshot().items).toHaveLength(0);
  });
  it('queues for the same member', async () => {
    const m = new UploadManager(uploadDeps(() => 'u1'));
    expect(await m.add([file()], { expectedOwner: 'u1' })).toBe('queued');
    expect(m.getSnapshot().items).toHaveLength(1);
    m.reset({ server: false });
  });
});

// ------------------------------------------------------------ requests name the member the work began for
describe('owner-pinned requests', () => {
  it('an edit save names the member who opened the photo, not whoever is signed in now', async () => {
    let header: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        header = new Headers(init?.headers).get(EXPECTED_USER_HEADER);
        return json(200, {
          ok: true,
          edit: { photoId: 'p', recipe: { v: 1 }, version: 2, rendered: false, updatedAt: '' },
        });
      }),
    );
    setSessionUserId('u2');
    await saveEdit('p', { v: 1, light: { exposure: 1 } }, 1, 'u1');
    expect(header).toBe('u1');
  });

  it('a variant upload names the queued member', async () => {
    const sent: Record<string, string> = {};
    class FakeXHR {
      status = 200;
      responseText = '{}';
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader(k: string, v: string) {
        sent[k] = v;
      }
      getResponseHeader() {
        return null;
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    setSessionUserId('u2');
    await putEditVariant('p', 'thumb', 3, new Blob(['x'], { type: 'image/webp' }), undefined, 'u1');
    expect(sent[EXPECTED_USER_HEADER]).toBe('u1');
  });
});

describe('open edit sessions at session end', () => {
  it('a switch closes them: the pending autosave never goes out', async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const s = new EditSession('p1', null, { save, remove: vi.fn() }, 'u1');
    s.commit({ v: 1, light: { exposure: 1 } });
    await endSession('switched', false);
    expect(s.isClosed).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('a save in flight is aborted, and no error is shown', async () => {
    let signal: AbortSignal | null = null;
    const save = vi.fn(
      (_id: string, _r: unknown, _b: unknown, sig: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal = sig;
          sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const s = new EditSession('p1', null, { save, remove: vi.fn() }, 'u1');
    s.commit({ v: 1, light: { exposure: 1 } });
    const flushing = s.flush();
    await endSession('unauthenticated', false);
    await flushing;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(s.getSnapshot().status).not.toBe('error');
  });

  it('a deliberate sign-out saves unsaved edits first, then closes', async () => {
    const save = vi.fn(async () => ({
      photoId: 'p1',
      recipe: { v: 1 as const },
      version: 1,
      rendered: false,
      updatedAt: '',
    }));
    const s = new EditSession('p1', null, { save, remove: vi.fn(), debounceMs: 60_000 }, 'u1');
    s.commit({ v: 1, light: { exposure: 1 } });
    await endSession('sign-out', true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.isClosed).toBe(true);
  });
});

// ------------------------------------------------------------ export names and zip limits
describe('export file names', () => {
  it('strips path separators, control and invisible bidi characters', () => {
    expect(cleanExportName('../../etc/passwd', 'a.jpg')).toBe('_.._etc_passwd.jpg');
    expect(cleanExportName('photo‮gpj.exe', 'a.jpg')).toBe('photo_gpj.exe.jpg');
    expect(cleanExportName('a\u0000b\u0007c.JPG', 'x.cr2')).toBe('a_b_c.jpg');
    expect(cleanExportName('  holiday ​.jpeg ', 'x.cr2')).toBe('holiday _.jpeg');
    expect(cleanExportName('my edit', 'x.cr2')).toBe('my edit.jpg');
  });
  it('falls back to the photo’s own name and caps the length', () => {
    expect(cleanExportName('   ', 'IMG_1.CR2')).toBe('IMG_1-edited.jpg');
    expect(cleanExportName('...', 'IMG_1.CR2')).toBe('IMG_1-edited.jpg');
    expect(cleanExportName(`${'a'.repeat(300)}.jpg`, 'x').length).toBe(124);
    expect(exportName('IMG‮1.CR2')).toBe('IMG_1-edited.jpg');
  });
  it('guards Windows device names, invisible characters and split emoji', () => {
    expect(cleanExportName('CON', 'x')).toBe('_CON.jpg');
    expect(cleanExportName('nul.jpg', 'x')).toBe('_nul.jpg');
    expect(cleanExportName('COM1.jpeg', 'x')).toBe('_COM1.jpeg');
    expect(cleanExportName('conin$', 'x')).toBe('_conin$.jpg');
    expect(cleanExportName('console', 'x')).toBe('console.jpg');
    expect(cleanExportName('a\u00adb\u2060c\u2028d\u3164e\u{E0041}f', 'x')).toBe('abcdef.jpg');
    expect(cleanExportName('lone\ud800half', 'x')).toBe('lonehalf.jpg');
    const cut = cleanExportName(`x${'😀'.repeat(200)}`, 'y');
    expect([...cut.replace(/\.jpg$/, '')]).toHaveLength(120);
    expect(cut.isWellFormed?.() ?? !/[\ud800-\udfff](?![\udc00-\udfff])/.test(cut)).toBe(true);
    expect(exportName('exe      .CR2')).toBe('exe-edited.jpg');
    expect(cleanExportName('my    edit', 'x')).toBe('my edit.jpg');
  });
  it('caps an in-memory zip by estimated size and by count at full size', () => {
    expect(zipTooBig(ZIP_MEMORY_LIMIT + 1, 10, false)).toMatch(/too much/);
    expect(zipTooBig(10_000_000, ZIP_FULL_SIZE_LIMIT + 1, true)).toMatch(/Long edge 2048/);
    expect(zipTooBig(10_000_000, ZIP_FULL_SIZE_LIMIT + 1, false)).toBeNull();
    expect(zipTooBig(10_000_000, 10, true)).toBeNull();
  });
});

describe('edited variants from the editor’s source', () => {
  it('reads both variants’ pixels before returning, so a photo switch can’t mix sources', () => {
    const renderPixels = vi.fn(() => new Uint8Array(4));
    const gl = {
      sourceSize: { width: 4000, height: 3000 },
      renderPixels,
    } as unknown as import('./gl').Renderer;
    const p = renderVariantsFrom(gl, { v: 1 }, 0);
    // Synchronously, before anything awaits:
    expect(renderPixels).toHaveBeenCalledTimes(2);
    expect(renderPixels.mock.calls.map((c) => (c as unknown as [{ width: number }])[0].width)).toEqual([
      2048, 512,
    ]);
    p.catch(() => undefined); // encoding needs a real canvas
  });
});

describe('RAW memory budget', () => {
  it('refuses full-size decodes that would need more than the WebAssembly memory allows', () => {
    expect(fullDecodeFits(6000, 4000, 30_000_000)).toBe(true); // 24 MP
    expect(fullDecodeFits(11_648, 8_736, 100_000_000)).toBe(false); // 100 MP
  });
});
