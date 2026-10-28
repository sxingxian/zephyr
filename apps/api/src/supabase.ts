import { type Env, secretKey, supabaseHeaders, supabaseUrl } from './env';

export class UpstreamError extends Error {
  constructor(
    readonly where: string,
    readonly status: number,
    /** Upstream error code (e.g. GoTrue's error_code), never its message, which may echo user input. */
    readonly code?: string,
  ) {
    super(`${where} failed with ${status}${code ? ` (${code})` : ''}`);
  }
}

/** Calls a Postgres function through PostgREST with the secret (service-role) key. */
export async function rpc<T>(env: Env, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${supabaseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(secretKey(env)), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new UpstreamError(`rpc:${fn}`, res.status);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
