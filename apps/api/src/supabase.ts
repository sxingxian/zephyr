import type { Env } from './env';

export class UpstreamError extends Error {
  constructor(
    readonly where: string,
    readonly status: number,
  ) {
    super(`${where} failed with ${status}`);
  }
}

/** Calls a Postgres function through PostgREST with the service role. */
export async function rpc<T>(env: Env, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new UpstreamError(`rpc:${fn}`, res.status);
  return (await res.json()) as T;
}
