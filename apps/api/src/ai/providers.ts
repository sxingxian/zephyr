/**
 * Cloud AI providers (docs/phase-6.md, Cloud work). Every call goes through Cloudflare AI Gateway in
 * production, to fixed hosts only: the gateway, or (development without a gateway) the providers' own API
 * hosts. Nothing here takes a URL from a request, a provider response or the database: model ids are
 * checked against strict patterns first. Providers get the photo's preview inline (a data URI), never a
 * link to our storage, and their output is untrusted (see png.ts).
 */
import { type AiSettings, type BgProvider, MASK_LIMITS } from '@zephyr/shared';
import type { Env } from '../env';

export type ProviderError = 'provider_timeout' | 'provider_error' | 'bad_output';
export class ProviderFailure extends Error {
  constructor(
    readonly reason: ProviderError,
    /** Short code for the AI jobs page (no provider message text, which may echo input). */
    readonly code: string,
  ) {
    super(`${reason}: ${code}`);
    this.name = 'ProviderFailure';
  }
}

export interface CallLog {
  provider: BgProvider | 'workers_ai';
  role: 'primary' | 'fallback';
  ok: boolean;
  ms: number;
  error?: string;
}

/** One provider call's timeout. */
export const PROVIDER_TIMEOUT_MS = 30_000;
const RUNWARE_MODEL = /^runware:\d{1,6}@\d{1,4}$/;
const FAL_MODEL = /^fal-ai\/[a-z0-9][a-z0-9/_.-]{1,100}$/;
const SCENE_MODEL = /^@cf\/[a-z0-9][a-z0-9/_.-]{1,100}$/i;
const GATEWAY_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** The AI Gateway base URL, or null when no gateway is configured. */
export function gatewayBase(env: Env): string | null {
  const acct = env.AI_GATEWAY_ACCOUNT_ID?.trim();
  const gw = env.AI_GATEWAY_ID?.trim();
  if (!acct || !gw) return null;
  if (!GATEWAY_PART.test(acct) || !GATEWAY_PART.test(gw))
    throw new ProviderFailure('provider_error', 'gateway_config');
  return `https://gateway.ai.cloudflare.com/v1/${acct}/${gw}`;
}
/** Production never calls a provider directly. */
function base(env: Env): string | null {
  const b = gatewayBase(env);
  if (!b && env.ENVIRONMENT === 'production') throw new ProviderFailure('provider_error', 'no_gateway');
  return b;
}
function gatewayHeaders(env: Env, h: Record<string, string>) {
  if (env.AI_GATEWAY_TOKEN && gatewayBase(env)) h['cf-aig-authorization'] = `Bearer ${env.AI_GATEWAY_TOKEN}`;
  return h;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export function fromBase64(s: string, maxBytes: number): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !B64.test(clean) || (clean.length / 4) * 3 > maxBytes + 3) {
    throw new ProviderFailure('bad_output', 'base64');
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Reads a JSON response body, refusing more than `maxBytes`. */
async function readJson(res: Response, maxBytes: number): Promise<unknown> {
  const len = Number(res.headers.get('Content-Length') ?? '');
  if (Number.isFinite(len) && len > maxBytes) throw new ProviderFailure('bad_output', 'too_large');
  if (!res.body) throw new ProviderFailure('bad_output', 'empty');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderFailure('bad_output', 'too_large');
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new ProviderFailure('bad_output', 'json');
  }
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual',
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError')
      throw new ProviderFailure('provider_timeout', 'timeout');
    throw new ProviderFailure('provider_error', 'network');
  }
}
function httpFailure(status: number): ProviderFailure {
  if (status === 408 || status === 504 || status === 524)
    return new ProviderFailure('provider_timeout', `http_${status}`);
  return new ProviderFailure('provider_error', `http_${status}`);
}

export interface CutoutResult {
  /** The provider's PNG (untrusted). */
  png: Uint8Array;
  /** What the call cost, in micro-dollars, when the provider said so. */
  costMicros: number | null;
}
/** Base64 of the provider's PNG can be at most this long (4/3 of MASK_LIMITS.providerMaxBytes). */
const RESPONSE_MAX = Math.ceil((MASK_LIMITS.providerMaxBytes * 4) / 3) + 64 * 1024;

/** Runware background removal (BiRefNet). The result comes back inline (outputType base64Data): nothing is stored at Runware. */
export async function runwareCutout(
  env: Env,
  s: Pick<AiSettings, 'runwareModel'>,
  image: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<CutoutResult> {
  if (!env.RUNWARE_API_KEY) throw new ProviderFailure('provider_error', 'no_key');
  if (!RUNWARE_MODEL.test(s.runwareModel)) throw new ProviderFailure('provider_error', 'model');
  const b = base(env);
  const url = b ? `${b}/custom-runware/v1` : 'https://api.runware.ai/v1';
  const res = await post(
    url,
    gatewayHeaders(env, { Authorization: `Bearer ${env.RUNWARE_API_KEY}` }),
    [
      {
        taskType: 'removeBackground',
        taskUUID: crypto.randomUUID(),
        model: s.runwareModel,
        inputs: { image: `data:${mime};base64,${toBase64(image)}` },
        outputType: 'base64Data',
        outputFormat: 'PNG',
        includeCost: true,
      },
    ],
    signal,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw httpFailure(res.status);
  }
  const json = (await readJson(res, RESPONSE_MAX)) as { data?: unknown; errors?: unknown };
  const tasks = Array.isArray(json?.data) ? json.data : [];
  const task = tasks.find(
    (t): t is { imageBase64Data: string; cost?: unknown } =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as { imageBase64Data?: unknown }).imageBase64Data === 'string',
  );
  if (!task)
    throw new ProviderFailure(Array.isArray(json?.errors) ? 'provider_error' : 'bad_output', 'no_image');
  const png = fromBase64(task.imageBase64Data, MASK_LIMITS.providerMaxBytes);
  const cost =
    typeof task.cost === 'number' && Number.isFinite(task.cost) && task.cost >= 0 && task.cost < 1
      ? Math.round(task.cost * 1e6)
      : null;
  return { png, costMicros: cost };
}

/** fal (Bria RMBG 2.0). sync_mode returns a data URI, and X-Fal-Store-IO: 0 keeps fal from storing the request. */
export async function falCutout(
  env: Env,
  s: Pick<AiSettings, 'falModel'>,
  image: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<CutoutResult> {
  if (!env.FAL_KEY) throw new ProviderFailure('provider_error', 'no_key');
  if (!FAL_MODEL.test(s.falModel) || s.falModel.includes('..'))
    throw new ProviderFailure('provider_error', 'model');
  const b = base(env);
  const url = b ? `${b}/fal/${s.falModel}` : `https://fal.run/${s.falModel}`;
  const res = await post(
    url,
    gatewayHeaders(env, { Authorization: `Key ${env.FAL_KEY}`, 'X-Fal-Store-IO': '0' }),
    { image_url: `data:${mime};base64,${toBase64(image)}`, sync_mode: true },
    signal,
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw httpFailure(res.status);
  }
  const json = (await readJson(res, RESPONSE_MAX)) as { image?: { url?: unknown } };
  const u = json?.image?.url;
  // Only an inline result is accepted: we never fetch a URL a provider hands back.
  if (typeof u !== 'string' || !u.startsWith('data:image/png;base64,'))
    throw new ProviderFailure('bad_output', 'no_image');
  return {
    png: fromBase64(u.slice('data:image/png;base64,'.length), MASK_LIMITS.providerMaxBytes),
    costMicros: null,
  };
}

export function cutoutCall(p: BgProvider) {
  return p === 'runware' ? runwareCutout : falCutout;
}
export const providerEstimate = (s: AiSettings, p: BgProvider) =>
  p === 'runware' ? s.costs.runwareMicros : s.costs.falMicros;

/** Workers AI image classification for scene tags: [{label, score}], at most 10, sanitised. */
export async function classifyScene(
  env: Env,
  s: Pick<AiSettings, 'sceneModel'>,
  image: Uint8Array,
): Promise<{ label: string; score: number }[]> {
  if (!SCENE_MODEL.test(s.sceneModel) || s.sceneModel.includes('..'))
    throw new ProviderFailure('provider_error', 'model');
  const gw = env.AI_GATEWAY_ID?.trim();
  if (!gw && env.ENVIRONMENT === 'production') throw new ProviderFailure('provider_error', 'no_gateway');
  let out: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    out = await Promise.race([
      env.AI.run(s.sceneModel, { image: [...image] }, gw ? { gateway: { id: gw } } : undefined),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderFailure('provider_timeout', 'timeout')),
          PROVIDER_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof ProviderFailure) throw err;
    throw new ProviderFailure('provider_error', 'workers_ai');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!Array.isArray(out)) throw new ProviderFailure('bad_output', 'shape');
  return out
    .filter(
      (x): x is { label: string; score: number } =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { label?: unknown }).label === 'string' &&
        typeof (x as { score?: unknown }).score === 'number' &&
        Number.isFinite((x as { score: number }).score),
    )
    .slice(0, 10)
    .map((x) => ({ label: x.label.slice(0, 100), score: Math.min(1, Math.max(0, x.score)) }));
}
