import {
  AI_API,
  type AiFeature,
  type AiJobCreateBody,
  type AiJobCreateResult,
  type AiJobDetail,
  type AiJobPage,
  type AiJobSummary,
  type AiMemberSettingsPatch,
  type AiStatus,
  type AiStatusResult,
  type CleanupIgnoreBody,
  type CleanupPage,
  type CreditHistoryPage,
  type DeviceClaimResult,
  type DeviceProgressBody,
  type FaceSuggestion,
  type PersonFacesBody,
  type PersonPatchBody,
  type PersonSummary,
  type SceneSummary,
} from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import { expectedUser } from './library';
import { onSessionEnd, sessionUserId } from './sessionGuard';

/**
 * Phase 6 client for the Zephyr AI routes (AI_API), plus the shared AI status store the app reads to decide
 * what to show. Every write names the member this tab believes is signed in (409 session_changed otherwise).
 */

const q = (params: Record<string, string | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
const write = <T>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  api<T>(path, { method, body: method === 'DELETE' ? undefined : (body ?? {}), headers: expectedUser() });

// ---------------------------------------------------------------- status, settings, credits
export const fetchAiStatus = (signal?: AbortSignal) => api<AiStatusResult>(AI_API.status, { signal });
export const patchAiSettings = (body: AiMemberSettingsPatch) =>
  write<AiStatusResult>(AI_API.settings, 'PATCH', body);
export const fetchCredits = (cursor?: string | null, signal?: AbortSignal) =>
  api<CreditHistoryPage>(`${AI_API.credits}${q({ cursor })}`, { signal });

// ---------------------------------------------------------------- jobs
export type JobState = 'running' | 'finished' | 'failed';
export const listJobs = (state: JobState, cursor?: string | null, signal?: AbortSignal) =>
  api<AiJobPage>(`${AI_API.jobs}${q({ state, cursor })}`, { signal });
export const getJob = (id: string, cursor?: string | null, signal?: AbortSignal) =>
  api<AiJobDetail>(`${AI_API.job(id)}${q({ cursor })}`, { signal });
export const createJob = (body: AiJobCreateBody) => write<AiJobCreateResult>(AI_API.jobs, 'POST', body);
export const cancelJob = (id: string) => write<{ ok: true; job: AiJobSummary }>(AI_API.job(id), 'DELETE');
export const retryJob = (id: string, itemIds?: string[]) =>
  write<{ ok: true; job: AiJobSummary }>(AI_API.jobRetry(id), 'POST', itemIds ? { itemIds } : {});
export const claimJob = (id: string, device: string) =>
  write<DeviceClaimResult>(AI_API.jobClaim(id), 'POST', { device });
export const postProgress = (id: string, body: DeviceProgressBody, owner: string) =>
  api<{ ok: true; job: AiJobSummary }>(AI_API.jobProgress(id), {
    method: 'POST',
    body,
    headers: { 'x-zephyr-expected-user': owner },
  });
export const pauseJob = (id: string) => write<{ ok: true; job: AiJobSummary }>(AI_API.jobPause(id), 'POST');

// ---------------------------------------------------------------- scenes, cleanup
export const fetchScenes = (signal?: AbortSignal) =>
  api<{ ok: true; scenes: SceneSummary[] }>(AI_API.scenes, { signal });
export const fetchCleanup = (cursor?: string | null, signal?: AbortSignal) =>
  api<CleanupPage>(`${AI_API.cleanup}${q({ cursor })}`, { signal });
export const ignoreCleanup = (body: CleanupIgnoreBody) =>
  write<{ ok: true }>(AI_API.cleanupIgnore, 'POST', body);

// ---------------------------------------------------------------- people
export const fetchPeople = (hidden = false, signal?: AbortSignal) =>
  api<{ ok: true; people: PersonSummary[] }>(`${AI_API.people}${hidden ? '?hidden=1' : ''}`, { signal });
export const fetchPerson = (id: string, signal?: AbortSignal) =>
  api<{ ok: true; person: PersonSummary }>(AI_API.person(id), { signal });
export const patchPerson = (id: string, body: PersonPatchBody) =>
  write<{ ok: true; person: PersonSummary }>(AI_API.person(id), 'PATCH', body);
export const mergePeople = (id: string, from: string[]) =>
  write<{ ok: true; person: PersonSummary }>(AI_API.personMerge(id), 'POST', { from });
export const personFaces = (id: string, body: PersonFacesBody) =>
  write<{ ok: true; person: PersonSummary }>(AI_API.personFaces(id), 'POST', body);
export const fetchSuggestions = (signal?: AbortSignal) =>
  api<{ ok: true; suggestions: FaceSuggestion[] }>(AI_API.suggestions, { signal });
/** Turns face grouping off and deletes every face, person and name. */
export const deleteFaceData = () => write<void>(AI_API.faces, 'DELETE');

// ---------------------------------------------------------------- device label
/** "Chrome on Mac", "Safari on iPhone"… shown on device jobs. Never more than DEVICE_LABEL_MAX characters. */
export function deviceLabel(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'this device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} on ${os}`.slice(0, 40);
}

// ---------------------------------------------------------------- status store
/** Shape check: anything else (an older server, an error page) leaves the AI controls hidden. */
export function isAiStatus(x: unknown): x is AiStatus {
  const s = x as Partial<AiStatus> | null;
  return Boolean(
    s &&
      typeof s.enabled === 'boolean' &&
      s.features &&
      typeof s.features === 'object' &&
      s.member &&
      typeof s.member === 'object' &&
      s.credits &&
      typeof s.credits.balance === 'number' &&
      typeof s.credits.monthly === 'number' &&
      typeof s.credits.bgCreditsPerPhoto === 'number' &&
      typeof s.batchSize === 'number',
  );
}
let current: AiStatus | null = null;
let running = 0;
let inflight: Promise<void> | null = null;
let ownerOfStatus: string | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

/** Re-reads the AI status (and the running-jobs count for the nav). Concurrent calls share one request. */
export function refreshAiStatus(): Promise<void> {
  const owner = sessionUserId();
  if (!owner) return Promise.resolve();
  inflight ??= Promise.all([fetchAiStatus(), listJobs('running').catch(() => null)])
    .then(([s, jobs]) => {
      if (sessionUserId() !== owner || !isAiStatus(s)) return; // someone else signed in meanwhile, or not a status
      const { ok: _ok, ...status } = s;
      current = status;
      ownerOfStatus = owner;
      if (jobs && typeof jobs.counts?.running === 'number') running = jobs.counts.running;
      emit();
    })
    .catch(() => {
      // Keep the last known status; the next poll tries again.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
/** Sets the status from a response that carried it (settings PATCH). */
export function setAiStatus(s: AiStatusResult | AiStatus): void {
  if (!isAiStatus(s)) {
    void refreshAiStatus();
    return;
  }
  const { ok: _ok, ...status } = s as AiStatusResult;
  current = status;
  ownerOfStatus = sessionUserId();
  emit();
}
export function setRunningJobs(n: number): void {
  if (n === running) return;
  running = n;
  emit();
}
export function getAiStatus(): AiStatus | null {
  return current && ownerOfStatus === sessionUserId() ? current : null;
}
/** Forget everything (session end, shared devices). */
export function resetAiStatus(): void {
  current = null;
  running = 0;
  ownerOfStatus = null;
  emit();
}
onSessionEnd(() => resetAiStatus());

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
};
/** The member's AI status, or null until it has loaded. */
export function useAiStatus(): AiStatus | null {
  return useSyncExternalStore(subscribe, getAiStatus, getAiStatus);
}
export function useRunningJobs(): number {
  return useSyncExternalStore(
    subscribe,
    () => running,
    () => running,
  );
}

/** Fetches the status on first use, then every five minutes while the app is open. */
export const STATUS_POLL_MS = 5 * 60 * 1000;
export function useAiStatusPolling(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void refreshAiStatus();
    const t = setInterval(() => void refreshAiStatus(), STATUS_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshAiStatus();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);
}

// ---------------------------------------------------------------- feature helpers
export const isOn = (s: AiStatus | null, f: AiFeature) => Boolean(s?.enabled && s.features[f] === 'on');
/** Shown at all (on, or paused cloud work that will resume). */
export const isAvailable = (s: AiStatus | null, f: AiFeature) =>
  Boolean(s?.enabled && (s.features[f] === 'on' || s.features[f] === 'paused'));
export const notOnPlan = (s: AiStatus | null, f: AiFeature) =>
  Boolean(s?.enabled && s.features[f] === 'off_plan');
/** Any editor tool to show in the editor's AI tab. */
export const editorAi = (s: AiStatus | null) =>
  (['auto_enhance', 'hdr', 'color_match', 'bg_removal'] as AiFeature[]).some((f) => isAvailable(s, f));

/** "08:00" in the member's time zone for the paused banner. */
export function pausedUntil(s: AiStatus | null): string | null {
  const u = s?.cloudPaused?.until;
  if (!u) return null;
  const d = new Date(u);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
