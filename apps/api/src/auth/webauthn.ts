/**
 * Realm checks on WebAuthn responses before they go to Supabase Auth.
 *
 * Passkeys are scoped to the RP ID midnightpoetry.studio, and Auth accepts both the app and the
 * landing origins, so on its own it would take an assertion made on one host at the other's API. We
 * read clientDataJSON ourselves and require the ceremony type and the origin of the realm being
 * signed in to (and that it matches the request's Origin). Auth still verifies the signature and
 * the challenge; this only narrows what it's asked to accept.
 */
import type { Context } from 'hono';

export type Ceremony = 'webauthn.get' | 'webauthn.create';

function decodeBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s) || s.length > 8192) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bin, (ch) => ch.charCodeAt(0)),
    );
  } catch {
    return null;
  }
}

/** The parsed clientDataJSON of a credential (RegistrationResponseJSON / AuthenticationResponseJSON). */
export function clientData(credential: Record<string, unknown>): Record<string, unknown> | null {
  const response = credential.response;
  if (!response || typeof response !== 'object') return null;
  const raw = (response as Record<string, unknown>).clientDataJSON;
  if (typeof raw !== 'string') return null;
  const text = decodeBase64Url(raw);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True if the credential was made for this ceremony, on an allowed origin of this realm, and on the
 * same origin as the request itself.
 */
export function ceremonyMatches(
  c: Context,
  credential: Record<string, unknown>,
  type: Ceremony,
  allowedOrigins: string[],
): boolean {
  const data = clientData(credential);
  if (!data) return false;
  const origin = data.origin;
  return (
    data.type === type &&
    typeof origin === 'string' &&
    allowedOrigins.includes(origin) &&
    origin === c.req.header('Origin') &&
    data.crossOrigin !== true
  );
}
