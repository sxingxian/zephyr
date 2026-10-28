/**
 * Typed client for the Supabase Auth (GoTrue) REST API, as used by the Worker. User-level calls send
 * the publishable key as `apikey` (and the user's access token where needed); admin calls use the
 * secret key. Errors become UpstreamError with GoTrue's error_code only: GoTrue messages can echo
 * user input (emails), so they are never logged or returned.
 */
import { type Env, secretKey, supabaseHeaders, supabaseUrl } from '../env';
import { UpstreamError } from '../supabase';

export interface GoTrueUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  created_at?: string;
}
export interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type?: string;
  user?: GoTrueUser;
}
export interface GoTruePasskey {
  id: string;
  friendly_name?: string | null;
  created_at: string;
  last_used_at?: string | null;
}
export interface GoTrueChallenge {
  challenge_id: string;
  options: Record<string, unknown>;
}

type Auth = { kind: 'public' } | { kind: 'user'; jwt: string } | { kind: 'admin' };

async function call<T>(env: Env, method: string, path: string, auth: Auth, body?: unknown): Promise<T> {
  const key = auth.kind === 'admin' ? secretKey(env) : env.SUPABASE_PUBLISHABLE_KEY;
  const headers: Record<string, string> = supabaseHeaders(key, auth.kind === 'user' ? auth.jwt : undefined);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${supabaseUrl(env)}/auth/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error_code?: string; code?: string | number; error?: string };
      code = j.error_code ?? (typeof j.code === 'string' ? j.code : undefined) ?? j.error;
    } catch {
      code = undefined;
    }
    throw new UpstreamError(`auth:${method} ${path.split('?')[0]}`, res.status, code);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function asSession(data: unknown): GoTrueSession {
  const d = data as Partial<GoTrueSession> & { session?: GoTrueSession };
  const s = d?.access_token ? (d as GoTrueSession) : d?.session;
  if (!s?.access_token || !s.refresh_token) throw new UpstreamError('auth:session', 502, 'no_session');
  return s;
}

export const gotrue = {
  /** Sends a 6-digit sign-in code to an existing account. Never creates users. */
  sendEmailCode: (env: Env, email: string) =>
    call<unknown>(env, 'POST', '/otp', { kind: 'public' }, { email, create_user: false }),

  verifyEmailCode: async (env: Env, email: string, code: string) =>
    asSession(await call(env, 'POST', '/verify', { kind: 'public' }, { type: 'email', email, token: code })),

  verifyTokenHash: async (env: Env, tokenHash: string, type: string) =>
    asSession(await call(env, 'POST', '/verify', { kind: 'public' }, { type, token_hash: tokenHash })),

  refresh: async (env: Env, refreshToken: string) =>
    asSession(
      await call(
        env,
        'POST',
        '/token?grant_type=refresh_token',
        { kind: 'public' },
        { refresh_token: refreshToken },
      ),
    ),

  logout: (env: Env, jwt: string) => call<unknown>(env, 'POST', '/logout?scope=local', { kind: 'user', jwt }),
  /** Ends every session of the token's user (all devices). */
  logoutEverywhere: (env: Env, jwt: string) =>
    call<unknown>(env, 'POST', '/logout?scope=global', { kind: 'user', jwt }),

  getUser: (env: Env, jwt: string) => call<GoTrueUser>(env, 'GET', '/user', { kind: 'user', jwt }),

  // ---- passkeys (Supabase beta: /passkeys/*) ----
  passkeyAuthOptions: (env: Env) =>
    call<GoTrueChallenge>(env, 'POST', '/passkeys/authentication/options', { kind: 'public' }, {}),
  passkeyAuthVerify: async (env: Env, challengeId: string, credential: unknown) =>
    asSession(
      await call(
        env,
        'POST',
        '/passkeys/authentication/verify',
        { kind: 'public' },
        {
          challenge_id: challengeId,
          credential,
        },
      ),
    ),
  passkeyRegisterOptions: (env: Env, jwt: string) =>
    call<GoTrueChallenge>(env, 'POST', '/passkeys/registration/options', { kind: 'user', jwt }, {}),
  passkeyRegisterVerify: (env: Env, jwt: string, challengeId: string, credential: unknown) =>
    call<GoTruePasskey>(
      env,
      'POST',
      '/passkeys/registration/verify',
      { kind: 'user', jwt },
      {
        challenge_id: challengeId,
        credential,
      },
    ),
  listPasskeys: async (env: Env, jwt: string) => {
    const out = await call<GoTruePasskey[] | { passkeys?: GoTruePasskey[] }>(env, 'GET', '/passkeys', {
      kind: 'user',
      jwt,
    });
    return Array.isArray(out) ? out : (out?.passkeys ?? []);
  },
  renamePasskey: (env: Env, jwt: string, id: string, friendlyName: string) =>
    call<GoTruePasskey>(
      env,
      'PATCH',
      `/passkeys/${encodeURIComponent(id)}`,
      { kind: 'user', jwt },
      {
        friendly_name: friendlyName,
      },
    ),
  deletePasskey: (env: Env, jwt: string, id: string) =>
    call<unknown>(env, 'DELETE', `/passkeys/${encodeURIComponent(id)}`, { kind: 'user', jwt }),

  // ---- admin ----
  /** Deletes the Auth user (cascades to the profile and library rows). A user already gone is not an error. */
  adminDeleteUser: async (env: Env, userId: string) => {
    try {
      await call<unknown>(env, 'DELETE', `/admin/users/${encodeURIComponent(userId)}`, { kind: 'admin' });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return;
      throw err;
    }
  },
  adminCreateUser: (env: Env, email: string, displayName?: string) =>
    call<GoTrueUser>(
      env,
      'POST',
      '/admin/users',
      { kind: 'admin' },
      {
        email,
        email_confirm: true,
        user_metadata: displayName ? { display_name: displayName } : {},
      },
    ),
  /** A one-time magic-link token for an existing user; verified server-side to mint a session. */
  adminMagicLink: async (env: Env, email: string) => {
    const out = await call<{
      hashed_token?: string;
      verification_type?: string;
      properties?: { hashed_token?: string; verification_type?: string };
    }>(env, 'POST', '/admin/generate_link', { kind: 'admin' }, { type: 'magiclink', email });
    const hashed = out?.properties?.hashed_token ?? out?.hashed_token;
    if (!hashed) throw new UpstreamError('auth:generate_link', 502, 'no_token');
    return {
      hashedToken: hashed,
      type: out?.properties?.verification_type ?? out?.verification_type ?? 'magiclink',
    };
  },
  adminListPasskeys: async (env: Env, userId: string) => {
    const out = await call<GoTruePasskey[] | { passkeys?: GoTruePasskey[] }>(
      env,
      'GET',
      `/admin/users/${encodeURIComponent(userId)}/passkeys`,
      { kind: 'admin' },
    );
    return Array.isArray(out) ? out : (out?.passkeys ?? []);
  },
};

/** Mints a session for an existing user without any user interaction (invite redemption only). */
export async function mintSession(env: Env, email: string): Promise<GoTrueSession> {
  const link = await gotrue.adminMagicLink(env, email);
  return gotrue.verifyTokenHash(env, link.hashedToken, link.type);
}
