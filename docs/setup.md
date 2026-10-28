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
4. Create an API token with _Workers Scripts: Edit_, _Workers Routes: Edit_ and _Zone: Read_ on
   midnightpoetry.studio.
5. Deploy order: the API (`zephyr-api`), then the landing Worker (custom domain `zephyr.midnightpoetry.studio`,
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
