# @zephyr/api

The Zephyr API: a Cloudflare Worker built with Hono and zod. It's the only thing that talks to Supabase with the secret key, and it holds every session. The contract (routes, bodies, error codes) is in `packages/shared/src/api-types.ts` and `api-schemas.ts`; the design is in `docs/phase-2.md`.

## How it's reached

The API has **no public URL of its own** (`workers_dev` and `preview_urls` are off, and there are no routes). Site Workers forward to it through a service binding (`env.API.fetch(request)`):

| Host                            | Forwarded paths          | Callers                     |
| ------------------------------- | ------------------------ | --------------------------- |
| zephyr.midnightpoetry.studio    | `/api/*`, `/admin/api/*` | Landing page, admin console |
| zephyrapp.midnightpoetry.studio | `/api/*`                 | The app (PWA)               |

The original request arrives unchanged: Origin, `CF-Connecting-IP`, `Cf-Access-Jwt-Assertion`, cookies and the path. Everything is same-origin, so there is no CORS.

## Sessions

Tokens never reach the browser. After sign-in the API sets httpOnly cookies and reads them on every request:

| Realm | Cookies                                                | Attributes                                             |
| ----- | ------------------------------------------------------ | ------------------------------------------------------ |
| App   | `__Secure-zs-at`, `__Secure-zs-rt`                     | `Path=/api; HttpOnly; Secure; SameSite=Lax`, host-only |
| Admin | `__Secure-za-at`, `__Secure-za-rt`, `__Secure-za-seen` | `Path=/admin; HttpOnly; Secure; SameSite=Strict`       |
- **Access tokens** are verified on every request against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (signature, issuer, `aud: authenticated`, expiry), with `jose`. **The project must use asymmetric JWT signing keys** (Supabase › Project Settings › JWT Keys); legacy HS256 secrets are not accepted.
- **Refresh:** done by the API when under 5 minutes remain; a dead refresh token clears the cookies.
- **Sign-out** revokes the session upstream (`/logout?scope=local`).
- **Admin idle timeout:** `__Secure-za-seen` holds an HMAC-signed `userId:timestamp` (key `SESSION_HMAC_SECRET`). Over 30 minutes old, missing or forged → the session ends.
- **CSRF:** every non-GET needs an allow-listed `Origin` (app routes: `APP_ORIGINS`; admin: `ADMIN_ORIGINS`; landing forms: `ALLOWED_ORIGINS`) and a JSON body. Bodies are capped (4 KB, 20 KB for passkey routes).
- **Staff and members are separate.** App routes end any session that belongs to a staff account (403); admin routes accept only staff.

## Routes

### Landing page (phase 1)

| Method | Path                      | Notes                                                                                     |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/health`             | `{ ok: true }`                                                                            |
| GET    | `/api/v1/public/config`   | Sign-up mode and request intake. Cached 60 s. **503** if the database is unreachable.     |
| POST   | `/api/v1/invite-requests` | `{ email, useCase?, turnstileToken }` → 202, the same for every email. See phase 1 notes. |

### App: `/api/v1/*`

| Method       | Path                   | Notes                                                                                                                                   |
| ------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| POST         | `auth/email/start`     | `{ email, turnstileToken }` (action `email_start`) → **202 for everyone**. A code is sent only to members, after the response.          |
| POST         | `auth/email/verify`    | `{ email, code }` → session cookies + `SessionResponse`. Wrong code → 400 `invalid_code`.                                               |
| POST         | `auth/passkey/options` | → `{ challengeId, options }` (WebAuthn request options, base64url JSON)                                                                 |
| POST         | `auth/passkey/verify`  | `{ challengeId, credential }` → session. Rejected assertion → 400 `passkey_failed`.                                                     |
| GET          | `auth/session`         | `SessionResponse` or 401                                                                                                                |
| POST         | `auth/sign-out`        | 204                                                                                                                                     |
| PATCH        | `me`                   | `{ displayName }`                                                                                                                       |
| GET          | `me/passkeys`          | `{ passkeys }`                                                                                                                          |
| POST         | `me/passkeys/options`  | Registration options                                                                                                                    |
| POST         | `me/passkeys/verify`   | → 201 `{ passkey }`                                                                                                                     |
| PATCH/DELETE | `me/passkeys/:id`      | Rename / remove                                                                                                                         |
| POST         | `invites/preview`      | `{ token }` → email, inviter, expiry. **Every dead link is the same 404 `invite_invalid`.**                                             |
| POST         | `invites/redeem`       | `{ token, displayName? }` → creates the account (email confirmed by the link) or reuses it, signs in. `isNew` is true for new accounts. |
| POST         | `invites/code`         | `{ code, email, turnstileToken }` (action `invite_code`) → **202 for everyone**; a live code emails a link after the response.          |
| GET          | `invites/mine`         | Member invites and remaining monthly quota                                                                                              |
| POST         | `invites`              | `{ email, note? }` → 201. 403 disabled/paused, 409 already a member/invited, 429 `quota_exceeded` (`retryAfter` = to month end).        |

### Admin: `/admin/api/v1/*`

Every request first needs a valid **Cloudflare Access** JWT (`Cf-Access-Jwt-Assertion`, verified against `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud = CF_ACCESS_AUD`), else 403. The staff account's email must equal the Access identity.

| Method | Path                                | Who                   | Notes                                                                                                              |
| ------ | ----------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `auth/email/start`                  | —                     | 202 always. A code is sent only to a staff member **with no passkey**, signing in as their Access identity.        |
| POST   | `auth/email/verify`                 | —                     | → `enrolOnly: true` session. Staff who already have a passkey get 403 `passkey_required`.                          |
| POST   | `auth/passkey/options` / `verify`   | —                     | Full session (`enrolOnly: false`) when the token's `amr` shows a passkey                                           |
| GET    | `auth/session`                      | any staff, enrol-only |                                                                                                                    |
| POST   | `auth/sign-out`                     | —                     |                                                                                                                    |
| POST   | `me/passkeys/options` / `verify`    | any staff, enrol-only | Saves the passkey. The session stays enrol-only; the console opens after signing in with the passkey.              |
| GET    | `signups`                           | any staff             | Settings, counts, codes                                                                                            |
| PATCH  | `signups/settings`                  | owner, admin          | Only an Owner may switch the mode (enforced in the database too). Audited with the reason.                         |
| GET    | `signups/invites` / `requests`      | any staff             | `?status=&cursor=`, 50 per page                                                                                    |
| POST   | `signups/invites`                   | owner, admin          | Up to 50 emails. Skips members, open invites and bad addresses; a failed email revokes its invite (`send_failed`). |
| POST   | `signups/invites/:id/resend`        | owner, admin          | New token, fresh expiry (the old link stops working)                                                               |
| POST   | `signups/invites/:id/revoke`        | owner, admin          |                                                                                                                    |
| POST   | `signups/codes`, `codes/:id/revoke` | owner, admin          |                                                                                                                    |
| POST   | `signups/requests/decide`           | owner, admin          | Approving emails an invite; if the email fails the invite is revoked and the request reopened.                     |

Enrol-only sessions get 403 `passkey_required` everywhere except `auth/*` and `me/passkeys/*`. Every admin write is audited in the database with the acting staff id.

## Limits

Durable limits live in Postgres (`rate_limit_hit`, per attempt, keyed by HMAC hashes of the client's network or the email address) because the Workers rate-limit binding counts per location and only over 10 s or 60 s. The binding (`BURST_LIMITER`, 10/min per network) runs first as a cheap guard. Networks are IPv4 addresses or IPv6 /64s.

| Kind                            | Limit                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| Email code start                | 5 / network, 3 / address per 15 min                          |
| Email code verify               | 20 / network per 15 min; 5 wrong codes / address per 15 min  |
| Passkey sign-in options         | 30 / network per 15 min                                      |
| Invite links (preview + redeem) | 20 / network per 15 min                                      |
| Invite codes                    | 5 / network per 15 min                                       |
| Admin email codes               | 5 / network, 3 / address per 15 min; 5 wrong codes / address |

Supabase applies its own Auth rate limits per IP, and every call comes from this Worker, so raise them (Authentication › Rate Limits) and leave Supabase's CAPTCHA off: Turnstile is verified here.

## Logging

Logs carry a request id, the failing step and upstream status/error codes only: never emails, IPs, codes, tokens or bodies (GoTrue error messages can echo emails, so they're dropped). Workers invocation logs are off.

## Configuration

| Name                           | Kind               | Notes                                                                                |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------ |
| `SUPABASE_URL`                 | var                | Project URL                                                                          |
| `SUPABASE_PUBLISHABLE_KEY`     | var                | `sb_publishable_…`                                                                   |
| `ALLOWED_ORIGINS`              | var                | Landing forms: `https://zephyr.midnightpoetry.studio`                                |
| `APP_ORIGINS`                  | var                | `https://zephyrapp.midnightpoetry.studio`                                            |
| `ADMIN_ORIGINS`                | var                | `https://zephyr.midnightpoetry.studio`                                               |
| `APP_URL`                      | var                | Base for invite links (`/join#t=…`)                                                  |
| `TURNSTILE_EXPECTED_HOSTNAMES` | var                | Both hosts                                                                           |
| `CF_ACCESS_TEAM_DOMAIN`        | var                | `<team>.cloudflareaccess.com`                                                        |
| `CF_ACCESS_AUD`                | var                | The Access application's AUD tag                                                     |
| `EMAIL_FROM`                   | var                | A sender on a domain verified in Resend                                              |
| `ENVIRONMENT`                  | var                | `production` / `development`                                                         |
| `SUPABASE_SECRET_KEY`          | **secret**         | `sb_secret_…` (falls back to the old `SUPABASE_SERVICE_ROLE_KEY`)                    |
| `TURNSTILE_SECRET_KEY`         | **secret**         |                                                                                      |
| `IP_HASH_SECRET`               | **secret**         | 32+ random bytes. Rotating it resets all limits.                                     |
| `SESSION_HMAC_SECRET`          | **secret**         | 32+ random bytes. Rotating it signs every admin out.                                 |
| `RESEND_API_KEY`               | **secret**         |                                                                                      |
| `CF_ACCESS_DEV_EMAIL`          | dev only           | Skips Access only when `ENVIRONMENT=development` **and** the request is to localhost |
| `BURST_LIMITER`                | rate-limit binding | `namespace_id` must be unique in your account                                        |

Set secrets with `wrangler secret put <NAME>`.

Supabase Auth settings that must match (see `supabase/config.toml`): public sign-up off, email OTP length 6 / expiry 600 s, the sign-in code template (`supabase/templates/sign-in-code.html`), SMTP through Resend, passkeys on with RP ID `midnightpoetry.studio` and both Zephyr origins, and the before-user-created hook.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in keys and secrets
supabase start                   # from the repo root; applies migrations and the seed
pnpm --filter @zephyr/api dev
```

## Scripts

`pnpm --filter @zephyr/api <script>`: `test` (Vitest; Supabase, Turnstile, Access and Resend are mocked, and tokens are signed with real ES256/RS256 test keys), `typecheck`, `build` (Wrangler dry run into `dist/`), `deploy`.
