import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type { PasskeyOptions } from '@zephyr/shared/client';

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/** Supabase returns plain WebAuthn options JSON; some versions wrap them in { publicKey }. */
function unwrap<T>(options: Record<string, unknown>): T {
  return ((options as { publicKey?: unknown }).publicKey ?? options) as T;
}

/** Runs the browser's passkey sign-in prompt; returns the credential JSON to send back to the API. */
export async function getPasskeyAssertion(opts: PasskeyOptions): Promise<Record<string, unknown>> {
  const res = await startAuthentication({
    optionsJSON: unwrap<PublicKeyCredentialRequestOptionsJSON>(opts.options),
  });
  return res as unknown as Record<string, unknown>;
}

/** Runs the browser's "save a passkey" prompt. */
export async function createPasskey(opts: PasskeyOptions): Promise<Record<string, unknown>> {
  const res = await startRegistration({
    optionsJSON: unwrap<PublicKeyCredentialCreationOptionsJSON>(opts.options),
  });
  return res as unknown as Record<string, unknown>;
}

/** True when the visitor dismissed the browser prompt (not worth an error message). */
export function isCancelled(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
