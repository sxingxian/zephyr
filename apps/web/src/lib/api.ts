import type { ApiError, ApiErrorCode } from '@zephyr/shared/client';

/** A failed API call, carrying the contract's error code. */
export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode | 'network',
    readonly status: number,
    readonly retryAfter?: number,
    /** The error response body, when it carried more than the code (e.g. 409 conflict → the current edit). */
    readonly body?: unknown,
  ) {
    super(code);
    this.name = 'ApiFailure';
  }
}

type Listener = () => void;
let onUnauthenticated: Listener | null = null;
/** The session layer registers this to send the visitor to sign-in when a request returns 401. */
export function setUnauthenticatedHandler(fn: Listener | null): void {
  onUnauthenticated = fn;
}
let onPendingDeletion: Listener | null = null;
/** The session layer registers this to re-check the session when the account turns out to be scheduled for deletion. */
export function setPendingDeletionHandler(fn: Listener | null): void {
  onPendingDeletion = fn;
}
let onSessionChanged: Listener | null = null;
/** The session layer registers this to stop and reload when the cookie turns out to belong to someone else. */
export function setSessionChangedHandler(fn: Listener | null): void {
  onSessionChanged = fn;
}
/** Shared by every request helper: global reactions to 401, 403 account_pending_deletion and 409 session_changed. */
export function notifyFailure(failure: ApiFailure, quiet401?: boolean): void {
  if (failure.code === 'unauthenticated' && !quiet401) onUnauthenticated?.();
  if (failure.code === 'account_pending_deletion') onPendingDeletion?.();
  if (failure.code === 'session_changed') onSessionChanged?.();
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Don't trigger the global sign-in redirect on 401 (used by the session probe itself). */
  quiet401?: boolean;
  signal?: AbortSignal;
  /** Extra request headers (e.g. the expected member on upload calls). */
  headers?: Record<string, string>;
}

const KNOWN: ApiErrorCode[] = [
  'invalid',
  'unauthenticated',
  'forbidden',
  'verification_failed',
  'rate_limited',
  'invalid_code',
  'invite_invalid',
  'signups_paused',
  'member_invites_disabled',
  'quota_exceeded',
  'already_member',
  'passkey_failed',
  'passkey_required',
  'reauth_required',
  'not_found',
  'conflict',
  'account_pending_deletion',
  'upload_expired',
  'too_large',
  'storage_full',
  'session_changed',
  'wrong_passcode',
  'gallery_paused',
  'sharing_suspended',
  'plan_required',
  'limit_reached',
  'server',
];

/** Maps a response to an error code, falling back on the status when the body isn't the contract shape. */
export function toFailure(status: number, body: unknown, retryHeader: string | null): ApiFailure {
  const b = body as Partial<ApiError> | null;
  const code =
    b && typeof b.error === 'string' && (KNOWN as string[]).includes(b.error)
      ? (b.error as ApiErrorCode)
      : fallback(status);
  const retry = Number(retryHeader) || (typeof b?.retryAfter === 'number' ? b.retryAfter : undefined);
  return new ApiFailure(code, status, code === 'rate_limited' ? retry || 60 : undefined, body ?? undefined);
}
function fallback(status: number): ApiErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid';
  return 'server';
}

/** JSON request to our own API. Cookies are same-origin; the browser never handles tokens. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...opts.headers,
        accept: 'application/json',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiFailure('network', 0);
  }
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body as T;
  const failure = toFailure(res.status, body, res.headers.get('retry-after'));
  notifyFailure(failure, opts.quiet401);
  throw failure;
}

const minutes = (s: number) => {
  const m = Math.max(1, Math.ceil(s / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

/** Plain-language message for an error. Context-specific screens may override some codes. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiFailure)) return 'Something went wrong. Try again.';
  switch (err.code) {
    case 'network':
      return 'You seem to be offline. Check your connection and try again.';
    case 'rate_limited':
      return `Too many tries. Wait ${minutes(err.retryAfter ?? 60)} and try again.`;
    case 'verification_failed':
      return 'We couldn’t confirm you’re human. Complete the check again, then retry.';
    case 'invalid_code':
      return 'That code didn’t work. Check it, or ask for a new one.';
    case 'invite_invalid':
      return 'This invite has expired or was already used.';
    case 'signups_paused':
      return 'New accounts are paused for now. Try again later.';
    case 'member_invites_disabled':
      return 'Member invites are turned off right now.';
    case 'quota_exceeded':
      return 'You’ve used all your invites for this month.';
    case 'already_member':
      return 'That person already has a Zephyr account.';
    case 'passkey_failed':
      return 'The passkey didn’t work. Try again, or use an email code.';
    case 'invalid':
      return 'Check the details and try again.';
    case 'passkey_required':
      return 'Add a passkey to continue.';
    case 'reauth_required':
      return 'For your security, sign in again before changing passkeys.';
    case 'unauthenticated':
      return 'Your session ended. Sign in again.';
    case 'forbidden':
      return 'You don’t have access to that.';
    case 'not_found':
      return 'That isn’t here any more. It may have been deleted.';
    case 'account_pending_deletion':
      return 'This account is scheduled for deletion. Restore it to keep using Zephyr.';
    case 'upload_expired':
      return 'This upload expired. Retry to start it again.';
    case 'too_large':
      return 'That file is larger than your plan allows.';
    case 'storage_full':
      return 'Your storage is full. Free up space or upgrade to upload more.';
    case 'plan_required':
      return 'That needs a different plan. See Plans to upgrade.';
    case 'sharing_suspended':
      return 'Sharing is paused on your account while we review a report. Contact support.';
    case 'limit_reached':
      return 'That’s the most this allows. Remove something first, then try again.';
    case 'wrong_passcode':
      return 'That passcode isn’t right.';
    case 'gallery_paused':
      return 'This gallery is paused after too many wrong passcodes. Try again later.';
    default:
      return 'Something went wrong on our side. Try again in a minute.';
  }
}
