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
6. Create an API token with _Workers Scripts: Edit_, _Workers Routes: Edit_, _Workers R2 Storage: Edit_ and
   _Zone: Read_ on midnightpoetry.studio.
7. Deploy order: the API (`zephyr-api`, which also runs the 15-minute clean-up job), then the landing Worker (custom domain `zephyr.midnightpoetry.studio`,
   includes /admin), then the app Worker (custom domain `zephyrapp.midnightpoetry.studio`).

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
