/**
 * Which stores exist: the `STORAGE_STORES` var (JSON, validated once per isolate) plus the built-in 'r2'
 * (the PHOTOS binding). Credentials never live in the config, the database or the admin screen: they are
 * Worker secrets named after the store id (docs/setup.md §3.8):
 *
 *   STORE_<ID>_ACCESS_KEY_ID, STORE_<ID>_SECRET                 (every S3 store)
 *   STORE_<ID>_ACCESS_CLIENT_ID, STORE_<ID>_ACCESS_CLIENT_SECRET (tunnel stores: the Access service token)
 *
 * where <ID> is the store id upper-cased with dashes turned into underscores.
 */
import { storeIdSchema } from '@zephyr/shared';
import { z } from 'zod';
import type { Env } from '../env';
import { r2Store } from './r2';
import { type Fetcher, s3Store } from './s3';
import type { ObjectStore } from './types';
import { StoreError } from './types';

const bindingName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const endpoint = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, 'endpoint: http(s) URL without credentials, query or fragment');

const storeSchema = z
  .object({
    id: storeIdSchema,
    name: z.string().min(1).max(80),
    kind: z.enum(['r2', 's3']),
    connection: z.enum(['binding', 'https', 'vpc', 'tunnel']),
    endpoint: endpoint.optional(),
    bucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .optional(),
    region: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    /** R2 bucket binding (kind r2) or Workers VPC service binding (connection vpc). */
    binding: bindingName.optional(),
    pathStyle: z.boolean().optional(),
    costPerTbMonthUsd: z.number().min(0).max(100_000).nullable().optional(),
    egressNote: z.string().max(200).nullable().optional(),
    capacityBytes: z.number().int().positive().nullable().optional(),
    /** The deployment confirms encryption at rest (NFR-SEC-02). */
    encryptionAtRest: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', message: `${s.id}: ${message}` });
    };
    if (s.kind === 'r2') {
      need(s.connection === 'binding', 'r2 stores use connection "binding"');
      need(s.id === 'r2' || !!s.binding, 'r2 stores other than "r2" need a binding');
    } else {
      need(s.connection !== 'binding', 's3 stores use https, vpc or tunnel');
      need(!!s.endpoint && !!s.bucket, 's3 stores need endpoint and bucket');
      const proto = s.endpoint ? new URL(s.endpoint).protocol : '';
      // Plain http only inside the private VPC link; everything on the public internet is TLS.
      need(s.connection === 'vpc' || proto === 'https:', 'https and tunnel endpoints must be https');
      need(s.connection !== 'vpc' || !!s.binding, 'vpc stores need the VPC service binding name');
    }
  });

export type StoreConfig = z.infer<typeof storeSchema>;

const configSchema = z
  .array(storeSchema)
  .max(16)
  .superRefine((list, ctx) => {
    const ids = list.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate store id' });
  });

const R2_DEFAULT: StoreConfig = {
  id: 'r2',
  name: 'Cloudflare R2',
  kind: 'r2',
  connection: 'binding',
  binding: 'PHOTOS',
  costPerTbMonthUsd: 15,
  egressNote: 'No egress fees',
  capacityBytes: null,
  encryptionAtRest: true,
};

let cache: { raw: string; stores: StoreConfig[]; error: string | null } | null = null;

function parseConfig(value: unknown): StoreConfig[] | null {
  try {
    const json = typeof value === 'string' ? (value.trim() ? JSON.parse(value) : []) : (value ?? []);
    const r = configSchema.safeParse(json);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Every configured store, 'r2' first. A STORAGE_STORES that doesn't parse leaves only 'r2' (so photos on R2
 * keep working) and is reported as `config_invalid` by `storeConfigError` and Admin › Storage.
 */
export function storeConfigs(env: Env): StoreConfig[] {
  // A string (a secret-style or `--var` value) or the array itself (a JSON value in wrangler.jsonc vars).
  const value: unknown = env.STORAGE_STORES;
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? []);
  if (cache && cache.raw === raw) return cache.stores;
  const parsed = parseConfig(value);
  if (parsed === null) {
    // The config's content is never logged (it names endpoints and buckets).
    console.error(JSON.stringify({ level: 'error', where: 'storage_config', detail: 'config_invalid' }));
    cache = { raw, stores: [R2_DEFAULT], error: 'config_invalid' };
    return cache.stores;
  }
  const r2Override = parsed.find((s) => s.id === 'r2');
  const r2: StoreConfig = {
    ...R2_DEFAULT,
    ...r2Override,
    kind: 'r2',
    connection: 'binding',
    binding: 'PHOTOS',
  };
  const stores = [r2, ...parsed.filter((s) => s.id !== 'r2')];
  cache = { raw, stores, error: null };
  return stores;
}

export function storeConfigError(env: Env): string | null {
  storeConfigs(env);
  return cache?.error ?? null;
}

export const storeConfig = (env: Env, id: string): StoreConfig | null =>
  storeConfigs(env).find((s) => s.id === id) ?? null;

/** `STORE_<ID>_<NAME>`: the id upper-cased, dashes to underscores. */
export const secretName = (id: string, name: string) =>
  `STORE_${id.toUpperCase().replace(/-/g, '_')}_${name}`;

const bag = (env: Env) => env as unknown as Record<string, unknown>;
function secret(env: Env, id: string, name: string): string {
  const v = bag(env)[secretName(id, name)];
  if (typeof v !== 'string' || !v) throw new StoreError('credentials_missing');
  return v;
}

/** How requests reach the store: the public internet, a Workers VPC binding, or a Tunnel hostname behind Access. */
export function fetcherFor(env: Env, s: StoreConfig): Fetcher {
  if (s.connection === 'vpc') {
    const b = bag(env)[s.binding ?? ''] as { fetch?: (r: Request) => Promise<Response> } | undefined;
    if (!b || typeof b.fetch !== 'function') throw new StoreError('binding_missing');
    return (req) => (b.fetch as (r: Request) => Promise<Response>).call(b, req);
  }
  if (s.connection === 'tunnel') {
    const clientId = secret(env, s.id, 'ACCESS_CLIENT_ID');
    const clientSecret = secret(env, s.id, 'ACCESS_CLIENT_SECRET');
    return (req) => {
      // Added after signing: Access checks and strips them; S3 never sees them in SignedHeaders.
      req.headers.set('CF-Access-Client-Id', clientId);
      req.headers.set('CF-Access-Client-Secret', clientSecret);
      return fetch(req);
    };
  }
  return (req) => fetch(req);
}

const built = new WeakMap<object, { configs: StoreConfig[]; stores: Map<string, ObjectStore> }>();

/** The ObjectStore for a store id. Unknown or misconfigured → StoreError (the routes answer 503 `server`). */
export function storeFor(env: Env, id: string): ObjectStore {
  const configs = storeConfigs(env);
  let perEnv = built.get(env);
  if (perEnv && perEnv.configs !== configs) perEnv = undefined;
  const hit = perEnv?.stores.get(id);
  if (hit) return hit;
  const s = storeConfig(env, id);
  if (!s) throw new StoreError('unknown_store');
  let store: ObjectStore;
  if (s.kind === 'r2') {
    const bucket = bag(env)[s.binding ?? 'PHOTOS'] as R2Bucket | undefined;
    if (!bucket) throw new StoreError('binding_missing');
    store = r2Store(bucket, s.id);
  } else {
    store = s3Store(
      {
        id: s.id,
        endpoint: s.endpoint as string,
        bucket: s.bucket as string,
        region: s.region ?? 'auto',
        pathStyle: s.pathStyle ?? s.connection !== 'https',
      },
      { accessKeyId: secret(env, s.id, 'ACCESS_KEY_ID'), secretAccessKey: secret(env, s.id, 'SECRET') },
      fetcherFor(env, s),
    );
  }
  if (!perEnv) {
    perEnv = { configs, stores: new Map() };
    built.set(env, perEnv);
  }
  perEnv.stores.set(id, store);
  return store;
}

/** The store a photo or upload lives on (`photos.store_id`, `uploads.store_id`; 'r2' when the row predates phase 8). */
export const photoStore = (env: Env, storeId: string | null | undefined): ObjectStore =>
  storeFor(env, storeId || 'r2');

/** Every configured store that can be built (purges and sweeps skip the ones that can't, and report them). */
export function allStores(env: Env): { stores: ObjectStore[]; broken: string[] } {
  const stores: ObjectStore[] = [];
  const broken: string[] = [];
  for (const s of storeConfigs(env)) {
    try {
      stores.push(storeFor(env, s.id));
    } catch {
      broken.push(s.id);
    }
  }
  return { stores, broken };
}

/** Reads `storeId` from a DB function's JSON row, defaulting to 'r2' until the function returns it. */
export const storeIdOf = (row: { storeId?: string | null } | null | undefined): string =>
  row?.storeId || 'r2';
