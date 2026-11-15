# Deploying Zephyr

Zephyr runs on **Supabase** (Postgres and Auth) and **Cloudflare** (three Workers, R2, Images, Queues, AI Gateway,
Turnstile and Access), with **Resend** for email and **Stripe** for payments. Every production deploy runs from
GitHub Actions on `main` and needs your approval. Allow about two hours the first time, plus the waits on outside
parties (Stripe activation, Cloudflare support, Runware).

| Host                              | Serves                                                           | Worker                    | Built from                                         |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------- | -------------------------------------------------- |
| `zephyr.midnightpoetry.studio`    | Landing page, plus the admin console at `/admin`                 | `zephyr-landing`          | `apps/landing` (with `apps/admin` inside `/admin`) |
| `zephyrapp.midnightpoetry.studio` | The app (PWA)                                                    | `zephyr-app`              | `apps/web`                                         |
| (no public address)               | The API, scheduled jobs and queue consumers                      | `zephyr-api`              | `apps/api`                                         |
| `media.midnightpoetry.studio`     | Guest images, fetched only by the API through Cloudflare's cache | R2 bucket `zephyr-shared` | (no build)                                         |

The API has no URL of its own. The landing and app Workers pass `/api/*` and `/admin/api/*` to it through service
bindings, so the browser only ever talks to its own origin.

**Costs at launch:** Supabase Pro, Cloudflare Workers Paid, Images Paid, R2 storage, Stripe fees
(with Managed Payments +3.5%), Resend, and cloud AI per photo. Turnstile, Access (up to 50 users), AI Gateway and the
CSAM Scanning Tool are free.

Deeper reference for two optional parts: extra photo stores in [setup.md §3.8](setup.md#38-extra-photo-stores-phase-8-storage-switch)
and Google AdSense in [setup.md §3.9](setup.md#39-google-adsense-phase-8-optional-free-plan-only).

## 1. Supabase project

1. Create a project at supabase.com on the **Pro** plan. Choose **Region: Southeast Asia (Singapore)**, or the region
   closest to most members (it can't be changed later), and a strong database password (keep it in your password
   manager).
2. Project Settings › **JWT keys**: switch to the new **asymmetric signing keys**. The API checks sessions against
   the project's JWKS and refuses the legacy HS256 secret.
3. Project Settings › **API keys**: note the **project ref**, the **URL**, the **publishable key** (`sb_publishable_…`)
   and the **secret key** (`sb_secret_…`). Only the API Worker ever holds the secret key.
4. Database › Extensions: enable **pg_cron**. The migrations enable `vector` (pgvector) themselves.
5. Apply the migrations from a computer, or let the Deploy workflow do it (section 6, target `database`):

   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

### Auth settings (Dashboard › Authentication)

`supabase/config.toml` sets these for local runs only. Set the same in the dashboard:

- **Sign In / Providers:** turn **off** "Allow new users to sign up". Accounts are only created by the API after it
  checks an invite.
- **Hooks › Before user created:** Postgres, function `public.hook_before_user_created`. It's a second check that
  refuses any sign-up without a valid invite, even if the setting above is ever switched back on.
- **Email:** OTP length **6**, expiry **600** seconds. Paste `supabase/templates/sign-in-code.html` into the **Magic
  link** template, with the subject "Your Zephyr sign-in code". It shows the code only, no sign-in button.
- **SMTP:** host `smtp.resend.com`, port `465`, user `resend`, password = the Resend SMTP key (section 1b), sender
  `Zephyr <hello@zephyr.midnightpoetry.studio>`.
- **Passkeys:** on. Relying party ID `midnightpoetry.studio`, display name `Zephyr`, origins
  `https://zephyrapp.midnightpoetry.studio,https://zephyr.midnightpoetry.studio`. **Never change the relying party
  ID later**: it invalidates every passkey.
- **URL configuration:** Site URL `https://zephyrapp.midnightpoetry.studio`.
- **Rate limits:** raise the per-IP limits, because every request comes from the API Worker. Leave CAPTCHA off:
  the API checks Turnstile itself.

## 1b. Email (Resend)

1. Create a Resend account and add the domain `zephyr.midnightpoetry.studio`. Add the SPF, DKIM and DMARC records it
   gives you in Cloudflare DNS, and wait for it to verify.
2. Create two API keys, both with sending access for this domain only: one for the API Worker (`RESEND_API_KEY`,
   section 5) and one for Supabase SMTP (section 1).
3. Domain settings: keep **click tracking** and **open tracking** off. Emails carry single-use links (account
   changes, invites, staff invites) with the secret in the address. Click tracking would send them through Resend's
   redirect, and open tracking adds a tracking pixel.

What goes out through Resend: sign-in codes (through Supabase SMTP), invites, team and staff invites, passkey and
account-change links, billing and price-change notices, safety alerts, storage and admin notices to Owners.

## 1c. Stripe

Do everything in **test mode** first, and answer **Build step 0** in [phase-7.md](phase-7.md) before going live.

1. Create the Stripe account for the business and finish activation. Activate **Managed Payments** (Singapore
   seller): Link becomes the merchant of record and handles sales tax, VAT and GST. Set payouts to a **USD bank
   account** to avoid the 2% conversion fee.
2. Developers › API keys › **Create restricted key** with only the permissions listed in phase-7.md, Build step 0.
3. From the repository root, run the setup script. It creates the products, the seven prices with their lookup keys,
   the customer portal configuration and the webhook endpoint
   (`https://zephyrapp.midnightpoetry.studio/api/v1/stripe/webhook`). With the Supabase values it also swaps the
   database's placeholder prices for the real Stripe ids, and `--put-secret` pipes the webhook signing secret into
   the API Worker. It never prints keys and is safe to run again.

   ```bash
   STRIPE_SECRET_KEY=rk_test_… SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_… \
     node scripts/stripe-setup.mjs --test --put-secret
   cd apps/api && pnpm exec wrangler secret put STRIPE_SECRET_KEY   # the restricted key
   ```

4. Billing › Revenue recovery: set the final action after all retries to **Cancel the subscription**. Zephyr also
   ends a plan 21 days after a failed payment either way, but a subscription left past due would keep showing as
   payment due.
5. Check that Managed Payments accepts the product tax codes.
6. Once test mode passes, repeat steps 2–3 with live keys and `--live`, and put the live restricted key in
   `STRIPE_SECRET_KEY`.

Prices are changed later in Admin › Plans & billing, never in the Stripe dashboard: a new price creates a new Stripe
Price and moves the lookup key, and existing subscribers move at renewal after a notice.

## 2. First Owner and staff

Staff can't sign up. Create the first Owner by hand once, in the Supabase SQL editor and the Auth dashboard (full
steps in [supabase/README.md](../supabase/README.md), "Bootstrapping the first Owner"):

1. Let the address through the sign-up hook with a throwaway invite:

   ```sql
   insert into public.invites (email, token_hash, source, expires_at)
   values ('you@midnightpoetry.studio', extensions.digest(gen_random_uuid()::text, 'sha256'), 'admin', now() + interval '1 hour');
   ```

2. Auth › Users › **Add user** › _Create new user_ with that email and **Auto confirm user** ticked.
3. Make the account an Owner:

   ```sql
   insert into public.staff (user_id, role)
   select id, 'owner' from auth.users where email = 'you@midnightpoetry.studio';
   ```

4. After the first deploy (section 6), open `https://zephyr.midnightpoetry.studio/admin`, pass Cloudflare Access
   with the same email, choose **Enrol a passkey**, enter the emailed code and save a passkey. From then on the
   passkey is the only way in.

Staff accounts can't sign in to the app; use a separate email for your own member account. Invite other staff from
Admin › Staff & roles. Add each address to the Access policy (section 3) **before** sending the invite. Invites last
72 hours and work only for the invited address. A second Owner is a good backup.

## 3. Cloudflare Turnstile and Access

`midnightpoetry.studio` must be a zone in the same Cloudflare account as the Workers.

**Turnstile** (Cloudflare dashboard › Turnstile › **Add widget**):

- Hostnames: `zephyr.midnightpoetry.studio` and `zephyrapp.midnightpoetry.studio`
- Mode: Managed
- The **site key** goes in the GitHub variable `TURNSTILE_SITE_KEY` (section 6); the **secret key** is the API
  secret `TURNSTILE_SECRET_KEY` (section 5).

**Access** (Zero Trust › Access › Applications › **Add an application** › Self-hosted; free up to 50 users):

- Application domain: `zephyr.midnightpoetry.studio`, path `admin`
- Policy: **Allow**, include only your staff emails (one-time PIN or your identity provider)
- Copy the **team domain** (`<team>.cloudflareaccess.com`) and the application's **AUD tag** into the GitHub
  variables `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (section 6). The API checks the Access token on every admin
  request and that its email matches the staff account.

## 4. Cloudflare storage and images

1. **Photo library:** R2 › Create bucket `zephyr-photos`, in the location closest to your users. Public access
   **off**, no r2.dev URL: every image is served by the API after it checks who's asking. No API tokens or CORS rules
   are needed, because uploads go through the Worker's binding. Settings › Object lifecycle rules, add two:
   - the whole bucket: abort incomplete multipart uploads after **1 day**;
   - prefix `staging/`: delete objects after **2 days**.
2. **Guest images:** create the bucket `zephyr-shared`, with no r2.dev URL, and connect the custom domain
   `media.midnightpoetry.studio` (proxied). It holds only the re-encoded copies made for guests.
3. **Lock the media host:** Security › WAF › Custom rules › **Create rule**, action **Block**, expression:

   ```
   http.host eq "media.midnightpoetry.studio" and not any(http.request.headers["x-zephyr-media"][*] eq "<MEDIA_HOST_SECRET>")
   ```

   Only the API Worker sends that header (the same value as its `MEDIA_HOST_SECRET`, section 5). A normal browser
   must get 403 from `https://media.midnightpoetry.studio/anything`.
4. **Images:** enable Cloudflare Images and switch to **Images Paid** before launch, so re-encoding never stops when
   the free 5,000 transformations a month run out.
5. **Child-safety scanning:** Caching › Configuration › **CSAM Scanning Tool**: enable it for the zone with a
   monitored email. **Launch gate:** ask Cloudflare support to confirm in writing that images the API Worker fetches
   from `media.midnightpoetry.studio` through the cache are scanned, and record the answer and date under
   "Child-safety alerts" below.

## 4b. Zephyr AI (cloud features)

On-device features need nothing here. These are for background removal and scene tags:

1. **AI Gateway:** AI › AI Gateway › create `zephyr-prod`. Turn on **Authenticated Gateway** and create a token
   (`AI_GATEWAY_TOKEN`); turn on logs. In production the API never calls a provider except through this gateway.
2. **Runware** (background removal, default): create an API key (`RUNWARE_API_KEY`). In the gateway, add a **Custom
   Provider** with the slug `runware` and base URL `https://api.runware.ai`. Ask Runware sales to turn on **Zero Data
   Retention** for the organisation before launch.
3. **fal** (fallback): create an API key (`FAL_KEY`). fal is a native gateway provider; every call asks fal not to
   store the request.
4. **Workers AI** (scene tags): nothing to create. Measure the cost per tag in week 1 and set it in Admin › Zephyr AI.
5. **Queues** (once, from `apps/api`):

   ```bash
   pnpm exec wrangler queues create zephyr-ai
   pnpm exec wrangler queues create zephyr-ai-dlq
   pnpm exec wrangler queues create zephyr-storage       # storage switch; create it even if you stay on R2
   pnpm exec wrangler queues create zephyr-storage-dlq
   ```

6. **Bake-off (launch gate):** with `RUNWARE_API_KEY` and `FAL_KEY` set in your shell, run
   `node scripts/bakeoff.mjs <folder of up to 50 JPEGs> <output folder>`. Open `index.html` in the output, compare
   the masks side by side, and set the winner in Admin › Zephyr AI.

## 5. Worker secrets and settings

Set secrets once with `wrangler secret put` from the Worker's folder (it asks for the value; nothing is written to
disk). Make random values with `openssl rand -base64 48` unless noted. **Never put a secret in `wrangler.jsonc`, a
`.env` file, a GitHub variable or the repository.**

**API Worker** (`cd apps/api`):

| Secret                                           | What it is                                                                                           | Rotating it later                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `SUPABASE_SECRET_KEY`                            | Supabase secret key (section 1)                                                                      | Safe; rotate in Supabase first                                |
| `TURNSTILE_SECRET_KEY`                           | Turnstile secret (section 3)                                                                         | Safe                                                          |
| `RESEND_API_KEY`                                 | Resend sending key (section 1b)                                                                      | Safe                                                          |
| `SESSION_HMAC_SECRET`                            | Signs the admin idle timer and hashes account-change link tokens                                     | Locks every admin session and voids open account-change links |
| `IP_HASH_SECRET`                                 | Hashes network addresses for rate limits                                                             | Resets rate-limit counters                                    |
| `GALLERY_PEPPER`                                 | Gallery passcode check                                                                               | **Breaks every gallery passcode**                             |
| `GALLERY_LINK_KEY`                               | Exactly 32 bytes: `openssl rand -base64 32`                                                          | **Loses "Copy link" for existing galleries**                  |
| `GUEST_COOKIE_SECRET`                            | Signs guest sessions                                                                                 | Signs every guest out                                         |
| `MEDIA_URL_SECRET`                               | Signs guest image links                                                                              | Expires every guest image link                                |
| `MEDIA_HOST_SECRET`                              | Must match the WAF rule (section 4)                                                                  | Change both together                                          |
| `RUNWARE_API_KEY`, `FAL_KEY`, `AI_GATEWAY_TOKEN` | Zephyr AI (section 4b)                                                                               | Safe                                                          |
| `STRIPE_SECRET_KEY`                              | Restricted key (`rk_…`, section 1c)                                                                  | Safe                                                          |
| `STRIPE_WEBHOOK_SECRET`                          | Webhook signing secret (`whsec_…`), set by the setup script                                          | Safe, with the endpoint                                       |
| `AD_DEDUP_SECRET`                                | Keys the per-member ad event dedup hash; never the same as `IP_HASH_SECRET`                          | Resets today's ad dedup                                       |
| `ADS_COOKIE_SECRET`                              | Signs the AdSense cookie; **the same value on the app Worker**                                       | Drops AdSense until both match                                |
| `STORE_<ID>_…`                                   | Only for extra photo stores ([setup.md §3.8](setup.md#38-extra-photo-stores-phase-8-storage-switch)) | Per store                                                     |

**App Worker** (`cd apps/web`): `ADS_COOKIE_SECRET`, the same value as the API's. Without it, AdSense never loads
(every page keeps the strict security policy).

**Landing Worker:** no secrets.

**Settings kept in `apps/api/wrangler.jsonc`** (committed; change them by commit before deploying): `EMAIL_FROM`,
`SAFETY_ALERT_EMAIL` (a monitored inbox for child-safety matches and reports), `MEDIA_HOST`, `AI_GATEWAY_ID`
(`zephyr-prod`), the allowed origins, and `STORAGE_STORES` if you add stores. The Deploy workflow fills in
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `AI_GATEWAY_ACCOUNT_ID` from
GitHub variables, so the placeholders in the file never reach production.

## 6. GitHub and the Deploy workflow

Workers are deployed by **Actions › Deploy**, not by Cloudflare's Git integration.

> **Don't connect the Workers to Git in the Cloudflare dashboard.** That would deploy on every push without your
> approval, skip the API's tests before deploying, and leave the API with the placeholder Supabase and Access
> settings, because only the workflow passes them in.

**One-time setup** (repository › Settings):

1. **Cloudflare API token** (Cloudflare › My Profile › API Tokens › Create custom token) with only: _Workers Scripts:
   Edit_, _Workers Routes: Edit_, _Workers R2 Storage: Edit_, _Queues: Edit_, _AI Gateway: Read_ and _Zone: Read_ on
   `midnightpoetry.studio`.
2. **Supabase access token:** supabase.com › Account › Access Tokens › generate one named `github-deploy`.
3. Environments › **production**:
   - **Secrets:** `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.
   - **Variables:** `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
     `TURNSTILE_SITE_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
   - **Deployment branches:** `main` only. **Required reviewers:** you (and a second Owner if you have one).
4. Branches: protect `main` and require the CI checks to pass. Work lands on `main` only by fast-forward after CI.

**Each time:** Actions › **Deploy** › Run workflow, choose the target, then approve the run.

| Target     | What it does                                                                               |
| ---------- | ------------------------------------------------------------------------------------------ |
| `all`      | Database migrations, then the API (its tests run first), then the landing page and the app |
| `database` | `supabase db push` only                                                                    |
| `api`      | Tests, then deploys `zephyr-api` with its settings                                         |
| `landing`  | Builds the landing page and admin console, deploys `zephyr-landing`                        |
| `app`      | Builds the app, deploys `zephyr-app`                                                       |

The order matters on a first deploy: the API must exist before the landing and app Workers, which bind to it.
Deploys run from `main` only, one at a time.

## 7. Custom domains and DNS

Each Worker's `wrangler.jsonc` claims its host as a Worker custom domain, so the first deploy creates the DNS record
and certificate. If a host is still attached to something else (an earlier Pages project, a DNS record), remove it
there first. `media.midnightpoetry.studio` is attached to the `zephyr-shared` bucket (section 4).

Keep the orange-cloud proxy on everywhere. `workers_dev` and preview URLs are off, so the Workers answer only on
their own hosts.

## 8. After the first deploy

- [ ] Sign in to `/admin` as the Owner (section 2), then turn on **Pause all new sign-ups** in Admin › Sign-ups &
  invites until launch.
- [ ] Invite a test member account to yourself. Sign in with an email code, then add a passkey from the emailed link.
  It must open `/account-action/…` on the app.
- [ ] Upload JPEGs and a RAW file, edit one, export it, move it to Trash and restore it.
- [ ] Share a gallery with a passcode and open it in a private window. The guest image has no EXIF data, and an
  original over 70 MB downloads at full size.
- [ ] `https://media.midnightpoetry.studio/anything` answers 403 in a normal browser.
- [ ] Remove the background of one photo. The cut-out appears, and Admin › AI jobs and today's spend both move.
- [ ] Admin › Storage › R2 › **Run check** passes.
- [ ] Stripe test mode: buy Pro monthly with card `4242 4242 4242 4242`, then upgrade, downgrade, buy a top-up, and
  cancel in the portal. Check Admin › Plans & billing shows the webhook events with no failures.
- [ ] Sign out, sign in as another member on the same browser, and check nothing from the first account shows.
- [ ] Install the app on an iPhone (Share › Add to Home Screen) and an Android phone. Turn on flight mode: the app
  shows its offline page.
- [ ] Run `https://securityheaders.com` against both hosts. You should get an A.
- [ ] Have counsel review the privacy notice and terms before turning sign-ups back on.

The full pre-launch list, with owners, is in the launch checklist in the project.

## Scheduled jobs

All run in the API Worker (`triggers.crons` in `apps/api/wrangler.jsonc`), in UTC:

| Schedule         | Jobs                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every 15 minutes | Library clean-up (Trash, deleted accounts, abandoned uploads, leftover files, staged variants on other stores), Zephyr AI queue upkeep, plan-limit versions coming into force, plan override expiries, approved retention batches |
| Every 5 minutes  | Photo store health checks and storage migration batches                                                                                                                                                                           |
| 02:10 daily      | Price moves for existing subscribers                                                                                                                                                                                              |
| 02:20 daily      | Retention sweep and its notices, sponsored card status                                                                                                                                                                            |

One database job runs in Supabase's pg_cron: `zephyr-purge-invite-requests` at 03:17 UTC daily.

## Extra photo stores (optional)

R2 is always there. To add another S3-compatible store, in the cloud or on premises, follow
[setup.md §3.8](setup.md#38-extra-photo-stores-phase-8-storage-switch). In short: create a private bucket and a key
limited to it, confirm encryption at rest, declare the store in `STORAGE_STORES`, set its `STORE_<ID>_…` secrets,
deploy, then run the check in Admin › Storage. The switch needs an Owner's passkey and emails every Owner. On-premises
stores connect through Workers VPC (default) or a Tunnel hostname behind an Access service token; no port is opened
to the internet.

## Google AdSense (optional, Free plan)

AdSense starts **off**, and the recommendation is to keep it off at launch: its script runs inside the app page for
Free members (`docs/security.md` item 18). Before an Owner turns it on in Admin › Ads, follow
[setup.md §3.9](setup.md#39-google-adsense-phase-8-optional-free-plan-only):

- site approval;
- Google's consent message for the EEA, UK and Switzerland;
- Auto ads off;
- both ad secrets set;
- the real-browser popup check in Chrome, Safari and Firefox;
- counsel review.

`/ads.txt` is generated by the app Worker. Sponsored cards need none of this.

## Child-safety alerts

Scanner matches and guest reports email `SAFETY_ALERT_EMAIL` and land in Admin › Safety. A matched photo is held
everywhere and the account's sharing is suspended pending review.

**Before launch, write the reporting procedure here, with counsel:**

- who reviews;
- which authority receives reports, and how;
- what is recorded on the hold (authority and reference);
- how long held material is kept.

Also record Cloudflare's written confirmation that the media path is scanned (section 4), with its date.

## Rolling back

- **Workers:** Cloudflare › the Worker › Deployments › **Rollback**, or
  `pnpm exec wrangler rollback` from its folder. Roll back the landing and app Workers before the API if a release
  changed what they expect from it.
- **Database:** migrations only go forward. Fix a bad migration with a new one, through CI and the Deploy workflow.
  Supabase Pro keeps daily backups (Database › Backups) for anything worse.
- **A photo store switch:** Admin › Storage › **Roll back** while old copies are still held (7 days).

## Local development

See the README for the commands. For the Workers:

- Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars`. Turnstile test keys: site `1x00000000000000000000AA`,
  secret `1x0000000000000000000000000000000AA` (always pass). The landing and app dev servers use the test site key
  when none is set.
- `CF_ACCESS_DEV_EMAIL` lets you use /admin locally without Access. It only works when `ENVIRONMENT=development`
  and the request is to localhost.
- To try AdSense locally, put the same `ADS_COOKIE_SECRET` in `apps/api/.dev.vars` and `apps/web/.dev.vars`.

`supabase/tests/run-local.sh` applies every migration and runs the SQL tests on a throwaway Postgres. CI runs the same
on every push, plus lint, typecheck, unit tests, the build with its security-header checks, the editor shader check
and a secret scan.

## Release safety

- Deploys run only from `main`, only through the Deploy workflow, and only after a required reviewer approves.
- GitHub Actions are pinned to exact commits (with the version in a comment). To update one, look up the new
  release's commit and change both.
- CI installs only the versions in `pnpm-lock.yaml` and fails if it is out of date.
- The Supabase CLI version in the workflow is pinned; update it on purpose.
- Workers serve only their custom domains (`workers_dev` and `preview_urls` are off), and invocation logs are off.
  The code never logs emails, raw IP addresses, tokens or passcodes.
- The landing origin hosts `/admin`, so it loads no third-party scripts except Turnstile. The build checks the
  security headers of both sites and fails if a policy is weakened.
