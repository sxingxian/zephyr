/**
 * The only module that imports the Stripe SDK (docs/phase-7.md, Billing API). Workers: the fetch HTTP client
 * and SubtleCrypto for webhook signatures. The API version is pinned (STRIPE_API_VERSION, defaulting to the
 * version this SDK release was generated for, so its types match what Stripe returns).
 */
import Stripe from 'stripe';
import type { Env } from '../env';

export { Stripe };
export type StripeClient = Stripe;

/** The API version the installed SDK's types describe. */
export const SDK_API_VERSION = Stripe.API_VERSION;

let factory: ((env: Env) => Stripe) | null = null;
/** Tests inject a mocked client. */
export function setStripeFactory(f: ((env: Env) => Stripe) | null) {
  factory = f;
  cached = null;
}

let cached: { key: string; version: string; client: Stripe } | null = null;

/** The Stripe client, or null while STRIPE_SECRET_KEY isn't set (billing answers 503 billing_unavailable). */
export function stripeClient(env: Env): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  if (factory) return factory(env);
  const version = env.STRIPE_API_VERSION || SDK_API_VERSION;
  if (cached && cached.key === env.STRIPE_SECRET_KEY && cached.version === version) return cached.client;
  const client = new Stripe(env.STRIPE_SECRET_KEY, {
    // The SDK types one literal version; a deliberate override is passed through as-is.
    apiVersion: version as typeof SDK_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 1,
    timeout: 15_000,
    appInfo: { name: 'Zephyr', url: 'https://zephyr.midnightpoetry.studio' },
  });
  cached = { key: env.STRIPE_SECRET_KEY, version, client };
  return client;
}

/** Verifies a webhook's signature (5-minute tolerance) and parses the event. Throws on any mismatch. */
export function verifyWebhook(raw: string, signature: string, secret: string): Promise<Stripe.Event> {
  return Stripe.webhooks.constructEventAsync(
    raw,
    signature,
    secret,
    300,
    Stripe.createSubtleCryptoProvider(),
  );
}

export const isStripeError = (err: unknown): err is InstanceType<typeof Stripe.errors.StripeError> =>
  err instanceof Stripe.errors.StripeError;

/** A Stripe "no such object" (deleted customer or subscription): treated as already gone. */
export const isMissing = (err: unknown) => isStripeError(err) && err.code === 'resource_missing';

/** The id of an expandable field. */
export const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === 'string' ? v : v.id;
