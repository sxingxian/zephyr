import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRaw, RawTooLargeForFull, stopRawDecoder } from './raw';

/** A stand-in for the RAW worker: records what it was sent and lets the test answer. */
class FakeWorker {
  static all: FakeWorker[] = [];
  posted: { id: number; half: boolean }[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { id: number; half: boolean }) {
    this.posted.push({ id: m.id, half: m.half });
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
const ok = (id: number) => ({ id, ok: true, width: 2, height: 1, data: new Uint16Array(8), baselineEv: 0.5 });
const buf = () => new ArrayBuffer(16);

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  stopRawDecoder();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RAW decoder', () => {
  it('runs one decode at a time; the 60 s limit starts when a decode starts, not while it waits', async () => {
    vi.useFakeTimers();
    const a = decodeRaw(buf(), true);
    const b = decodeRaw(buf(), false);
    const w = FakeWorker.all[0] as FakeWorker;
    expect(w.posted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000); // the first takes 50 s
    w.reply(ok(w.posted[0]?.id as number));
    await expect(a).resolves.toMatchObject({ width: 2 });
    expect(w.posted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(55_000); // 105 s since queued, 55 s since started
    w.reply(ok(w.posted[1]?.id as number));
    await expect(b).resolves.toMatchObject({ baselineEv: 0.5 });
  });

  it('stops a decode that runs over 60 s, and starts a fresh worker for the next one', async () => {
    vi.useFakeTimers();
    const a = decodeRaw(buf(), true);
    const late = expect(a).rejects.toThrow(/too long/);
    await vi.advanceTimersByTimeAsync(60_001);
    await late;
    expect(FakeWorker.all[0]?.terminated).toBe(true);
    void decodeRaw(buf(), true).catch(() => undefined);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('any failed decode restarts the worker, so a broken decoder never sticks', async () => {
    const a = decodeRaw(buf(), true);
    const w = FakeWorker.all[0] as FakeWorker;
    w.reply({ id: w.posted[0]?.id, ok: false, error: 'decode failed' });
    await expect(a).rejects.toThrow(/couldn’t read/);
    expect(w.terminated).toBe(true);
    const b = decodeRaw(buf(), true);
    const w2 = FakeWorker.all[1] as FakeWorker;
    expect(w2).toBeDefined();
    w2.reply(ok(w2.posted[0]?.id as number));
    await expect(b).resolves.toBeTruthy();
  });

  it('a full-size decode too big for memory fails with its own error', async () => {
    const a = decodeRaw(buf(), false);
    const w = FakeWorker.all[0] as FakeWorker;
    w.reply({ id: w.posted[0]?.id, ok: false, error: 'memory' });
    await expect(a).rejects.toBeInstanceOf(RawTooLargeForFull);
  });

  it('aborting drops a waiting decode before it is ever sent, and stops a running one', async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = decodeRaw(buf(), true, c1.signal);
    const b = decodeRaw(buf(), true, c2.signal);
    const w = FakeWorker.all[0] as FakeWorker;
    c2.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.posted).toHaveLength(1);
    c1.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.terminated).toBe(true);
  });
});
