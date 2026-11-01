import { ADMIN_API, type AdminSessionResponse, type PasskeyOptions } from '@zephyr/shared/client';
import { ApiFailure, api } from './api';
import { getPasskeyAssertion } from './passkey';

/**
 * Signs in again with a passkey (the same ceremony as the sign-in page), so the session counts as recent for
 * changes that need it (403 reauth_required). Throws the browser's NotAllowedError if the prompt is dismissed.
 */
export async function reauthenticate(): Promise<AdminSessionResponse> {
  const opts = await api<PasskeyOptions>(ADMIN_API.passkeyOptions, {
    method: 'POST',
    body: {},
    quiet401: true,
  });
  const credential = await getPasskeyAssertion(opts);
  return api<AdminSessionResponse>(ADMIN_API.passkeyVerify, {
    method: 'POST',
    body: { challengeId: opts.challengeId, credential },
    quiet401: true,
  });
}

/**
 * Runs `call`; on 403 reauth_required, asks for the passkey (via `reauth`) and runs it once more.
 * Any other failure, or a second reauth_required, is thrown.
 */
export async function withReauth<T>(call: () => Promise<T>, reauth: () => Promise<void>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof ApiFailure && e.code === 'reauth_required')) throw e;
  }
  await reauth();
  return call();
}
