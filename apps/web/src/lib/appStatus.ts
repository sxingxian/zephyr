import { type AppStatusResult, MEMBER8_API } from '@zephyr/shared/client';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Phase 8: read-only mode and the maintenance notice (`/api/v1/status`, no session). Polled every 2 minutes
 * while the app is open, and again whenever a call answers 503 read_only_mode. While read-only is on, write
 * entry points (upload, edit, Zephyr AI, sharing) are hidden or disabled; the server refuses them regardless.
 */
export type AppStatus = Omit<AppStatusResult, 'ok'>;
const EMPTY: AppStatus = { readOnly: null, maintenance: null };
export const STATUS_POLL_MS = 2 * 60 * 1000;

let status: AppStatus = EMPTY;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

function valid(v: unknown): v is AppStatusResult {
  const r = v as AppStatusResult | null;
  return Boolean(r && r.ok === true && 'readOnly' in r && 'maintenance' in r);
}

/** Fetches the status (one request at a time). Network errors keep the last known status. */
export function refreshAppStatus(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(MEMBER8_API.status, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && valid(body)) {
        status = { readOnly: body.readOnly, maintenance: body.maintenance };
        emit();
      }
    } catch {
      // Offline: keep what we had.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** A call answered 503 read_only_mode: show the banner at once, then confirm with the server. */
export function markReadOnly(): void {
  if (!status.readOnly) {
    status = { ...status, readOnly: { on: true, message: '' } };
    emit();
  }
  void refreshAppStatus();
}

export const isAppReadOnly = (): boolean => Boolean(status.readOnly?.on);
export const appStatus = (): AppStatus => status;

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}
export function useAppStatus(): AppStatus {
  return useSyncExternalStore(subscribe, appStatus, appStatus);
}
export function useAppReadOnly(): boolean {
  return useSyncExternalStore(subscribe, isAppReadOnly, isAppReadOnly);
}

/** Mounted once in the app: first fetch, then every 2 minutes and when the tab becomes visible again. */
export function useAppStatusPolling(): void {
  useEffect(() => {
    void refreshAppStatus();
    const t = setInterval(() => void refreshAppStatus(), STATUS_POLL_MS);
    const vis = () => {
      if (document.visibilityState === 'visible') void refreshAppStatus();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
}

/** Test helper. */
export function resetAppStatus(next: AppStatus = EMPTY): void {
  status = next;
  loading = null;
  emit();
}
