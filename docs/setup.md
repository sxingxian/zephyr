# Setup: accounts, keys and the first deploy

Nothing here is committed; each value goes into Cloudflare, Supabase or GitHub settings.

## 1. Supabase

1. Create a project (Pro for production). Note the **project ref** and **URL**.
2. Enable the `pg_cron` extension (Database › Extensions).
3. Apply migrations: `supabase link --project-ref <ref>` then `supabase db push` (or run the Deploy workflow with
   target `database`).
4. Auth › Hooks: enable **Before user created** → Postgres function `public.hook_before_user_created`.
5. Auth › Sign In / Providers: turn **off** "Allow new users to sign up". Accounts are only created by the API
   (invite redemption verifies the invite token, then uses Auth's admin invite link, so no one can register an
   invited email with their own password first). The hook stays on as a second check.
6. Auth › URL configuration: site URL `https://zephyrapp.midnightpoetry.studio`.

## 2. Cloudflare

1. Turnstile: add a widget for `zephyr.midnightpoetry.studio` (managed mode). Keep the **site key** (public) and
   **secret key**.
2. API Worker secrets (`apps/api`):

   ```sh
   pnpm exec wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
   pnpm exec wrangler secret put IP_HASH_SECRET   # 32+ random bytes, e.g. openssl rand -base64 32
   ```
3. Create an API token with _Workers Scripts: Edit_, _Workers Routes: Edit_ and _Zone: Read_ on
   midnightpoetry.studio.
4. Deploy the API first (`zephyr-api`), then the landing Worker (it binds to `zephyr-api` and claims the custom
   domain `zephyr.midnightpoetry.studio`).

## 3. GitHub (Settings › Environments › production)

- Secrets: `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`.
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `TURNSTILE_SITE_KEY`.
- Add yourself as a required reviewer so every deploy needs an approval.
- Branch protection on `main`: require the CI checks and a pull request.

## Local development

- `apps/api/.dev.vars` from `.dev.vars.example`. Turnstile test keys: site `1x00000000000000000000AA`,
  secret `1x0000000000000000000000000000000AA` (always pass).
- The landing dev server uses the test site key when `PUBLIC_TURNSTILE_SITE_KEY` isn't set.
