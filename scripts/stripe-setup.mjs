#!/usr/bin/env node
/**
 * Stripe setup for Zephyr billing (docs/phase-7.md, Build step 0). Idempotent: run it again any time.
 *
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --test [--webhook-url URL] [--put-secret]
 *   STRIPE_SECRET_KEY=sk_live_… node scripts/stripe-setup.mjs --live [--webhook-url URL] [--put-secret]
 *
 * It finds or creates:
 *   - products zephyr_pro, zephyr_studio, zephyr_credits (custom ids), tax code TAX_CODE;
 *   - the seven prices by lookup key, at the seed amounts if missing (existing prices are kept as they are:
 *     after launch, prices change only in Admin › Plans & billing);
 *   - the default customer-portal configuration (payment method, invoices, address, cancel at period end;
 *     plan switching off, because plan changes happen in the app);
 *   - the webhook endpoint with the event list below, on the SDK's API version.
 *
 * With SUPABASE_URL and SUPABASE_SECRET_KEY also set, it swaps the database's seeded placeholder prices
 * (price_seed_*) for the real ids through admin_price_set(p_seed := true).
 *
 * Never prints keys or the webhook signing secret. --put-secret pipes a newly created endpoint's secret
 * straight into `wrangler secret put STRIPE_WEBHOOK_SECRET` for apps/api.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The SDK is a dependency of apps/api; resolve it from there.
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const StripeMod = require('stripe');
const Stripe = StripeMod.default ?? StripeMod.Stripe ?? StripeMod;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const mode = flag('--live') ? 'live' : flag('--test') ? 'test' : null;
/** Read at run time only (a local script; not a Turborepo task input). */
const envVar = (name) => process.env[name];
const KEY = envVar('STRIPE_SECRET_KEY');
if (!mode || flag('--live') === flag('--test') || !KEY) {
  console.error(
    'Usage: STRIPE_SECRET_KEY=… node scripts/stripe-setup.mjs --test|--live [--webhook-url URL] [--put-secret]',
  );
  process.exit(2);
}
if (!new RegExp(`^(sk|rk)_${mode}_`).test(KEY)) {
  console.error(`STRIPE_SECRET_KEY is not a ${mode}-mode key. Nothing was changed.`);
  process.exit(2);
}
const APP_URL = opt('--app-url', 'https://zephyrapp.midnightpoetry.studio').replace(/\/$/, '');
const WEBHOOK_URL = opt('--webhook-url', `${APP_URL}/api/v1/stripe/webhook`);
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/api\/v1\/stripe\/webhook$/.test(WEBHOOK_URL)) {
  console.error('--webhook-url must be https://<host>/api/v1/stripe/webhook');
  process.exit(2);
}

/**
 * SaaS, business use. Confirm in the dashboard that it's accepted for Managed Payments; change it here and
 * on the products if Stripe suggests another.
 */
const TAX_CODE = 'txcd_10103001';
const PRODUCTS = [
  { id: 'zephyr_pro', name: 'Zephyr Pro', description: 'Zephyr Pro plan' },
  { id: 'zephyr_studio', name: 'Zephyr Studio', description: 'Zephyr Studio plan, with team seats' },
  {
    id: 'zephyr_credits',
    name: 'Zephyr cloud credits',
    description: 'Zephyr AI cloud credits (valid 12 months)',
  },
];
/** Seed prices (US cents). Must match the database seed (docs/phase-7.md). */
const PRICES = [
  { key: 'zephyr_pro_monthly', product: 'zephyr_pro', amount: 999, plan: 'pro', interval: 'month' },
  { key: 'zephyr_pro_yearly', product: 'zephyr_pro', amount: 9900, plan: 'pro', interval: 'year' },
  { key: 'zephyr_studio_monthly', product: 'zephyr_studio', amount: 2499, plan: 'studio', interval: 'month' },
  { key: 'zephyr_studio_yearly', product: 'zephyr_studio', amount: 24900, plan: 'studio', interval: 'year' },
  { key: 'zephyr_topup_500', product: 'zephyr_credits', amount: 500, credits: 500 },
  { key: 'zephyr_topup_1000', product: 'zephyr_credits', amount: 1000, credits: 1000 },
  { key: 'zephyr_topup_2500', product: 'zephyr_credits', amount: 2500, credits: 2500 },
];
/** Must match WEBHOOK_EVENTS in apps/api/src/billing/webhook.ts (a test checks). */
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'subscription_schedule.created',
  'subscription_schedule.updated',
  'subscription_schedule.released',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.aborted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

const stripe = new Stripe(KEY, { maxNetworkRetries: 2, appInfo: { name: 'Zephyr setup' } });
const log = (...m) => console.log(...m);

async function ensureProducts() {
  for (const p of PRODUCTS) {
    let product = null;
    try {
      product = await stripe.products.retrieve(p.id);
    } catch (err) {
      if (err?.code !== 'resource_missing') throw err;
    }
    if (!product) {
      product = await stripe.products.create({
        id: p.id,
        name: p.name,
        description: p.description,
        tax_code: TAX_CODE,
        metadata: { zephyr: '1' },
      });
      log(`product  ${p.id}: created`);
    } else {
      if (product.tax_code !== TAX_CODE || !product.active) {
        await stripe.products.update(p.id, { tax_code: TAX_CODE, active: true });
      }
      log(`product  ${p.id}: ok`);
    }
  }
}

async function ensurePrices() {
  const ids = {};
  for (const p of PRICES) {
    const found = await stripe.prices.list({ lookup_keys: [p.key], limit: 1 });
    let price = found.data[0];
    if (!price) {
      price = await stripe.prices.create(
        {
          product: p.product,
          currency: 'usd',
          unit_amount: p.amount,
          lookup_key: p.key,
          tax_behavior: 'exclusive',
          ...(p.interval ? { recurring: { interval: p.interval } } : {}),
          metadata: p.plan ? { plan: p.plan, interval: p.interval } : { credits: String(p.credits) },
        },
        { idempotencyKey: `setup:${p.key}:${p.amount}` },
      );
      log(`price    ${p.key}: created ${price.id} (US$${(p.amount / 100).toFixed(2)})`);
    } else {
      log(`price    ${p.key}: ${price.id} (US$${((price.unit_amount ?? 0) / 100).toFixed(2)})`);
      if (p.plan && (price.metadata?.plan !== p.plan || price.metadata?.interval !== p.interval)) {
        await stripe.prices.update(price.id, { metadata: { plan: p.plan, interval: p.interval } });
      }
    }
    ids[p.key] = { id: price.id, amount: price.unit_amount ?? p.amount };
  }
  return ids;
}

async function ensurePortal() {
  const params = {
    business_profile: {
      headline: 'Zephyr by Midnight Poetry Studio',
      privacy_policy_url: 'https://zephyr.midnightpoetry.studio/privacy',
      terms_of_service_url: 'https://zephyr.midnightpoetry.studio/terms',
    },
    default_return_url: `${APP_URL}/settings/billing`,
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      // Email stays the Zephyr account's; members change it in Zephyr.
      customer_update: { enabled: true, allowed_updates: ['address', 'tax_id'] },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
        },
      },
      // Plan changes happen in the app (the portal can't downgrade across products at period end).
      subscription_update: { enabled: false },
    },
    metadata: { zephyr: '1' },
  };
  const existing = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  const cfg = existing.data[0];
  if (cfg) {
    await stripe.billingPortal.configurations.update(cfg.id, params);
    log(`portal   ${cfg.id}: updated`);
  } else {
    const created = await stripe.billingPortal.configurations.create(params);
    log(`portal   ${created.id}: created`);
  }
}

async function ensureWebhook() {
  let endpoint = null;
  for await (const e of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (e.url === WEBHOOK_URL) {
      endpoint = e;
      break;
    }
  }
  if (endpoint) {
    await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    log(`webhook  ${endpoint.id}: events updated (API version ${endpoint.api_version ?? 'account default'})`);
    if (endpoint.api_version && endpoint.api_version !== Stripe.API_VERSION) {
      log(
        `         note: the SDK expects ${Stripe.API_VERSION}; recreate the endpoint to change its version.`,
      );
    }
    return;
  }
  const created = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: WEBHOOK_EVENTS,
    // Event payloads in the shape the SDK's types describe.
    api_version: Stripe.API_VERSION,
    description: 'Zephyr API',
  });
  log(`webhook  ${created.id}: created for ${WEBHOOK_URL}`);
  if (flag('--put-secret') && created.secret) {
    const r = spawnSync(
      'pnpm',
      ['--filter', '@zephyr/api', 'exec', 'wrangler', 'secret', 'put', 'STRIPE_WEBHOOK_SECRET'],
      {
        input: `${created.secret}\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    log(
      r.status === 0
        ? '         STRIPE_WEBHOOK_SECRET stored with wrangler.'
        : '         wrangler failed: store the secret by hand (below).',
    );
    if (r.status === 0) return;
  }
  log(
    '         Reveal its signing secret in the Stripe Dashboard (Developers › Webhooks › this endpoint), then:',
  );
  log('         cd apps/api && npx wrangler secret put STRIPE_WEBHOOK_SECRET');
}

/** Replaces the database's seeded placeholder ids (price_seed_*) with the real ones. */
async function updateDatabase(ids) {
  const url = envVar('SUPABASE_URL');
  const key = envVar('SUPABASE_SECRET_KEY');
  if (!url || !key) {
    log('database: skipped (set SUPABASE_URL and SUPABASE_SECRET_KEY to replace the seeded price ids)');
    return;
  }
  const rpc = async (fn, body) => {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.split('.').length === 3) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${fn} failed with ${res.status}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };
  const current = (await rpc('billing_prices_current', {})) ?? [];
  for (const p of PRICES) {
    const row = current.find((r) => r.lookupKey === p.key);
    const real = ids[p.key];
    if (row?.stripePriceId === real.id) continue;
    if (row && !String(row.stripePriceId).startsWith('price_seed_')) {
      log(
        `database ${p.key}: has ${row.stripePriceId}, Stripe has ${real.id}; left alone (change prices in Admin)`,
      );
      continue;
    }
    await rpc('admin_price_set', {
      p_staff: null,
      p_lookup_key: p.key,
      p_stripe_price_id: real.id,
      p_amount: real.amount,
      p_reason: 'stripe-setup',
      p_seed: true,
    });
    log(`database ${p.key}: now ${real.id}`);
  }
}

try {
  log(`Stripe ${mode} mode, SDK API version ${Stripe.API_VERSION}`);
  await ensureProducts();
  const ids = await ensurePrices();
  await ensurePortal();
  await ensureWebhook();
  await updateDatabase(ids);
  log('Done. Next: docs/phase-7.md › Build step 0, step 2 (check Managed Payments in test mode).');
} catch (err) {
  // Stripe errors carry a type and code; never the request (no keys).
  console.error(`Setup failed: ${err?.type ?? err?.name ?? 'error'}${err?.code ? ` (${err.code})` : ''}`);
  process.exit(1);
}
