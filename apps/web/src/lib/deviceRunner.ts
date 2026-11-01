import {
  type AiJobSummary,
  type DeviceJobParams,
  type PhotoItem,
  RUNNER_TOKEN_RE,
} from '@zephyr/shared/client';
import { useSyncExternalStore } from 'react';
import { claimJob, deviceLabel, pauseJob, postProgress, refreshAiStatus } from './aiClient';
import { ApiFailure } from './api';
import { getPhoto } from './library';
import { onSessionEnd, sessionUserId } from './sessionGuard';

/**
 * Runs device jobs (phase 6 batches of auto-enhance, HDR and colour match) in this tab. A device job lives on
 * the server: this tab claims it (a lease of DEVICE_LEASE_SECONDS), processes the remaining photos one at a
 * time with the engine's `runDeviceSteps`, and posts progress after photos (at most every 2 s, and at least
 * every 30 s while a slow photo runs), which renews the lease. Pause releases it; if the tab closes, the
 * lease lapses and any of the member's devices can "Continue here".
 *
 * Everything is bound to the member who started it: the session ending stops every job at once.
 *
 * One runner per job: a Web Lock (`zephyr-dj:<id>`) keeps a second tab of this browser from running the same
 * job, and the lease carries this tab's runner token, so another tab or device of the same sign-in can't
 * claim or report on it either (409). Photos edited after the job started are left alone (never stacked).
 */

type Photo = Pick<PhotoItem, 'id' | 'filename' | 'fileType' | 'hasPreview'>;
export interface RunnerDeps {
  owner(): string | null;
  claim(id: string, device: string, runner: string): Promise<{ job: AiJobSummary; remaining: string[] }>;
  progress(
    id: string,
    body: { done?: string[]; failed?: string[]; runner: string },
    owner: string,
  ): Promise<unknown>;
  pause(id: string): Promise<unknown>;
  photo(id: string, signal: AbortSignal): Promise<Photo>;
  /** One photo through the device steps ('done' / 'unchanged' count as done). Throws to stop the whole job. */
  run(
    photo: Photo,
    params: DeviceJobParams,
    ctx: { owner: string; signal: AbortSignal; reference?: unknown; since?: string },
  ): Promise<{ status: string }>;
  /** The colour-match reference, loaded once per job. */
  reference(photoId: string, signal: AbortSignal): Promise<unknown>;
  device(): string;
  now(): number;
  changed(): void;
  /** This tab's runner token (kept for the tab's life, reloads included). */
  runner(): string;
  /**
   * Runs `fn` holding this browser's lock for the job, or returns false at once when another tab holds it.
   * Browsers without Web Locks just run it (the server's runner check still applies).
   */
  exclusive(id: string, fn: () => Promise<void>): Promise<boolean>;
}

/** 16 random bytes, base64url: 22 characters (RUNNER_TOKEN_RE). */
function newRunnerToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
let tabRunner: string | null = null;
/** Per tab: sessionStorage survives a reload of this tab (so it can pick its own lease back up) but not a new tab. */
export function tabRunnerToken(): string {
  if (tabRunner) return tabRunner;
  try {
    const kept = sessionStorage.getItem('zephyr-runner');
    if (kept && RUNNER_TOKEN_RE.test(kept)) {
      tabRunner = kept;
      return kept;
    }
    tabRunner = newRunnerToken();
    sessionStorage.setItem('zephyr-runner', tabRunner);
  } catch {
    tabRunner ??= newRunnerToken();
  }
  return tabRunner;
}

export interface LocalJob {
  id: string;
  total: number;
  done: number;
  failed: number;
  state: 'running' | 'stopped' | 'lost' | 'error';
  error: string | null;
}

const POST_EVERY_MS = 2000;
const HEARTBEAT_MS = 30_000;

const defaultDeps: RunnerDeps = {
  owner: sessionUserId,
  claim: (id, device, runner) => claimJob(id, device, runner),
  progress: (id, body, owner) => postProgress(id, body, owner),
  pause: (id) => pauseJob(id),
  photo: (id, signal) => getPhoto(id, signal),
  async run(photo, params, ctx) {
    const { runDeviceSteps } = await import('./ai/run');
    return runDeviceSteps(photo, params, ctx as Parameters<typeof runDeviceSteps>[2]);
  },
  async reference(photoId, signal) {
    const [{ loadReference }, photo] = await Promise.all([import('./ai/run'), getPhoto(photoId, signal)]);
    return loadReference(photo, signal);
  },
  device: () => deviceLabel(),
  now: () => Date.now(),
  changed: () => void refreshAiStatus(),
  runner: tabRunnerToken,
  async exclusive(id, fn) {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks?.request) {
      await fn();
      return true;
    }
    return locks.request(`zephyr-dj:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      await fn();
      return true;
    });
  },
};

export class DeviceRunner {
  private jobs = new Map<string, { ctrl: AbortController; local: LocalJob }>();
  private subs = new Set<() => void>();
  private snap: LocalJob[] = [];

  constructor(private deps: RunnerDeps = defaultDeps) {}

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  private emit() {
    this.snap = [...this.jobs.values()].map((j) => ({ ...j.local }));
    for (const s of this.subs) s();
  }
  isRunning(id: string): boolean {
    return this.jobs.get(id)?.local.state === 'running';
  }

  /** Claims the job for this device and works through what's left. Resolves when it stops. */
  async start(job: Pick<AiJobSummary, 'id' | 'params'>): Promise<void> {
    if (this.isRunning(job.id)) return;
    const owner = this.deps.owner();
    if (!owner || !job.params) return;
    const ctrl = new AbortController();
    const local: LocalJob = { id: job.id, total: 0, done: 0, failed: 0, state: 'running', error: null };
    this.jobs.set(job.id, { ctrl, local });
    this.emit();
    try {
      const ran = await this.deps.exclusive(job.id, async () => {
        const runner = this.deps.runner();
        const claimed = await this.deps.claim(job.id, this.deps.device(), runner);
        const params = claimed.job.params ?? job.params;
        if (!params) return;
        local.total = claimed.remaining.length;
        this.emit();
        await this.work(
          job.id,
          owner,
          params,
          claimed.remaining,
          ctrl.signal,
          local,
          runner,
          claimed.job.createdAt,
        );
      });
      if (!ran) local.state = 'lost'; // another tab of this browser is running it
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'conflict') local.state = 'lost';
      else if (ctrl.signal.aborted || (e as Error).name === 'AbortError') local.state = 'stopped';
      else {
        local.state = 'error';
        local.error = e instanceof ApiFailure ? e.code : (e as Error)?.message || 'failed';
      }
    } finally {
      if (this.jobs.get(job.id)?.local === local) {
        if (local.state === 'running') local.state = 'stopped';
        this.emit();
      }
      this.deps.changed();
    }
  }

  private async work(
    id: string,
    owner: string,
    params: DeviceJobParams,
    remaining: string[],
    signal: AbortSignal,
    local: LocalJob,
    runner: string,
    since: string,
  ) {
    let done: string[] = [];
    let failed: string[] = [];
    let last = this.deps.now();
    const live = () => !signal.aborted && this.deps.owner() === owner;
    const flush = async (force: boolean) => {
      if (!force && this.deps.now() - last < POST_EVERY_MS) return;
      const body = { done, failed, runner };
      done = [];
      failed = [];
      last = this.deps.now();
      try {
        await this.deps.progress(id, body, owner);
      } catch (e) {
        // Not recorded: keep the ids for the next report (the server keeps those photos pending meanwhile).
        done = [...body.done, ...done];
        failed = [...body.failed, ...failed];
        throw e;
      }
    };
    // A slow photo (a big RAW) mustn't let the lease lapse. Never for a stopped job or another member.
    const ctrl = this.jobs.get(id)?.ctrl;
    const beat = setInterval(() => {
      if (!live() || this.deps.now() - last < HEARTBEAT_MS) return;
      void flush(true).catch((e) => {
        // The lease went to another runner: stop here at once rather than carry on unrecorded.
        if (e instanceof ApiFailure && e.code === 'conflict') {
          local.state = 'lost';
          ctrl?.abort();
        }
      });
    }, HEARTBEAT_MS / 3);
    try {
      const reference =
        params.steps.includes('color_match') && params.reference
          ? await this.deps.reference(params.reference, signal)
          : undefined;
      for (const photoId of remaining) {
        if (signal.aborted) throw new DOMException('Stopped.', 'AbortError');
        if (this.deps.owner() !== owner) throw new DOMException('Signed in as someone else.', 'AbortError');
        let ok = false;
        try {
          const photo = await this.deps.photo(photoId, signal);
          const r = await this.deps.run(photo, params, { owner, signal, reference, since });
          ok = r.status === 'done' || r.status === 'unchanged';
        } catch (e) {
          // A missing photo fails just that photo; anything that stops the job is rethrown.
          if (!(e instanceof ApiFailure && e.code === 'not_found')) throw e;
        }
        if (ok) {
          done.push(photoId);
          local.done += 1;
        } else {
          failed.push(photoId);
          local.failed += 1;
        }
        this.emit();
        await flush(false);
      }
      await flush(true);
    } finally {
      clearInterval(beat);
      if (
        signal.aborted &&
        local.state !== 'lost' &&
        (done.length || failed.length) &&
        this.deps.owner() === owner
      ) {
        // Stopped by pause: still report what finished.
        await this.deps.progress(id, { done, failed, runner }, owner).catch(() => {});
      }
    }
  }

  /** Pause: stop here and release the lease so another device (or later this one) can continue. */
  async pause(id: string): Promise<void> {
    this.stopLocal(id);
    await this.deps.pause(id);
    this.deps.changed();
  }
  /** Stops work in this tab only (cancel, or the job was taken over elsewhere). */
  stopLocal(id: string): void {
    const j = this.jobs.get(id);
    if (!j) return;
    j.ctrl.abort();
    j.local.state = 'stopped';
    this.emit();
  }
  /** Session end: stop everything, nothing more is sent. */
  stopAll(): void {
    for (const j of this.jobs.values()) j.ctrl.abort();
    this.jobs.clear();
    this.emit();
  }
}

export const deviceRunner = new DeviceRunner();
onSessionEnd(() => deviceRunner.stopAll());

export function useDeviceRunner(): LocalJob[] {
  return useSyncExternalStore(deviceRunner.subscribe, deviceRunner.getSnapshot, deviceRunner.getSnapshot);
}
