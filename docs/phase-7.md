# Phase 7: Billing and Studio teams

Mockups:
- **PWA desktop canvas, row "Billing & teams (phase 7)":**
  - Plans (monthly, yearly), Checkout confirming, Welcome to Pro.
  - Plan & billing: normal, payment due with a price notice, downgrade scheduled.
  - Upgrade (prorated, due today), Downgrade warning, Top-up credits, Library read-only after a lapse.
  - Team (seats, roles, invite), library switcher, a Viewer's library, a teammate's Plan & billing, invite accept.
- **Phone canvas, row "Billing & teams":** Plan & billing, Team, library switcher, Plans.
- **Admin canvas, row "Plans & billing · phase 7":** Plans & billing (KPIs, prices, price changes, payment due, webhook events) and Change a price.

Contract: `packages/shared/src/billing-types.ts` (browser-safe) and `billing-schemas.ts` (zod, API only). Also:
- the new error codes `library_unavailable`, `role_forbidden`, `library_read_only`, `billing_unavailable`;
- `CreditBalance.monthlyBalance` and `.topUps`, and the credit reasons `plan_change`, `top_up_expiry`, `top_up_refund`;
- `plans.ts` prices without brackets (build-time fallbacks only).

Decisions (14 November):
- **Tax and payments:** Stripe Managed Payments. Link (Stripe) is the merchant of record and handles sales tax, VAT and GST worldwide for +3.5% per successful transaction. Customers pay in their local currency (Adaptive Pricing). It can't be added to existing subscriptions later, so it's on from the first sale.
- **Seats:** built now. A teammate keeps their own library and switches into the Studio owner's library.
- **Roles:**
  - **Owner:** billing, seats, deleting forever and emptying Trash, face grouping on or off.
  - **Editor:** upload, edit, Zephyr AI (spends the owner's credits), galleries, move to Trash.
  - **Viewer:** view and download.
- **Prices are set in Admin › Plans & billing.** A new price creates a new Stripe Price and moves the lookup key, so new sign-ups pay it at once.
- **Existing subscribers move at their next renewal after a notice email.** A rise waits for the first renewal at least 30 days after the notice; a drop applies at the next renewal. Raising a price needs a passkey sign-in in the last 10 minutes and emails every Owner. A change can be stopped for anyone not yet moved.
- **After a lapse or downgrade, over the new plan's limits:** live galleries stay up until they expire, but no new galleries or extensions. The library becomes read-only (view, download, Trash and delete) until it's back under the plan's storage.
- **Defaults chosen in the plan:**
  - No trial at launch.
  - Top-up credits last 12 months and are spent after the month's credits.
  - Packs: 500 for US$5, 1,000 for US$10, 2,500 for US$25 (the 2,500 pack is off at launch).
  - Seed prices: Pro US$9.99 a month or US$99 a year; Studio US$24.99 a month or US$249 a year.

Professional notes (changes from the plan doc, with reasons):
- **Plan changes happen in the app, not the Stripe portal.** The portal only schedules downgrades between prices of the same product, and Pro and Studio are separate products. The app calls the Subscriptions API instead:
  - upgrade now with `proration_behavior: always_invoice` and `payment_behavior: pending_if_incomplete`, so nothing changes unless the proration is paid;
  - downgrade at the period end with a subscription schedule.

  The portal still handles the payment method, invoices, billing address, and cancel or resume.
- **Verify in Stripe test mode first (build step 0):** do Managed Payments subscriptions accept item updates, proration invoices, subscription schedules and price swaps through the API? If any of these is refused:
  - upgrades fall back to "cancel at period end and buy the new plan in Checkout";
  - price moves fall back to Stripe's own price-change flow, if Managed Payments offers one.

  Also confirm whether Link sends its own price-change notices, so customers don't get two emails.
- **Webhooks never trust event order.** Every subscription event re-reads the subscription from Stripe and stores it with the time it was read. An older read never overwrites a newer one, so retries and out-of-order delivery are harmless.
- **Galleries keep their watermark after a lapse.** Phase 5 works out a gallery's extras from the owner's live plan, so a lapse would silently turn off watermarks on client proofs. Losing full-size downloads, favourites or branding is fine; losing protection isn't. `_gallery_effective` keeps `x_watermark` on even when the plan no longer has it.
- **Deleting a lapsed library after a year is not automatic.** Deleting a customer's photos must not run unattended. The 1-year retention is policy for now; phase 8 adds an admin-reviewed deletion queue with emails at 30 and 7 days.
- **Credits follow the subscription's billing month.** On a yearly plan the month's credits arrive in monthly slices counted from the renewal date. An upgrade mid-period adds the difference in monthly credits at once (`plan_change`); a downgrade takes effect with the next period's grant.
- **Billing is personal.** Plan & billing always shows the signed-in member's own plan, whichever library is open. Only an owner pays for their team; teammates see "Tan Studio's plan is managed by Mei Lin".

## Build step 0: Stripe test mode (before any billing code merges)

Keys: a restricted key with write access to Checkout Sessions, Customers, Subscriptions, Subscription Schedules, Invoices (read + preview), Prices, Products, Billing Portal, and read access to Charges, Disputes and Events.

Steps:
1. `scripts/stripe-setup.mjs --test`:
   - creates the products `zephyr_pro`, `zephyr_studio` and `zephyr_credits` with a tax code compatible with Managed Payments (`txcd_10103001`, SaaS business use; confirm this in the dashboard);
   - creates the seven prices with their lookup keys;
   - configures the portal (payment method, invoices, address, cancel at period end; plan switching off);
   - creates the webhook endpoint for the events listed below.

   It's idempotent: it finds existing objects by lookup key or metadata.
2. In test mode, check and record the answers in this doc: Checkout subscription with `managed_payments: { enabled: true }`, then item update with proration, `invoices.createPreview`, schedule from subscription, and item price swap with `proration_behavior: none`.
3. Also check (added after the security review):
   - **Refunds and disputes of top-ups:** do `charge.refunded` and `charge.dispute.created` reach our endpoint under Managed Payments, and do they carry the `payment_intent` of the top-up's Checkout session? Does `checkout.sessions.list({ payment_intent })` find the session? (If neither, credits of refunded top-ups are never removed: key refunds on whatever Managed Payments does send.)
   - **Duplicate purchases:** can we cancel a Managed Payments subscription at once and refund its invoice through `invoicePayments.list` + `refunds.create`, or does Link handle refunds?
   - **Schedules:** Stripe refuses `cancel_at_period_end` on a subscription managed by a schedule, so deletion releases the schedule first; confirm. Can a schedule be created while an update waits for payment (`pending_update`)? If not, an upgrade waiting for payment drops a scheduled downgrade (logged as `billing_schedule_restore`).
   - **Expiring Checkouts:** `checkout.sessions.expire` on a Managed Payments session.
   - **Customer deletion:** `customers.del` on a customer whose purchases Link sold as merchant of record (account purge deletes it for privacy).

## Data model (migration `20261114100000_billing.sql`, `20261114100100_teams.sql`)

All new tables have RLS on with no grants to anon or authenticated. All access goes through SECURITY DEFINER functions with `search_path = ''`, called only by the API with the secret key.

**Billing:**
- **`billing_customers`:** `owner_id` (pk, references auth.users on delete cascade) and `stripe_customer_id` (unique, `^cus_[A-Za-z0-9]+$`).
- **`billing_prices`:** one row per Stripe Price we've used.
  - Columns: `stripe_price_id` (pk), `lookup_key`, `plan_id` (null for packs), `interval` (null for packs), `credits` (packs), `amount` (cents), `currency = 'usd'`, `active` (packs only), `current` (true for exactly one row per lookup key, enforced by a partial unique index), `created_at`, `created_by` (staff).
  - Seeded with placeholder Stripe ids (`price_seed_*`). `stripe-setup.mjs` replaces them through `admin_price_set` with `p_seed := true`.
- **`subscriptions`:** one per owner (`owner_id` pk).
  - Columns: `stripe_subscription_id` (unique), `stripe_customer_id`, `status`, `plan_id`, `interval`, `stripe_price_id`, `item_id`, `current_period_start`, `current_period_end` (timestamptz), `cancel_at_period_end`, `schedule_id`, `scheduled_plan`, `scheduled_interval`, `scheduled_at`, `past_due_since`, `synced_at` (when the API read it from Stripe), `updated_at`.
  - A subscription that ends (`canceled`, `incomplete_expired`) is kept with its status. A new Checkout replaces the row.
- **`billing_events`:** `id` (pk, `evt_…`), `type`, `stripe_created`, `received_at`, `status` (`received`, `processed`, `ignored` or `failed`), `error` (short code, never payload text), `owner_id` (nullable).
  - Rows older than 90 days are deleted by the cron.
  - Never stores the payload.
- **`checkout_sessions`:** `id` (pk, `cs_…`), `owner_id`, `kind`, `lookup_key`, `state` (`pending`, `done` or `failed`), `created_at`. The return page's poll reads it, and only the session's owner can.
- **`credit_topups`:** `id`, `owner_id`, `credits`, `remaining` (≥ 0), `expires_at`, `checkout_session_id` (unique, so a top-up is granted once), `payment_intent_id`, `refunded_at`, `created_at`.
- **Price moves:**
  - **`price_changes`:** `id`, `lookup_key`, `from_amount`, `to_amount`, `to_price_id`, `status` (`notifying`, `moving`, `done` or `stopped`), `reason`, `created_by`, `created_at`, `stopped_at`.
  - **`price_moves`:** `id`, `change_id`, `owner_id`, `stripe_subscription_id`, `from_price_id`, `to_price_id`, `notice_at`, `move_at`, `status` (`pending`, `notified`, `moved`, `skipped` or `stopped`), `moved_at`, `reverted_at`. Unique `(change_id, owner_id)`.
- **`profiles.plan_id`** stays the effective plan the rest of the app reads. Only `billing_apply` (and the daily past-due expiry) writes it for paying members. `profiles.plan_source` is `'stripe'` or `'admin'`, and a Stripe update never overwrites an `admin` plan. **Nothing sets `'admin'` yet:** there is no staff plan override before phase 8. Phase 8's override (Admin › Users) must set `plan_source = 'admin'` (and back to `'stripe'` when it's removed), or a comped account that later subscribes, or gets any Stripe event, has its plan overwritten.
- **Past due:** a `past_due` subscription keeps its plan for at most 21 days from `past_due_since` (`_past_due_grace`), then the plan ends (`billing_apply`, and the daily `billing_past_due_expire` when no event arrives). Credits stop following the subscription's periods at the same time.
- **Two live subscriptions** (two Checkouts paid, e.g. two tabs): `billing_apply` never lets a second plan-keeping subscription replace a stored plan-keeping one; it answers `{ duplicate: true }`. The API checks the stored one in Stripe: if it has in fact ended, that is applied and the newer one takes over; otherwise the newer one is canceled at once and its paid invoice refunded in full (`dup-cancel:` / `dup-refund:` idempotency keys, alert log `billing_duplicate_subscription`). Checkout also expires the member's other open subscription sessions first (`billing_checkout_open`).
- **`ai_jobs.topup_drawn`** (jsonb `{topupId: credits}`): which top-ups a job's charges drew from, so refunds go back there first.
- **`credit_ledger.reason`** check gains `plan_change`, `top_up_expiry` and `top_up_refund`. New unique index: one `plan_change` per `(owner, period_start, label)`.
- **`invite_source`** enum gains `'team'`.

**Teams (`20261114100100_teams.sql`):**
- **`teams`:** `owner_id` (pk) and `name` (default "<display name>'s Studio", ≤ 60).
- **`library_members`:** `owner_id`, `member_id`, `role` (`editor` or `viewer`), `added_at`, `added_by`. pk `(owner_id, member_id)`, with `owner_id <> member_id`. Both foreign keys cascade on user delete.
- **`team_invites`:** `id`, `owner_id`, `invite_id` (references `invites`, the phase-1 table, source `'team'`, so new people sign up through the existing redeem flow even when sign-ups are invite-only), `role`, `created_at`. The email, token hash, expiry and accepted/revoked state live on the `invites` row. Expiry is 7 days.
- **Seats:** `used` = 1 + members + open invites. A member is `suspended` when their position by `added_at` is beyond `plan seats − 1`, or the owner's plan has 1 seat, or the owner's account is pending deletion.

### Functions

| Function                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library_access(p_member uuid, p_owner uuid) → jsonb`                                                                         | `{ role, plan, state }` or null. Self → owner. A member → their role, unless suspended or the owner is deleted or pending deletion (null). Called on every library-scoped request; must be one indexed lookup plus `_library_state`.                                                                                                                                                                                                                                    |
| `_library_state(p_owner) → text`                                                                                              | `read_only` when the owner's storage used > the plan's storage, else `active`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `list_libraries(p_member) → jsonb`                                                                                            | `LibrariesResult.libraries` (own first; suspended ones left out).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `team_get(p_owner) → jsonb`                                                                                                   | `Team`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `team_set_name(p_owner, p_name)`                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `team_invite_create(p_owner, p_email, p_role, p_token_hash) → jsonb`                                                          | Under `_lock_team(owner)`. Checks: plan seats > 1 (`plan_required`), a free seat (`limit_reached`), not the owner's own email, not already a member or invited (`already_member`), the invitee in at most `MAX_TEAM_LIBRARIES` teams. Creates the `invites` row (source `team`, `invited_by` owner, 7 days) and the `team_invites` row. Returns the invite and `existingAccount: boolean`.                                                                              |
| `team_invite_revoke(p_owner, p_id)` / `team_invite_resend(p_owner, p_id, p_token_hash)`                                       | Resend rotates the token hash and extends the expiry.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `team_invite_preview(p_token_hash) → jsonb`                                                                                   | `TeamInvitePreview`, or null for anything unusable.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `team_invite_accept(p_member, p_email, p_token_hash) → jsonb`                                                                 | Email must match (citext) or `invite_invalid`. Seat re-checked under the lock. Marks the invite accepted and inserts the member. Idempotent for the same member.                                                                                                                                                                                                                                                                                                        |
| `redeem_invite_code` / the redeem flow                                                                                        | When the redeemed invite has source `team`, the new account is added to the team in the same transaction (via `team_invite_accept`).                                                                                                                                                                                                                                                                                                                                    |
| `team_member_set_role(p_owner, p_member, p_role)` / `team_member_remove(p_owner, p_member)` / `team_leave(p_member, p_owner)` |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `billing_customer_get(p_owner)` / `billing_customer_set(p_owner, p_customer)`                                                 | Set is insert-only (unique both ways).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `billing_checkout_record(p_owner, p_session, p_kind, p_lookup_key, p_idem)` / `billing_checkout_status(p_owner, p_session)`   | Records the session with its idempotency key.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `billing_checkout_open(p_owner, p_kind, p_idem) → jsonb` / `billing_checkout_poll(p_owner, p_session) → boolean`              | The other open sessions to expire (not the one `p_idem` returns); the return page's self-fetch at most once per 10 s.                                                                                                                                                                                                                                                                                                                                                   |
| `billing_prices_current() → jsonb`                                                                                            | Current price per lookup key (public pricing, Checkout).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `billing_apply(p_owner uuid, p_sub jsonb, p_synced_at timestamptz) → jsonb`                                                   | Under `_lock_billing(owner)`. Ignores the write when `p_synced_at < synced_at`. Upserts the subscription row and works out the effective plan (paid plan when status ∈ `PLAN_KEEPING_STATUSES`, else `free`). Writes `profiles.plan_id` unless `plan_source = 'admin'`. On a plan rise mid-period, grants the `plan_change` credits. On a change to `free`, records `past_due_since = null` and leaves galleries alone. Returns `{ planBefore, planAfter }` for emails. |
| `billing_topup_grant(p_owner, p_session, p_payment_intent, p_lookup_key) → jsonb`                                             | Idempotent on the session id. Credits come from `billing_prices` by lookup key, never from the event. `expires_at = now() + 12 months`. Ledger `top_up`.                                                                                                                                                                                                                                                                                                                |
| `billing_topup_refund(p_payment_intent) → jsonb`                                                                              | Removes the bucket's remaining credits (`top_up_refund`). Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `billing_topup_refund_by_session(p_session) → jsonb`                                                                          | The same, found by Checkout session (no payment intent recorded).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `billing_past_due_expire(p_limit) → jsonb` / `billing_deletion_cancels_due(p_limit) → jsonb`                                  | Daily cron: plans past due beyond 21 days end (`[{ownerId, email}]`); accounts pending deletion whose subscription still renews (`[{ownerId, stripeSubscriptionId}]`).                                                                                                                                                                                                                                                                                                  |
| `billing_event_begin(p_id, p_type, p_created) → text`                                                                         | `new`, `retry` (failed before) or `done`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `billing_event_finish(p_id, p_status, p_error, p_owner)`                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `admin_price_set(p_staff, p_lookup_key, p_stripe_price_id, p_amount, p_reason, p_seed boolean) → jsonb`                       | Moves `current`, and creates a `price_changes` row when subscribers exist and the amount differs.                                                                                                                                                                                                                                                                                                                                                                       |
| `admin_price_preview(p_lookup_key, p_amount)`                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `admin_pack_set(p_staff, p_lookup_key, p_active)`                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `admin_price_change_stop(p_staff, p_id) → jsonb`                                                                              | Returns moves already applied but not yet renewed (the API reverts those in Stripe).                                                                                                                                                                                                                                                                                                                                                                                    |
| `admin_billing_overview() → jsonb`                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `price_moves_due(p_limit) → jsonb`                                                                                            | Sweep: creates `price_moves` for subscriptions whose price amount ≠ the current amount of their key (and no stopped move to that price). `move_at`: a rise gets the first period end ≥ `now() + 30 days`, a drop gets the current period end. Returns moves needing a notice (`pending`) and moves within 48 h of `move_at` (`notified`).                                                                                                                               |
| `price_move_mark(p_id, p_status)`                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Credits (changes to phase 6):
- `_credit_period(p_owner) → (start date, end date)`. Free: the calendar month. Paid: the subscription's billing month (monthly plans: Stripe's period; yearly: the monthly slice containing `now()`).
- `_credits_roll` uses it.
- Balance = `credit_balances.balance` (the month's credits) + the unexpired `remaining` of top-ups.
- Charges draw from the month first, then top-ups by soonest expiry, recording draws in `ai_jobs.topup_drawn`. Refunds return to those top-ups first, then the month.
- The 15-minute cron expires top-ups (`top_up_expiry`).
- `_credits_json` adds `monthlyBalance` and `topUps`.

Account deletion (phase 2 functions):
- Scheduling a deletion: the API reads the stored subscription, releases any schedule (Stripe won't set `cancel_at_period_end` on a scheduled subscription; the scheduled downgrade is dropped), then sets `cancel_at_period_end`. If that fails, the daily cron retries for every account in `billing_deletion_cancels_due`. Restoring undoes our own `cancel_at_period_end` only.
- Purge (`due_account_purges` returns the stored subscription id): the API cancels at once every non-ended subscription the Stripe customer has (not only the tracked one), then deletes the Stripe customer. If Stripe can't be reached, the account waits for the next run.
- Rows cascade. `billing_events.owner_id` is set null.

## Library context (teams) in the API

- A new middleware, `libraryContext`, runs on every library-scoped route group:
  - photos, uploads, albums, edits, recipes, trash, galleries, branding, masks, and AI (jobs, status, faces, people, scenes, cleanup, signals);
  - not on: me, auth, invites, billing, team, libraries.
- It reads `X-Zephyr-Library` (uuid; missing means self) and calls `library_access`. It sets `c.var.library = { ownerId, role, plan, state, self }`. Unknown or suspended → 403 `library_unavailable`.
- Every `p_owner: c.get('session').userId` (or `ownerOf(c)`) in those routes becomes `c.get('library').ownerId`. A grep test in `apps/api` fails the build if `session').userId` appears in a library-scoped route file next to `p_owner`.
- **Role gates:** `requireRole(action)` using `roleCan` → 403 `role_forbidden`.
  - Read routes: `view` (any role).
  - Downloads of originals: `download`.
  - Uploads and copies: `upload`.
  - Edits, recipes, albums, AI jobs: `edit` / `ai`.
  - Galleries and branding: `galleries`.
  - Trash and restore: `trash`.
  - Purge and empty: `purge`.
  - `PATCH /ai/settings` and `DELETE /ai/faces`: `aiSettings`.
  - Device-job claim/progress: `ai` (runner tokens unchanged; leases name the session, not the library).
- **Read-only:** `requireWritable` on upload, copy, edit saves, AI job create, gallery create and gallery extend → 403 `library_read_only`. Trash, restore, purge, album deletes and downloads still work.
- `X-Zephyr-Expected-User` keeps naming the signed-in user (not the library). A team-library request whose expected user isn't the session gets 409 `session_changed` (a tab left open by someone else resets instead of switching).
- **Media URLs:** `<img>` tags and download links can't send headers, so GET and HEAD requests also accept `?library=<ownerId>`, with the same `library_access` check. Writes always need the header. Session cookies are SameSite, so another site can't use this.
- **Viewers get no galleries or branding access at all**, reads included: share links, guest activity and favourites are client data.
- `X-Zephyr-Library` is added to the CORS allowed headers and to `Vary`.
- Media responses stay `private`. Keys are by owner, so a removed member's next request fails at `library_access`.
- **Credits, storage and plan limits are always the library owner's.**
- Face grouping consent stays the owner's: an editor in a team library sees People if the owner turned it on, and the device scanner runs for whoever has the app open in that library with `ai` rights.

## Billing API (`apps/api/src/billing/`, `routes/billing.ts`, `routes/team.ts`, `routes/admin-billing.ts`)

- **Stripe client:** `new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 1, timeout: 15000 })`. One module; nothing else imports `stripe`. `STRIPE_API_VERSION` defaults to the SDK's pinned version (`2026-10-28.endive` with stripe 23.1.0), so the types and webhook payloads match; the webhook endpoint must use the same version.
  - Idempotency keys on every POST: `checkout:<owner>:<kind>:<lookup>:<10-minute bucket>`, `change:<owner>:<subId>:<target>:<minute>`, `move:<moveId>`, `release:<scheduleId>`, `expire:<sessionId>`, `portal:<owner>:<minute>`, `deletion-cancel:` / `deletion-resume:<subId>:<day>`, `purge-cancel:<subId>`, `dup-cancel:` / `dup-refund:`, `restore:`. (DELETEs, like the customer delete, are idempotent in Stripe and take no key.)
  - Missing key → 503 `billing_unavailable`, and `AdminBillingResult.configured = false`.
- **Checkout:** `POST /billing/checkout`, owner of their own library only (billing is personal; the header is ignored here). It:
  1. resolves the price from `billing_prices_current` by lookup key;
  2. gets or creates the customer (email, `metadata.owner_id`; `billing_customer_set`);
  3. creates the session: `mode` subscription or payment, `managed_payments: { enabled: true }`, `line_items: [{ price, quantity: 1 }]`, `client_reference_id: owner`, `metadata: { owner_id, kind, lookup_key }`, `subscription_data.metadata`, `success_url: <app>/billing/return?session_id={CHECKOUT_SESSION_ID}`, `cancel_url: <app>/settings/billing`, `expires_at` +30 min;
  4. records the session with its idempotency key.

  Before creating a subscription session, the member's other open subscription sessions are expired in Stripe (an idempotent retry's own session is kept). If one of them had already completed, it is applied and the answer is 409. 409 `conflict` also when a plan-keeping subscription exists (use change instead), and when `billing_customer_set` doesn't return the customer just created (a lost race): no Checkout ever runs on a customer we didn't store.
- **Return page:** polls `checkoutStatus`. When the webhook hasn't arrived after 10 s, the API retrieves the session itself and applies it through the same code path the webhook uses, so a slow webhook doesn't strand the member. That self-fetch runs at most once per 10 s per session (`billing_checkout_poll`), however fast the page or a script polls.
- **Portal:** `billingPortal.sessions.create({ customer, return_url: <app>/settings/billing })`.
- **Change preview:** `invoices.createPreview` with `subscription_details.items` and `proration_behavior: always_invoice` for an upgrade; the effects come from plan limits and team counts.
- **Change:**
  - **Upgrade:** release any schedule first, then `subscriptions.update(sub, { items: [{ id: item, price }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' })`. If the result has `pending_update`, return the latest invoice's `hosted_invoice_url` as `actionUrl`. If the update fails or waits for payment, the released downgrade is scheduled again (same target, same date), so an unpaid upgrade never silently drops it.
  - **Downgrade:** `subscriptionSchedules.create({ from_subscription })`, then update its phases: current price until `current_period_end`, then the target price, `end_behavior: 'release'`.
  - Then re-read and `billing_apply`.
- **Webhook:** `POST /api/v1/stripe/webhook` takes a raw body (≤ 512 KB) and is outside the Origin, JSON and session middleware. Processing:
  1. Read the body as a stream with a running 512 KB cap (Content-Length alone isn't trusted: it may be absent or wrong), then verify with `constructEventAsync(raw, sig, env.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider())`; failure → 400.
  2. `billing_event_begin`.
  3. Dispatch:
     - `checkout.session.completed` / `async_payment_succeeded` → subscription: retrieve the subscription and apply. Top-up: grant, only when `payment_status = 'paid'`.
     - `checkout.session.async_payment_failed` / `expired` → mark the session failed.
     - `customer.subscription.created`, `updated`, `deleted`, `paused`, `resumed`, `subscription_schedule.*` and `invoice.paid` / `invoice.payment_failed` → retrieve the subscription and apply.
     - `charge.refunded` and `charge.dispute.created` → `billing_topup_refund` for top-up payment intents; when we didn't record the payment intent, the Checkout session is found with `checkout.sessions.list({ payment_intent })` and refunded with `billing_topup_refund_by_session`.
     - Everything else → `ignored`.
  4. Owner: `billing_customers` by customer id; `metadata.owner_id` must match it, else `failed` with `owner_mismatch` and an alert log.
  5. Errors → 500, so Stripe retries; the event is marked `failed`.
- **Cron (daily at 02:10 UTC, from the existing scheduled handler on the matching cron):**
  - `price_moves_due`: send notices (`price_notice` email), then apply moves within 48 h with `subscriptions.update(sub, { items: [{ id, price: to }], proration_behavior: 'none' })`. If the subscription changed plan, interval or status since the notice → `skipped` (`changed`). A move is never marked notified without a sent notice: with no address it stays pending, and once its date passes it is `skipped` (`no_email`).
  - `billing_past_due_expire`: plans past due beyond 21 days end (plan-ended email).
  - `billing_deletion_cancels_due`: accounts pending deletion whose subscription still renews are asked again.
  - **Raises are judged per subscriber:** a new price is a rise when it's above the current price or above what any plan-keeping subscriber on that key pays (e.g. subscribers left on an older price by a stopped change). Preview, set, passkey reauth and the Owners' email all use that rule. A later price doesn't close an earlier change while it has moves applied but not yet renewed, so Stop can still revert them.
  - Stop: revert applied moves whose `move_at` is still in the future.
- **Emails (Resend, `email/billing-templates.ts`, plain HTML + text, escaped):**
  - `team_invite` (to the invitee; link `<app>/team/accept#token=…`, a URL fragment, so the token never reaches a server log or a Referer);
  - `team_removed` (optional; on removal);
  - `price_notice` (to the subscriber: old and new amount, the date, how to cancel);
  - `price_change_owners` (to every staff Owner on a raise, and on stop);
  - `plan_ended` (to the owner: library read-only, galleries until expiry).

  Payment receipts and failed-payment emails come from Stripe/Link.
- **Rate limits:** `BILLING_LIMITER` (namespace 1010; 20 a minute per user) on checkout, portal, change, preview and team writes. `TEAM_INVITE_LIMITER` (1011; 10 per 10 minutes per user) on invite create and resend. Webhooks aren't rate-limited by us (signature first, then work).
- **Secrets:** `STRIPE_SECRET_KEY` (restricted key), `STRIPE_WEBHOOK_SECRET`. Var: `STRIPE_API_VERSION`.

## Admin (`apps/admin`, `routes/admin-billing.ts`)

- **Access:** Plans & billing is visible to Owner, Admin and Finance. Price and pack changes are for Owner and Finance.
  - Raising a price, or turning a pack on, needs `recentPasskey` (403 `reauth_required`, same retry as Admin › Zephyr AI) and emails every Owner.
  - Lowering a price or turning a pack off saves at once and is still audited.
- **Setting a price:**
  1. Create a Stripe Price on the key's product (`unit_amount`, `currency: usd`, `recurring` for plans, `lookup_key`, `transfer_lookup_key: true`, `tax_behavior: 'exclusive'`) with idempotency key `price:<lookup>:<amount>:<staff>:<minute>`.
  2. `admin_price_set`.
  3. Write the audit log entry.
- The page matches the mockup: KPIs, the Prices table with "Changing" rows, payment due, and webhook events (id, type, time, status; no payloads). Plan limits stay on their own page (phase 8 makes them editable).

## Web (`apps/web`)

- **Library store:**
  - `activeLibrary` is kept per tab in `sessionStorage` and validated against `GET /libraries` on start.
  - The API client adds `X-Zephyr-Library` when it isn't self.
  - Switching clears the TanStack query cache, the upload queue (pending uploads are asked about first), the AI scanner, the device runner, cached masks and object URLs, then reloads the library.
  - A 403 `library_unavailable` switches back to the member's own library with a toast.
  - Signing out or a session change resets it (`sessionGuard` registry).
- **Role-aware UI:** hide what `roleCan` says no to; Viewer shows a "View only" chip. Read-only state shows the banner from the mockup and disables upload, edit and AI entry points.
- **Screens:** Plans, Checkout return (poll), Plan & billing, Upgrade and Downgrade dialogs (preview first), Top-up, Team, the switcher in the sidebar and the phone header, and invite accept (`/team/accept?token=…`, token moved out of the URL into memory on load, `Referrer-Policy: no-referrer`).
- Prices come from `BILLING_API.pricing`, never from constants (constants are the loading fallback).

## Landing

`Pricing.astro` renders the `PLANS` fallback at build time. A bundled module script fetches `/api/v1/public/pricing` on the landing host itself (the landing Worker forwards `/api/*` to the API, as for the invite form), so the CSP stays `connect-src 'self'`. The response is validated, a 6-second timeout applies, and any failure or no-JS leaves the built prices.

## Security checklist (for the reviews)

- **Library context:** every library-scoped query uses `c.var.library.ownerId`, which comes only from `library_access`, never from the header directly. There's a role check on every write. A removed member loses access on their next request.
- **Billing ownership:** prices come only from our table by lookup key; the client never sends a price id or amount. Webhook-derived owners must agree with `billing_customers`. Top-up credits come from our price table, not from the event, and are granted once per session.
- **Webhooks:** signature with tolerance; raw body read once with a size cap; idempotent; order-independent (re-read and `synced_at` guard); no payload stored or logged.
- **Stripe calls use idempotency keys.** No Stripe ids or emails in logs. Customer email is sent to Stripe only as the member's account email.
- **Team invites:** token ≥ 256 bits, hashed at rest, single use, 7 days, email-bound. The preview never says why an invite is unusable. Seats are re-checked under a lock at accept time.
- **Plan changes:** `pending_if_incomplete`, so an unpaid upgrade never unlocks Studio.
- **Admin:** price changes need passkey reauth for raises (judged per subscriber), are audited, and email Owners. Amount bounds guard against typos.
- **No double billing:** a second live subscription is canceled and refunded, open Checkouts are expired before a new one, and purge cancels everything on the customer and deletes it.
- **Shared devices:** switching library or session clears every cache for the previous library.

## Tests

- **Shared:** schemas (checkout union, plan change, invite email normalisation, token format, admin price bounds); `roleCan` table.
- **SQL** (`supabase/tests/70_billing_test.sql`, `80_teams_test.sql`, `75_billing_race.sh`):
  - RLS: anon and authenticated can't read any new table;
  - `billing_apply`: plan mapping, the `synced_at` guard, admin-plan protection, `plan_change` grant once;
  - top-up grant once, spend order, refunds back to top-ups, expiry, refund removal;
  - credit periods for monthly and yearly;
  - price sweep (rise ≥ 30 days, drop at next renewal, stop, no re-notice after stop, equal amount skipped);
  - teams: invite seat limits, email match, accept idempotent, suspension beyond seats, removal, leave, the owner-deleted case, `library_access` for each case;
  - race: parallel accepts can't exceed seats; parallel webhook applies keep the newest read.
- **API:**
  - webhook signature (good, bad, stale), duplicate event, out-of-order events, owner mismatch;
  - checkout body to Stripe params (managed payments on, price from the table), 409 when subscribed;
  - change upgrade (pending update → actionUrl) and downgrade (schedule phases);
  - price-move cron with a mocked Stripe;
  - the library middleware (self, editor, viewer, suspended, bad header);
  - the role gate on a write in every library route group;
  - read-only gate;
  - the grep test for `session').userId`.
- **Web:** library switch clears caches and the queue; `library_unavailable` fallback; Plans reads pricing; the upgrade dialog shows the preview; the Viewer hides write actions; the invite accept page.
- **Admin:** the price dialog (preview, reauth retry), pack toggle.

## Launch gates added by this phase

- Run build step 0 in test mode and record the answers here before going live.
- Activate Managed Payments on the live account (Singapore seller) and check the product tax codes.
- Register for Singapore GST only if revenue passes S$1M (Managed Payments doesn't cover domestic Singapore tax).
- Have counsel review the price-change notice and the terms (auto-renewal, cancellation, refunds) for the main markets.
- Use a USD bank account for payouts to avoid the 2% conversion fee.
- **Stripe dunning (Billing › Revenue recovery):** set the final action after the last retry to **"Cancel the subscription"**. Zephyr also ends a plan 21 days after it went past due, whatever Stripe does, but a subscription left `past_due` would still show as payment due.
