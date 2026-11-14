import {
  type AdminSessionResponse,
  type PlanId,
  type StaffAction,
  type StaffRole,
  staffCan,
} from '@zephyr/shared/client';
import { useCallback } from 'react';
import { ApiFailure, api, errorMessage, type RequestOptions } from './api';
import { isCancelled } from './passkey';
import { reauthenticate, withReauth } from './reauth';
import { useAdminSession } from './session';

type Role = AdminSessionResponse['staff']['role'] | undefined;
/** STAFF_CAN, tolerant of "not signed in yet". */
export const can = (role: Role, action: StaffAction) => Boolean(role && staffCan(role as StaffRole, action));

/**
 * A write from a phase 8 admin page. On 403 reauth_required it asks for the passkey (the browser prompt) and
 * tries once more; the API decides which writes need it, the page never guesses.
 */
export function useAdminWrite() {
  const { setSession } = useAdminSession();
  return useCallback(
    <T>(path: string, method: NonNullable<RequestOptions['method']>, body?: unknown) =>
      withReauth(
        () => api<T>(path, { method, body: body ?? {} }),
        async () => setSession(await reauthenticate()),
      ),
    [setSession],
  );
}

/** Message for a failed admin write. */
export function writeError(e: unknown): string {
  if (isCancelled(e)) return 'Not saved. This change needs your passkey.';
  if (e instanceof ApiFailure) {
    if (e.code === 'reauth_required') return 'Not saved. Sign in again with your passkey, then try again.';
    if (e.code === 'forbidden') return 'Your role can’t do that.';
    if (e.code === 'invalid')
      return 'That wasn’t accepted. Check the details and the reason, then try again.';
  }
  return errorMessage(e);
}

export const MIN_REASON = 3;
export const reasonOk = (r: string) => r.trim().length >= MIN_REASON;

export const n = (x: number) => x.toLocaleString('en-GB');
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export const timeOnly = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Bytes → "41.6 TB" (decimal units, like the plan limits). */
export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = b;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export const PLAN_LABEL: Record<PlanId, string> = { free: 'Free', pro: 'Pro', studio: 'Studio' };

/** `<input type="datetime-local">` value (local time) ↔ ISO. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Starts a browser download of a Blob without keeping the object URL around. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
