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

| Realm | Cookies                                          | Attributes                                  |
| ----- | ------------------------------------------------ | ------------------------------------------- |
| App   | `__Host-zs-at`, `__Host-zs-rt`                   | `Path=/; HttpOnly; Secure; SameSite=Lax`    |
| Admin | `__Host-za-at`, `__Host-za-rt`, `__Host-za-seen` | `Path=/; HttpOnly; Secure; SameSite=Strict` |
- **Cookie tossing:** the `__Host-` prefix makes browsers refuse these names from any other `*.midnightpoetry.studio` host (no `Domain`, `Path=/`, `Secure`). A request whose `Cookie` header has one of a realm's names twice gets 401 and the realm's cookies are cleared.
- **Access tokens** are verified on every request against `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (signature, issuer, `aud: authenticated`, expiry), with `jose`. **The project must use asymmetric JWT signing keys** (Supabase › Project Settings › JWT Keys); legacy HS256 secrets are not accepted.
- **Refresh:** done by the API when under 5 minutes remain; a dead refresh token clears the cookies.
- **Sign-out** revokes the session upstream (`/logout?scope=local`).
- **Admin idle timeout:** `__Host-za-seen` holds an HMAC-signed `userId:timestamp` (key `SESSION_HMAC_SECRET`). Over 30 minutes old, missing or forged → the session ends.
- **CSRF:** every non-GET needs an allow-listed `Origin` (app routes: `APP_ORIGINS`; admin: `ADMIN_ORIGINS`; landing forms: `ALLOWED_ORIGINS`) and a JSON body. Bodies are capped (4 KB, 20 KB for passkey routes).
- **Passkeys:** the API reads each credential's `clientDataJSON` and requires the ceremony type (`webauthn.get` to sign in, `webauthn.create` to register) and the realm's own origin, matching the request's `Origin`, before Supabase sees it. Adding or removing an app passkey needs a sign-in in the last 10 minutes (newest `amr` timestamp), else 403 `reauth_required`; the account is emailed about every added or removed passkey.
- **Staff and members are separate.** App routes end any session that belongs to a staff account (403); admin routes accept only staff.

## Routes

### Landing page (phase 1)

| Method | Path                      | Notes                                                                                     |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/health`             | `{ ok: true }`                                                                            |
| GET    | `/api/v1/public/config`   | Sign-up mode and request intake. Cached 60 s. **503** if the database is unreachable.     |
| POST   | `/api/v1/invite-requests` | `{ email, useCase?, turnstileToken }` → 202, the same for every email. See phase 1 notes. |

### App: `/api/v1/*`

| Method       | Path                   | Notes                                                                                                                                                                                                                     |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST         | `auth/email/start`     | `{ email, turnstileToken }` (action `email_start`) → **202 for everyone**. A code is sent only to members, after the response.                                                                                            |
| POST         | `auth/email/verify`    | `{ email, code, turnstileToken? }` → session. Wrong code → 400 `invalid_code`; after the first attempt a Turnstile token (action `email_verify`) is required, else 403 `verification_failed`.                             |
| POST         | `auth/passkey/options` | → `{ challengeId, options }` (WebAuthn request options, base64url JSON)                                                                                                                                                   |
| POST         | `auth/passkey/verify`  | `{ challengeId, credential }` → session. Rejected assertion → 400 `passkey_failed`.                                                                                                                                       |
| GET          | `auth/session`         | `SessionResponse` or 401                                                                                                                                                                                                  |
| POST         | `auth/sign-out`        | 204                                                                                                                                                                                                                       |
| PATCH        | `me`                   | `{ displayName }`                                                                                                                                                                                                         |
| GET          | `me/passkeys`          | `{ passkeys }`                                                                                                                                                                                                            |
| POST         | `me/passkeys/options`  | Registration options. 403 `reauth_required` if the sign-in is over 10 minutes old                                                                                                                                         |
| POST         | `me/passkeys/verify`   | → 201 `{ passkey }`, emails the account. 403 `reauth_required` as above                                                                                                                                                   |
| PATCH/DELETE | `me/passkeys/:id`      | Rename / remove (remove: `reauth_required` as above; emails the account)                                                                                                                                                  |
| POST         | `invites/preview`      | `{ token }` → email, inviter, expiry. **Every dead link is the same 404 `invite_invalid`.**                                                                                                                               |
| POST         | `invites/redeem`       | `{ token, displayName? }` → creates the account (email confirmed by the link) and signs in. An invite whose email already has an account is a 404 like any dead link.                                                     |
| POST         | `invites/code`         | `{ code, email, turnstileToken }` (action `invite_code`) → **202 for everyone**; a live code emails a link after the response, only when it creates a new invite (one per address a day).                                 |
| GET          | `invites/mine`         | Member invites and remaining monthly quota                                                                                                                                                                                |
| POST         | `invites`              | `{ email }` → 201 (no note: members can't add text to the email). 403 disabled/paused, 409 already a member/invited, 429 `quota_exceeded` (`retryAfter` = to month end), 500 if the email failed (the invite is revoked). |

### Library: `/api/v1/*` (phase 3)

Contract: `LIBRARY_API` in `packages/shared/src/library-types.ts`; design in `docs/phase-3.md`. Every route needs a member session, and every database call passes the session's user id as `p_owner`: another member's upload, photo, file or album is always **404**.

| Method               | Path                         | Notes                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST                 | `uploads`                    | `{ files: [{ name, size, sha256 }] }` → a decision per file, in order: `ready` (reserves storage), `duplicate` (same SHA-256 and size already in your library, **including the Trash**: offer Restore), or `rejected` (`type`, `too_large`, `quota`).                                                                        |
| PUT                  | `uploads/:id/parts/:n`       | Raw bytes. `Content-Length` must equal the part (16 MiB, the last part the remainder): missing 411, bigger 413 `too_large`, smaller 400. The body is cut off at that length. Part 1 must start with the type's signature, else 415 and the upload is aborted.                                                                |
| PUT                  | `uploads/:id/variants/:kind` | `thumb` (≤ 512 px, 300 KB) or `preview` (≤ 2048 px, 1.5 MB): a JPEG or WEBP, checked from its header. Over the size cap 413, wrong dimensions 400, not JPEG/WEBP 415.                                                                                                                                                        |
| POST                 | `uploads/:id/complete`       | `{ metadata }` → `{ photo }`. Completes the R2 upload and checks the stored size (mismatch: 400 and the upload is discarded). If the same file finished first elsewhere: `{ photo, duplicate: true }` with the kept copy.                                                                                                    |
| GET / DELETE         | `uploads/:id`                | Status for resuming (`partsDone`, `variantsDone`) / abort. Expired uploads: 410 `upload_expired`.                                                                                                                                                                                                                            |
| GET                  | `photos`                     | `?view&albumId&q&from&to&sort&cursor&limit` → `Page<PhotoItem>`                                                                                                                                                                                                                                                              |
| GET / PATCH          | `photos/:id`                 | `{ photo }` (detail with metadata and albums) / `{ favourite?, filename? }`                                                                                                                                                                                                                                                  |
| GET                  | `photos/:id/:kind`           | `thumb`, `preview`: fixed type, `private, no-cache` (revalidated every time behind the session and owner check), ETag/304. `original`: `no-store`, `attachment` (RFC 5987 name, the type's extension kept), single byte ranges. All: `nosniff`, CSP `default-src 'none'; sandbox; frame-ancestors 'none'`, CORP same-origin. |
| POST                 | `photos/bulk`                | `{ ids (≤ 500), action, albumId? }` → `{ affected }` (your own photos only). `delete_forever` only from the Trash.                                                                                                                                                                                                           |
| GET / POST           | `albums`                     | `{ albums }` / `{ name, photoIds? }` → 201 `{ album }` (1,000 albums each)                                                                                                                                                                                                                                                   |
| GET / PATCH / DELETE | `albums/:id`                 | `{ album }` / `{ name?, coverPhotoId? }` (the cover must be in the album) / 204. Deleting an album keeps its photos.                                                                                                                                                                                                         |
| POST                 | `trash/empty`                | `{}` → `{ deleted }`                                                                                                                                                                                                                                                                                                         |
| GET                  | `me/usage`                   | `Usage`: bytes used, reserved and limit, Trash bytes, photo count, the plan's file types, max file size and batch size                                                                                                                                                                                                       |
| POST                 | `me/delete`                  | `{ confirm: "DELETE" }` → `{ purgeAt }` (30 days). Needs a sign-in in the last 10 minutes (403 `reauth_required`). Signs out every session (GoTrue global logout) and emails the account.                                                                                                                                    |
| POST                 | `me/restore`                 | `{}` → `SessionResponse`; 409 if nothing is scheduled                                                                                                                                                                                                                                                                        |

While deletion is pending, `auth/session` returns `user.pendingDeletion: { purgeAt }` and every other member route answers **403 `account_pending_deletion`** (sign-out and `me/restore` still work).

**Shared devices.** Every `uploads*` route accepts `X-Zephyr-Expected-User: <user id>`; if it names anyone but the session's user (someone else signed in on the device mid-upload), the answer is 409 `session_changed` and nothing is touched. Without the header the request is allowed.

**Variants are staged.** Variant PUTs write `staging/<owner>/<photo>/thumb|preview`, a separate top-level prefix. `complete` reads them back, re-checks them and passes their real sizes to the database; only if it wins the claim does it copy them to `u/<owner>/p/<photo>/thumb|preview`, then confirm (`finish_publish`) and unstage. Until confirmed the photo is `publish_pending`: if the copy fails, the clean-up job retries it from staging, and if the staged copy is gone it drops that variant and its counted bytes. A variant PUT that finds its upload completed, aborted or expired deletes its staged copy (under `waitUntil`, so a disconnect can't skip it) and answers 410, so it can never overwrite a finished photo's files or leave uncounted bytes. Aborts (DELETE, a bad part-1 signature, a size mismatch) and the expiry job likewise claim the upload in the database (under the owner's storage lock) before deleting anything in R2, and `complete_upload` checks expiry against the wall clock once it holds that lock.

**Cache.** Sign-out (app and admin) and `me/delete` send `Clear-Site-Data: "cache"`, so private images don't stay readable from the browser cache.

**Deleting objects.** R2 objects are deleted before the rows that count them. Delete forever and Empty Trash move photos to `purging` (hidden, still counted, can't be restored), delete the objects, then remove the rows and usage; if R2 fails, the clean-up job finishes it.

**Clean-up jobs** (`src/jobs.ts`, Cron Trigger `*/15 * * * *`), bounded per run: abort uploads older than 24 hours (200, claimed in the database first), purge Trash past 30 days (300 photos), purge accounts past their date (5 accounts, up to 10,000 objects each under both `u/<id>/` and `staging/<id>/`, finished over later runs if needed; then the Auth user is deleted, which cascades), finish publishing `publish_pending` variants (100 photos), sweep one page (1,000) of `u/` keys for orphans, resuming from a cursor in `job_state` (objects whose photo row is gone or belongs to another owner; keys of existing photos, including in-flight uploads, and unknown key shapes are left alone; `staging/` is left to its lifecycle rule; a cursor that can't be stored resets to the start), and delete old rate-limit rows. Account purges that fail back off for an hour (`profiles.purge_attempts`); the fifth failure writes a `jobs.account_purge_failing` audit row naming the account. A run that did library work writes one `jobs.cleanup` audit row with counts only.

### Admin: `/admin/api/v1/*`

Every request first needs a valid **Cloudflare Access** JWT (`Cf-Access-Jwt-Assertion`, verified against `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud = CF_ACCESS_AUD`), else 403. The staff account's email must equal the Access identity.

| Method | Path                                | Who                   | Notes                                                                                                              |
| ------ | ----------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `auth/email/start`                  | —                     | 202 always. A code is sent only to a staff member **with no passkey**, signing in as their Access identity.        |
| POST   | `auth/email/verify`                 | —                     | → `enrolOnly: true` session. Staff who already have a passkey get 403 `passkey_required`. See below.               |
| POST   | `auth/passkey/options` / `verify`   | —                     | Full session (`enrolOnly: false`) when the token's `amr` shows a passkey                                           |
| GET    | `auth/session`                      | any staff, enrol-only |                                                                                                                    |
| POST   | `auth/sign-out`                     | —                     |                                                                                                                    |
| POST   | `me/passkeys/options` / `verify`    | any staff, enrol-only | Saves the passkey and emails the staff member. See below.                                                          |
| GET    | `signups`                           | any staff             | Settings, counts, codes                                                                                            |
| PATCH  | `signups/settings`                  | owner, admin          | Only an Owner may switch the mode (enforced in the database too). Audited with the reason.                         |
| GET    | `signups/invites` / `requests`      | any staff             | `?status=&cursor=`, 50 per page                                                                                    |
| POST   | `signups/invites`                   | owner, admin          | Up to 50 emails. Skips members, open invites and bad addresses; a failed email revokes its invite (`send_failed`). |
| POST   | `signups/invites/:id/resend`        | owner, admin          | New token, fresh expiry (the old link stops working). See below.                                                   |
| POST   | `signups/invites/:id/revoke`        | owner, admin          |                                                                                                                    |
| POST   | `signups/codes`, `codes/:id/revoke` | owner, admin          |                                                                                                                    |
| POST   | `signups/requests/decide`           | owner, admin          | Approving emails an invite; if the email fails the invite is revoked and the request reopened.                     |
- **Email verify** checks only the Access identity's own address: any other address is `invalid_code` and isn't counted against anyone.
- **Enrolment:** an enrol-only session can add only the _first_ passkey (403 `passkey_required` after that). The session stays enrol-only; the console opens after signing in with the new passkey.
- **Resend** is 409 `already_member` once the email has an account, and 409 `conflict` when the invite expired and a newer one exists.

Enrol-only sessions get 403 `passkey_required` everywhere except `auth/*` and `me/passkeys/*`. Every admin write is audited in the database with the acting staff id.

## Limits

Durable limits live in Postgres (`rate_limit_hit`, per attempt, reserved atomically under an advisory lock _before_ the work it limits, keyed by HMAC hashes of the client's network or the email address) because the Workers rate-limit binding counts per location and only over 10 s or 60 s. The binding (`BURST_LIMITER`, 10/min per network) runs first as a cheap guard. Networks are IPv4 addresses or IPv6 /64s.

| Kind                            | Limit                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email code start                | 5 / network, 3 / address per 15 min; 10 / address per day                                                                                                                                              |
| Email code verify               | 20 / network; 5 attempts / (address, network); 25 attempts / address, per 15 min. Address counters reset when a new code is sent. Turnstile after the first attempt. Wrong-code replies take ≥ 400 ms. |
| Passkey sign-in options         | 30 / network per 15 min                                                                                                                                                                                |
| Invite links (preview + redeem) | 20 / network per 15 min                                                                                                                                                                                |
| Invite codes                    | 5 / network per 15 min; 1 new invite / address per day (database)                                                                                                                                      |
| Admin email codes               | Start: 5 / network, 3 / address per 15 min. Verify: 5 attempts / (address, network), 25 / address per 15 min, reset by a new code                                                                      |
| Upload batches (`POST uploads`) | 120 / member per hour (database), each up to the plan's batch size; JSON body ≤ 256 KB                                                                                                                 |
| Upload parts and variants       | 240 PUTs / member per minute (`UPLOAD_LIMITER` binding, keyed by user id): about 3.75 GiB a minute of 16 MiB parts                                                                                     |
| Library JSON bodies             | ≤ 32 KB (bulk: up to 500 ids)                                                                                                                                                                          |

Supabase applies its own Auth rate limits per IP, and every call comes from this Worker, so raise them (Authentication › Rate Limits) and leave Supabase's CAPTCHA off: Turnstile is verified here.

## Logging

Logs carry a request id, the failing step and upstream status/error codes only: never emails, IPs, codes, tokens or bodies (GoTrue error messages can echo emails, so they're dropped). Workers invocation logs are off.

## Configuration

| Name                           | Kind               | Notes                                                                                                                                                                                          |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                 | var                | Project URL                                                                                                                                                                                    |
| `SUPABASE_PUBLISHABLE_KEY`     | var                | `sb_publishable_…`                                                                                                                                                                             |
| `ALLOWED_ORIGINS`              | var                | Landing forms: `https://zephyr.midnightpoetry.studio`                                                                                                                                          |
| `APP_ORIGINS`                  | var                | `https://zephyrapp.midnightpoetry.studio`                                                                                                                                                      |
| `ADMIN_ORIGINS`                | var                | `https://zephyr.midnightpoetry.studio`                                                                                                                                                         |
| `APP_URL`                      | var                | Base for invite links (`/join#t=…`)                                                                                                                                                            |
| `TURNSTILE_EXPECTED_HOSTNAMES` | var                | Both hosts                                                                                                                                                                                     |
| `CF_ACCESS_TEAM_DOMAIN`        | var                | `<team>.cloudflareaccess.com`                                                                                                                                                                  |
| `CF_ACCESS_AUD`                | var                | The Access application's AUD tag                                                                                                                                                               |
| `EMAIL_FROM`                   | var                | A sender on a domain verified in Resend                                                                                                                                                        |
| `ENVIRONMENT`                  | var                | `production` / `development`                                                                                                                                                                   |
| `SUPABASE_SECRET_KEY`          | **secret**         | `sb_secret_…` (falls back to the old `SUPABASE_SERVICE_ROLE_KEY`)                                                                                                                              |
| `TURNSTILE_SECRET_KEY`         | **secret**         |                                                                                                                                                                                                |
| `IP_HASH_SECRET`               | **secret**         | 32+ random bytes. Rotating it resets all limits.                                                                                                                                               |
| `SESSION_HMAC_SECRET`          | **secret**         | 32+ random bytes. Rotating it signs every admin out.                                                                                                                                           |
| `RESEND_API_KEY`               | **secret**         |                                                                                                                                                                                                |
| `CF_ACCESS_DEV_EMAIL`          | dev only           | Skips Access only when `ENVIRONMENT=development` **and** the request is to localhost                                                                                                           |
| `BURST_LIMITER`                | rate-limit binding | `namespace_id` must be unique in your account                                                                                                                                                  |
| `UPLOAD_LIMITER`               | rate-limit binding | As above                                                                                                                                                                                       |
| `PHOTOS`                       | R2 binding         | Bucket `zephyr-photos`: private, no public access, no r2.dev URL, no CORS rules. Lifecycle rules: abort incomplete multipart uploads after 1 day; delete objects under `staging/` after 2 days |
| Cron Trigger                   | `triggers.crons`   | `*/15 * * * *`: the library clean-up jobs                                                                                                                                                      |

Set secrets with `wrangler secret put <NAME>`. Create the bucket once with `wrangler r2 bucket create zephyr-photos` (leave public access and the r2.dev URL off) and give it two object lifecycle rules (dashboard: R2 › zephyr-photos › Settings › Object lifecycle rules, or `wrangler r2 bucket lifecycle add`): abort incomplete multipart uploads after 1 day, and delete objects with prefix `staging/` after 2 days.

Supabase Auth settings that must match (see `supabase/config.toml`): public sign-up off, email OTP length 6 / expiry 600 s, the sign-in code template (`supabase/templates/sign-in-code.html`), SMTP through Resend, passkeys on with RP ID `midnightpoetry.studio` and both Zephyr origins, and the before-user-created hook.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in keys and secrets
supabase start                   # from the repo root; applies migrations and the seed
pnpm --filter @zephyr/api dev
```

`wrangler dev` simulates the `PHOTOS` bucket locally (`.wrangler/state`). To run the clean-up jobs by hand: `wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`.

## Scripts

`pnpm --filter @zephyr/api <script>`: `test` (Vitest; Supabase, Turnstile, Access and Resend are mocked, R2 is an in-memory bucket with multipart uploads (`test/r2.ts`), the library's database functions are faked in `test/library-db.ts` (the real ones are tested in `supabase/tests`), and tokens are signed with real ES256/RS256 test keys), `typecheck`, `build` (Wrangler dry run into `dist/`), `deploy`.
