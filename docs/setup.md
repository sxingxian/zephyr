# Setup: accounts, keys and the first deploy

Nothing here is committed; each value goes into Cloudflare, Supabase, Resend or GitHub settings.

## 1. Resend (email)

1. Create an account and add the domain `zephyr.midnightpoetry.studio`. Add the SPF, DKIM and DMARC records it
   gives you in Cloudflare DNS.
2. Create two API keys: one for the API Worker (sending access, this domain only) and one for Supabase SMTP.
3. Sender: `Zephyr <hello@zephyr.midnightpoetry.studio>`.

## 2. Supabase

1. Create a project (Pro for production). Note the **project ref**, **URL**, **publishable key** and **secret key**
   (Project Settings › API keys). Use the new **asymmetric JWT signing keys** (Project Settings › JWT keys); the
   API verifies sessions against the project's JWKS and does not accept the legacy HS256 secret.
2. Enable the `pg_cron` extension (Database › Extensions).
3. Apply migrations: `supabase link --project-ref <ref>` then `supabase db push` (or run the Deploy workflow with
   target `database`).
4. Auth › Hooks: enable **Before user created** → Postgres function `public.hook_before_user_created`.
5. Auth › Sign In / Providers: turn **off** "Allow new users to sign up". Accounts are only created by the API
   after it checks an invite. The hook stays on as a second check.
6. Auth › Email: OTP length 6, expiry 600 seconds. Paste `supabase/templates/sign-in-code.html` into the
   **Magic link** template (it shows the code only, no sign-in button).
7. Auth › SMTP: host `smtp.resend.com`, port 465, user `resend`, password = the Resend SMTP key, sender as above.
8. Auth › Passkeys: enable passkeys. Relying party ID `midnightpoetry.studio`, display name `Zephyr`, origins
   `https://zephyrapp.midnightpoetry.studio,https://zephyr.midnightpoetry.studio`. Don't change the RP ID later:
   it invalidates every passkey.
9. Auth › URL configuration: site URL `https://zephyrapp.midnightpoetry.studio`.
10. Create the first Owner: invite yourself from SQL (`insert into staff …` after the user exists) — see
    `supabase/README.md` › Bootstrapping the first Owner.

## 3. Cloudflare

1. **Turnstile:** add one widget (managed mode) for `zephyr.midnightpoetry.studio` and
   `zephyrapp.midnightpoetry.studio`. Keep the **site key** (public) and **secret key**.
2. **Access (Zero Trust, free up to 50 users):** create a self-hosted application for
   `zephyr.midnightpoetry.studio/admin` with a policy allowing only your staff emails (one-time PIN or your
   identity provider). Copy the **team domain** and the application **AUD tag** into the API Worker vars.
3. **API Worker** (`apps/api`): set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CF_ACCESS_TEAM_DOMAIN`,
   `CF_ACCESS_AUD` in `wrangler.jsonc` vars, then the secrets:

   ```sh
   pnpm exec wrangler secret put SUPABASE_SECRET_KEY
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
   pnpm exec wrangler secret put IP_HASH_SECRET        # openssl rand -base64 48
   pnpm exec wrangler secret put SESSION_HMAC_SECRET   # openssl rand -base64 48
   pnpm exec wrangler secret put RESEND_API_KEY
   ```
4. **R2 (photo storage):** create a bucket named `zephyr-photos` in the region closest to your users. Leave
   public access **off** and don't enable the r2.dev URL: every image is served by the API after an ownership
   check. No R2 API tokens or CORS rules are needed, because uploads go through the API Worker's binding.
   Under _Settings › Object lifecycle rules_, add two rules:
   - for the whole bucket, abort incomplete multipart uploads after **1 day**;
   - for the prefix `staging/`, delete objects after **2 days** (thumbnails and previews waiting for their upload
     to finish; uploads expire after 24 hours).

   The clean-up job removes what it knows about; these rules catch anything it missed.
5. **Shared galleries (phase 5):**
   1. **Guest image bucket:** create the R2 bucket `zephyr-shared`, with no r2.dev URL, and connect the custom
      domain `media.midnightpoetry.studio` (proxied). It holds only re-encoded copies made for guests.
   2. **Lock the media host:** under _Security › WAF › Custom rules_, add a rule with the expression
      `http.host eq "media.midnightpoetry.studio" and not any(http.request.headers["x-zephyr-media"][*] eq "<MEDIA_HOST_SECRET>")`
      and the action **Block**. Only the API Worker sends that header. From a normal browser, a request to
      `https://media.midnightpoetry.studio/anything` must get 403.
   3. **Images:** enable Cloudflare Images on the account and switch to **Images Paid** before launch, so
      re-encoding can't stop when the free 5,000 a month run out. The API Worker uses the `IMAGES` binding.
   4. **Child-safety scanning:** under _Caching › Configuration › CSAM Scanning Tool_, enable the tool for the
      zone with a monitored email. **Launch gate:** ask Cloudflare support to confirm in writing that images the
      API Worker fetches from `media.midnightpoetry.studio` through the cache are scanned, and note the answer
      and date here.
   5. **API Worker secrets** (each `openssl rand -base64 48`, except where noted):

      ```sh
      pnpm exec wrangler secret put GALLERY_PEPPER       # passcode check; rotating it breaks every passcode
      pnpm exec wrangler secret put GALLERY_LINK_KEY     # exactly 32 bytes: openssl rand -base64 32; rotating it loses "Copy link"
      pnpm exec wrangler secret put GUEST_COOKIE_SECRET  # rotating it signs every guest out
      pnpm exec wrangler secret put MEDIA_URL_SECRET     # rotating it expires every guest image link
      pnpm exec wrangler secret put MEDIA_HOST_SECRET    # must match the WAF rule above
      ```
   6. **Vars:** set `MEDIA_HOST` (`media.midnightpoetry.studio`) and `SAFETY_ALERT_EMAIL` (a monitored address:
      child-safety matches and reports are sent there).
   7. **Rate limits:** the rate-limit namespaces in `apps/api/wrangler.jsonc` (`SHARE_LIMITER`, `GUEST_LIMITER`,
      `MEDIA_LIMITER`) are created on deploy.
   8. **After the first deploy:** share a gallery and check that:
      - a guest image has no EXIF data;
      - an original over 70 MB downloads at full size (if it can't be transformed, guests get an error for that photo);
      - the media host blocks direct requests.
6. **Zephyr AI (phase 6):**
   1. **AI Gateway:** under _AI › AI Gateway_, create a gateway named `zephyr-prod`. Turn on **Authenticated
      Gateway** and create a token; turn on logs (they show the AI jobs page's numbers in the dashboard too).
      Put the account id and gateway id in the API Worker vars `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`.
      In production the API never calls a provider except through this gateway.
   2. **Runware (background removal):** create an API key. In the gateway, add a **Custom Provider** with the
      slug `runware` (calls go to `…/custom-runware/v1`) and the base URL `https://api.runware.ai`. Ask Runware
      sales to turn on **Zero Data Retention** for the organisation before launch (results already come back
      inline, so nothing is stored as a file).
   3. **fal (fallback):** create an API key. fal is a native gateway provider (`…/fal/<model>`); every call sends
      `X-Fal-Store-IO: 0` so fal doesn't keep the request.
   4. **Workers AI (scene tags):** nothing to create; the `AI` binding in `wrangler.jsonc` calls it through the
      gateway. Measure the cost per scene tag in week 1 and set it in Admin › Zephyr AI › cost estimates.
   5. **Queue:** `pnpm exec wrangler queues create zephyr-ai` and `pnpm exec wrangler queues create zephyr-ai-dlq`.
      The API Worker is both producer and consumer (`wrangler.jsonc`), with 3 retries before the dead-letter queue.
   6. **Secrets:**

      ```sh
      pnpm exec wrangler secret put RUNWARE_API_KEY
      pnpm exec wrangler secret put FAL_KEY
      pnpm exec wrangler secret put AI_GATEWAY_TOKEN   # the authenticated gateway's token
      ```
   7. **Database:** the migration enables `pgvector` (Database › Extensions shows `vector` in schema `extensions`).
   8. **Bake-off (launch gate):** run `node scripts/bakeoff.mjs <folder of ≤50 JPEGs> <output folder>` with
      `RUNWARE_API_KEY` and `FAL_KEY` set, open `index.html` in the output, and set the winner in Admin › Zephyr AI.
   9. **After the first deploy:** remove the background of one photo and check that the cut-out appears in the
      editor, that Admin › AI jobs shows the call, and that today's spend moved.
7. Create an API token with _Workers Scripts: Edit_, _Workers Routes: Edit_, _Workers R2 Storage: Edit_,
   _Queues: Edit_, _AI Gateway: Read_ and _Zone: Read_ on midnightpoetry.studio.
8. Deploy order: the API (`zephyr-api`, which also runs the 15-minute clean-up job and the zephyr-ai queue), then the landing Worker (custom domain `zephyr.midnightpoetry.studio`,
   includes /admin), then the app Worker (custom domain `zephyrapp.midnightpoetry.studio`).

## 3.7 Stripe (phase 7, billing)

Do this in **test mode** first and answer "Build step 0" in [phase-7.md](phase-7.md) before going live.

1. Activate **Managed Payments** on the account (Singapore seller) and set payouts to a **USD bank account**.
2. Create a **restricted key** with the permissions listed in phase-7.md, Build step 0.
3. From the repo root, run `STRIPE_SECRET_KEY=rk_test_… SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/stripe-setup.mjs --test --put-secret`.
   With the Supabase values it also swaps the database's placeholder prices for the real Stripe ids. It creates the
   products, the seven prices with their lookup keys, the portal configuration and the webhook endpoint
   (`https://zephyrapp.midnightpoetry.studio/api/v1/stripe/webhook`), and pipes the signing secret into
   `wrangler secret put STRIPE_WEBHOOK_SECRET`. It never prints keys.
4. `wrangler secret put STRIPE_SECRET_KEY` (the restricted key) on `zephyr-api`.
5. **Billing › Revenue recovery:** set the final action after all retries to **Cancel the subscription** (Zephyr ends
   the plan 21 days after a failed payment either way).
6. Check the product tax codes are accepted by Managed Payments.
7. Repeat with `--live` and live keys once test mode passes.

## 3.8 Extra photo stores (phase 8, storage switch)

Cloudflare R2 (the `PHOTOS` binding, store id `r2`) always exists. Admin › Storage can move the photo library to
another store, one photo at a time, with every copy verified by SHA-256 and the old copies kept for 7 days. Stores
are declared **only in the deployment**: the `STORAGE_STORES` var lists them (no credentials), and their keys are
Worker secrets. Nothing about a store can be added or edited from the admin screen, and its endpoint, bucket and
keys never reach the database or a browser.

Guest renditions and branding (`zephyr-shared`) and full-size gallery renders stay on R2 whatever the switch says:
the media host's cache and Cloudflare's CSAM Scanning Tool sit in front of them.

**Every store, cloud or on premises:**

1. **Bucket:** a private bucket used only by Zephyr. No public access, no website hosting, no versioning (old
   copies are deleted on purpose), no lifecycle rules on `u/`. Add one that empties `staging/` after 2 days if the
   store supports it (the orphan sweep doesn't look there).
2. **Key:** an access key limited to that one bucket, with list, read, write, delete and multipart permissions.
3. **Encryption at rest (NFR-SEC-02):** confirm it, then declare `"encryptionAtRest": true`. Zephyr can't check it
   from outside, and refuses to switch to a store that doesn't declare it. Cloud S3 services encrypt by default
   (check the bucket's setting). On premises, use encrypted disks (LUKS or ZFS native encryption): Garage, for
   one, doesn't encrypt on its own.
4. **Capacity:** for a store with a fixed size (on premises), declare `"capacityBytes"`. Admin shows the free space
   (capacity minus what Zephyr stores there) and marks the store degraded below 15% free.
5. **Cost:** `"costPerTbMonthUsd"` and `"egressNote"` feed the cost comparison in Admin › Storage.
6. **Declare it** in `apps/api/wrangler.jsonc` `vars.STORAGE_STORES` (a JSON array; see the example there):
   `id` (a lower-case letter, then lower-case letters, digits and dashes; 2-32 characters; never reused for a different store), `name`, `kind` (`"s3"`),
   `connection` (`"https"`, `"vpc"` or `"tunnel"`), `endpoint`, `bucket`, `region`, `pathStyle`, `binding` (VPC
   only), `costPerTbMonthUsd`, `egressNote`, `capacityBytes`, `encryptionAtRest`. An invalid list leaves only `r2`
   working and shows `config_invalid` in Admin.
7. **Secrets** (`<ID>` is the id upper-cased, dashes to underscores; `studio-nas` → `STUDIO_NAS`):

   ```sh
   pnpm exec wrangler secret put STORE_<ID>_ACCESS_KEY_ID
   pnpm exec wrangler secret put STORE_<ID>_SECRET
   ```
8. **Queue** (once): `pnpm exec wrangler queues create zephyr-storage` and
   `pnpm exec wrangler queues create zephyr-storage-dlq`.
9. **Deploy, then check:** Admin › Storage › the store › **Run check** (a signed write/read/delete round trip, a 4 MB
   upload speed test and free space). The switch is offered only after a passing check in the last 24 hours. The
   switch itself needs a passkey sign-in in the last 10 minutes and emails every Owner.

**A cloud S3 store** (AWS S3, Backblaze B2, Wasabi, and so on): `"connection": "https"`, the provider's HTTPS
endpoint (no bucket in it), its region, and `"pathStyle": false` where the provider supports virtual-host
addressing (most do; set `true` otherwise). Plain `http` endpoints are refused.

**An on-premises store.** Run an S3-compatible server on the studio's own hardware. We recommend
[Garage](https://garagehq.deuxfleurs.fr/) (small, built for self-hosting, replicates across a few machines). Ceph
RGW (for an existing Ceph cluster) and SeaweedFS also work. Don't use MinIO: its community edition was archived in
2026 and gets no more fixes. Use path-style addressing (`"pathStyle": true`) unless you've set up a root domain for
virtual-host buckets. Then pick how the Worker reaches it; neither needs a port open to the internet.

- **Workers VPC (default; beta, free during the beta):** a private link with no public hostname at all.
  1. Dashboard › Workers VPC › Tunnels › **Create**, then install `cloudflared` on a machine next to the store with
     the command the dashboard shows.
  2. Create the service:
     `pnpm exec wrangler vpc service create zephyr-garage --type http --tunnel-id <TUNNEL_ID> --hostname garage.internal --http-port 3900`
     (or `--ipv4 10.0.0.5` instead of `--hostname`). Note the service id it prints.
  3. Add the binding to `wrangler.jsonc`:
     `"vpc_services": [{ "binding": "VPC_GARAGE", "service_id": "<SERVICE_ID>", "remote": true }]`.
  4. Declare the store with `"connection": "vpc"`, `"binding": "VPC_GARAGE"` and the internal endpoint, for example
     `"endpoint": "http://garage.internal:3900"`. Plain `http` is allowed only here: the tunnel carries it
     encrypted, and requests are still SigV4-signed. Requests are signed for the endpoint's host name, so use the
     name the store expects (and run the Admin check, which fails on a signature mismatch).
- **Tunnel hostname behind Cloudflare Access (fallback, if Workers VPC isn't available):**
  1. Create a Cloudflare Tunnel with a public hostname, for example `s3.studio.example.com` → `http://localhost:3900`.
  2. Zero Trust › Access › Applications: protect that hostname with a **Service Auth** policy that allows only a new
     **service token** (Access › Service credentials). Nothing else may reach it.
  3. Declare the store with `"connection": "tunnel"` and `"endpoint": "https://s3.studio.example.com"`.
  4. Add the service token as secrets too:

     ```sh
     pnpm exec wrangler secret put STORE_<ID>_ACCESS_CLIENT_ID
     pnpm exec wrangler secret put STORE_<ID>_ACCESS_CLIENT_SECRET
     ```

**Removing a store:** only once Admin shows it holds no photos and no migration involves it. Delete its
`STORAGE_STORES` entry and its secrets. Photos still on a store the deployment no longer declares show it as
unreachable.

## 3.9 Google AdSense (phase 8, optional; Free plan only)

AdSense stays off until an Owner turns it on in Admin › Ads with a passkey. The Owner accepted the risk that
Google's script runs inside the app with a Free member's privileges (`docs/security.md` item 18). Before you turn
it on:

1. Get the site approved in AdSense and create one display ad unit per placement you use (Library grid, sidebar,
   batch queue). Enter the publisher id (`ca-pub-…`) and the unit ids in Admin › Ads.
2. In AdSense › Privacy & messaging, publish Google's certified consent message for the EEA, the UK and
   Switzerland, and have counsel review it.
3. **In the AdSense console, keep Auto ads off, and with it anchor ads, vignette ads and side rails.** The app
   can't enforce this. Auto ads would place ads outside the allowed placements, including on pages that must never
   show ads. Only the manual units above are allowed.
4. `/ads.txt` is generated by the app Worker from the publisher id while AdSense is on; nothing to upload.

## 4. GitHub (Settings › Environments › production)

- Secrets: `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `TURNSTILE_SITE_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. The deploy fills these into the API Worker's vars.
- Restrict the environment to `main` and add yourself as a required reviewer so every deploy needs an approval.
- Protect `main`: require the CI checks to pass before anything lands on it.

## Local development

- `apps/api/.dev.vars` from `.dev.vars.example`. Turnstile test keys: site `1x00000000000000000000AA`,
  secret `1x0000000000000000000000000000000AA` (always pass).
- `CF_ACCESS_DEV_EMAIL` lets you use /admin locally without Access; it only works when `ENVIRONMENT=development`
  and the request is to localhost.
- The landing and app dev servers use the Turnstile test site key when no key is set.
