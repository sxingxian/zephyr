import type { AiJobSummary, DeviceJobParams } from '@zephyr/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceLabel } from './aiClient';
import { ApiFailure } from './api';
import { DeviceRunner, type RunnerDeps } from './deviceRunner';

const RUNNER = 'AbCdEfGhIjKlMnOpQrStUv';
const PARAMS: DeviceJobParams = { steps: ['auto_enhance'], strength: 70, skin: true };
const job = (id = 'j1', params: DeviceJobParams = PARAMS) =>
  ({ id, params }) as Pick<AiJobSummary, 'id' | 'params'>;

function deps(over: Partial<RunnerDeps> = {}) {
  let t = 0;
  const d: RunnerDeps & { progressCalls: { done?: string[]; failed?: string[] }[] } = {
    progressCalls: [],
    owner: () => 'u1',
    claim: vi.fn(async (id: string) => ({
      job: { id, params: PARAMS, createdAt: '2026-11-01T00:00:00Z' } as AiJobSummary,
      remaining: ['a', 'b', 'c'],
    })),
    progress: vi.fn(async (_id: string, body: { done?: string[]; failed?: string[] }) => {
      d.progressCalls.push(body);
    }),
    pause: vi.fn(async () => {}),
    photo: vi.fn(async (id: string) => ({
      id,
      filename: `${id}.jpg`,
      fileType: 'jpeg' as const,
      hasPreview: true,
    })),
    run: vi.fn(async () => {
      t += 500;
      return { status: 'done' };
    }),
    reference: vi.fn(async () => ({})),
    device: () => 'Chrome on Mac',
    now: () => t,
    changed: vi.fn(),
    runner: () => RUNNER,
    exclusive: async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return true;
    },
    ...over,
  };
  return d;
}

describe('DeviceRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claims the job, runs every remaining photo and reports progress, throttled to every 2 s', async () => {
    const d = deps();
    const r = new DeviceRunner(d);
    await r.start(job());
    expect(d.claim).toHaveBeenCalledWith('j1', 'Chrome on Mac', RUNNER);
    // Every report carries this tab's runner token, and the photos are run with the job's start time.
    expect(d.progressCalls.every((c) => (c as { runner?: string }).runner === RUNNER)).toBe(true);
    expect((d.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      since: '2026-11-01T00:00:00Z',
    });
    expect(d.run).toHaveBeenCalledTimes(3);
    // a (t=500) and b (t=1000) are held back by the throttle; the final flush carries everything left.
    const reported = d.progressCalls.flatMap((c) => c.done ?? []);
    expect(reported.sort()).toEqual(['a', 'b', 'c']);
    expect(d.progressCalls.length).toBeLessThanOrEqual(2);
    expect(r.getSnapshot()[0]).toMatchObject({ id: 'j1', total: 3, done: 3, failed: 0, state: 'stopped' });
    expect(d.changed).toHaveBeenCalled();
  });

  it('counts a missing photo as failed and keeps going', async () => {
    const d = deps({
      photo: vi.fn(async (id: string) => {
        if (id === 'b') throw new ApiFailure('not_found', 404);
        return { id, filename: `${id}.jpg`, fileType: 'jpeg' as const, hasPreview: true };
      }),
    });
    const r = new DeviceRunner(d);
    await r.start(job());
    expect(d.progressCalls.flatMap((c) => c.failed ?? [])).toEqual(['b']);
    expect(r.getSnapshot()[0]).toMatchObject({ done: 2, failed: 1 });
  });

  it('marks the job lost when another device holds it (409)', async () => {
    const d = deps({ claim: vi.fn(async () => Promise.reject(new ApiFailure('conflict', 409))) });
    const r = new DeviceRunner(d);
    await r.start(job());
    expect(d.run).not.toHaveBeenCalled();
    expect(r.getSnapshot()[0]?.state).toBe('lost');
  });

  it('stops before the next photo when someone else signs in, posting nothing for them', async () => {
    let owner = 'u1';
    const d = deps({
      owner: () => owner,
      run: vi.fn(async () => {
        owner = 'u2';
        return { status: 'done' };
      }),
    });
    const r = new DeviceRunner(d);
    await r.start(job());
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(r.getSnapshot()[0]?.state).toBe('stopped');
  });

  it('pause stops work here and releases the lease', async () => {
    let release: (() => void) | undefined;
    const d = deps({
      run: vi.fn(
        () =>
          new Promise<{ status: string }>((res) => {
            release = () => res({ status: 'done' });
          }),
      ),
    });
    const r = new DeviceRunner(d);
    const p = r.start(job());
    await vi.advanceTimersByTimeAsync(0);
    expect(r.isRunning('j1')).toBe(true);
    await r.pause('j1');
    release?.();
    await p;
    expect(d.pause).toHaveBeenCalledWith('j1');
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(r.isRunning('j1')).toBe(false);
  });

  it('keeps the lease alive with a heartbeat during a slow photo', async () => {
    let release: (() => void) | undefined;
    const d = deps({
      claim: vi.fn(async (id: string) => ({ job: { id, params: PARAMS } as AiJobSummary, remaining: ['a'] })),
      now: () => Date.now(),
      run: vi.fn(
        () =>
          new Promise<{ status: string }>((res) => {
            release = () => res({ status: 'done' });
          }),
      ),
    });
    const r = new DeviceRunner(d);
    const p = r.start(job());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(d.progress).toHaveBeenCalledWith('j1', { done: [], failed: [], runner: RUNNER }, 'u1');
    release?.();
    await p;
  });

  it('loads the colour-match reference once per job', async () => {
    const params: DeviceJobParams = {
      steps: ['color_match'],
      reference: '0b9f4a1e-0f1a-4c4e-9d1f-0e8b7a6c5d4e',
    };
    const d = deps({
      claim: vi.fn(async (id: string) => ({
        job: { id, params } as AiJobSummary,
        remaining: ['a', 'b', 'c'],
      })),
    });
    const r = new DeviceRunner(d);
    await r.start(job('j2', params));
    expect(d.reference).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledTimes(3);
  });

  // ---- client review #2 and #6 -------------------------------------------------------------------------
  it('doesn’t run a job another tab of this browser is running (Web Lock)', async () => {
    const d = deps({ exclusive: async () => false });
    const r = new DeviceRunner(d);
    await r.start(job());
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
    expect(r.getSnapshot()[0]?.state).toBe('lost');
  });

  it('the heartbeat never posts for a stopped job or for someone else, and a lost lease stops the job', async () => {
    let release: (() => void) | undefined;
    let owner = 'u1';
    const d = deps({
      owner: () => owner,
      claim: vi.fn(async (id: string) => ({
        job: { id, params: PARAMS } as AiJobSummary,
        remaining: ['a', 'b'],
      })),
      now: () => Date.now(),
      run: vi.fn(
        () =>
          new Promise<{ status: string }>((res) => {
            release = () => res({ status: 'done' });
          }),
      ),
    });
    const r = new DeviceRunner(d);
    const p = r.start(job());
    await vi.advanceTimersByTimeAsync(0);
    owner = 'u2'; // someone else signed in while a slow photo ran
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.progress).not.toHaveBeenCalled();
    owner = 'u1';
    // The lease went elsewhere: the heartbeat's 409 aborts the job before the next photo.
    (d.progress as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new ApiFailure('conflict', 409);
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(d.progress).toHaveBeenCalledTimes(1);
    release?.();
    await p;
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(r.getSnapshot()[0]?.state).toBe('lost');
  });

  it('keeps ids whose heartbeat report failed and sends them with the next one', async () => {
    let release: (() => void) | undefined;
    let n = 0;
    let fail = true;
    const d = deps({
      claim: vi.fn(async (id: string) => ({
        job: { id, params: PARAMS } as AiJobSummary,
        remaining: ['a', 'b'],
      })),
      now: () => Date.now(),
      progress: vi.fn(async (_id: string, body: { done?: string[]; failed?: string[] }) => {
        if (fail) {
          fail = false;
          throw new ApiFailure('network', 0);
        }
        d.progressCalls.push(body);
      }),
      // 'a' finishes at once (its report is held back by the 2 s throttle); 'b' is slow.
      run: vi.fn(() =>
        n++ === 0
          ? Promise.resolve({ status: 'done' })
          : new Promise<{ status: string }>((res) => {
              release = () => res({ status: 'done' });
            }),
      ),
    });
    const r = new DeviceRunner(d);
    const p = r.start(job());
    await vi.advanceTimersByTimeAsync(31_000); // heartbeat carries 'a' and fails
    expect(d.progress).toHaveBeenCalledTimes(1);
    release?.();
    await p;
    expect(d.progressCalls.flatMap((c) => c.done ?? []).sort()).toEqual(['a', 'b']);
  });

  it('stopAll (session end) aborts every job', async () => {
    const d = deps({ run: vi.fn(() => new Promise<{ status: string }>(() => {})) });
    const r = new DeviceRunner(d);
    void r.start(job());
    await vi.advanceTimersByTimeAsync(0);
    r.stopAll();
    expect(r.getSnapshot()).toEqual([]);
  });
});

describe('deviceLabel', () => {
  it('names the browser and the device', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      ),
    ).toBe('Chrome on Mac');
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
    expect(
      deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'),
    ).toBe('Firefox on Windows');
  });
});
