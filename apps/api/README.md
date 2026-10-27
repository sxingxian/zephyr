# @zephyr/api

The Zephyr API: a Cloudflare Worker built with Hono and zod. It's the only thing that talks to Supabase with the service-role key.

## How it's reached

The API has **no public URL of its own** (`workers_dev` and `preview_urls` are off, and there are no routes). Two Workers forward `/api/*` to it through a service binding (`env.API.fetch(request)`):

- the landing Worker, for `zephyr.midnightpoetry.studio/api/*`;
- later, the PWA Worker, for `zephyrapp.midnightpoetry.studio/api/*`.

The original request arrives unchanged: Origin, `CF-Connecting-IP` and the `/api/...` path. Because the API is same-origin with the pages that call it, it needs no CORS. It still checks `Origin` against `ALLOWED_ORIGINS` on every POST.

## Routes

| Method | Path                      | What it does                                                                                                                                                        |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`             | `{ ok: true }`                                                                                                                                                      |
| GET    | `/api/v1/public/config`   | Sign-up mode, whether invite requests are open, whether sign-ups are paused. Cached for 60 s. Returns **503** if the database is unreachable, rather than guessing. |
| POST   | `/api/v1/invite-requests` | Landing-page invite request. Body `{ email, useCase?, turnstileToken }`, validated by `inviteRequestSchema` in `@zephyr/shared`.                                    |

Any other path returns a JSON 404. Methods other than GET, HEAD and POST return 405.

### Invite request responses

| Status | Body                              | When                                                                                                                                            |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 202    | `{ ok: true }`                    | Accepted. **Identical** for new requests, duplicates and emails that already have accounts.                                                     |
| 400    | `{ ok: false, error: 'invalid' }` | Malformed JSON or invalid fields                                                                                                                |
| 403    | `invalid` / `verification_failed` | Origin not allowed / Turnstile failed, or its hostname or action is wrong                                                                       |
| 409    | `not_accepting`                   | Requests are off, or sign-ups are paused                                                                                                        |
| 413    | `invalid`                         | Body over 4 KB                                                                                                                                  |
| 415    | `invalid`                         | Not `application/json`                                                                                                                          |
| 429    | `rate_limited` + `Retry-After`    | Burst limiter (10 per minute per network, per location) or the database limits (5 per network per 15 minutes, 20 per day, 500 per day in total) |
| 500    | `server`                          | Anything else. No internals are returned.                                                                                                       |

Each request goes through these checks, in order:

1. Origin allow-list and content type.
2. 4 KB body limit.
3. Burst limiter.
4. zod validation.
5. Turnstile siteverify. The token must be valid, come from an allowed hostname, and carry the action `invite_request`.
6. HMAC-SHA-256 of the client's network: the IPv4 address, or the IPv6 /64 prefix. IPv4-mapped IPv6 counts as IPv4. The burst limiter is keyed on the same network, so rotating addresses inside one IPv6 /64 doesn't escape the limits.
7. The `submit_invite_request` RPC.

### Logging

Logs never contain emails, IPs, tokens or request bodies, only a request ID and the failing step.

Workers invocation logs are off (`observability.logs.invocation_logs: false` in `wrangler.jsonc`). They record request metadata, including the client IP, on every request.

### Headers

Every response carries `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and an `X-Request-Id`. Responses are `Cache-Control: no-store` unless a route opts in to caching.

## Configuration

| Name                           | Kind               | Notes                                                                                        |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                 | var                | Project URL                                                                                  |
| `ALLOWED_ORIGINS`              | var                | Comma-separated, e.g. `https://zephyr.midnightpoetry.studio`                                 |
| `TURNSTILE_EXPECTED_HOSTNAMES` | var                | Hostnames a Turnstile token may come from                                                    |
| `ENVIRONMENT`                  | var                | `production` / `development`                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`    | **secret**         | Server-side only. Never ship it to a browser.                                                |
| `TURNSTILE_SECRET_KEY`         | **secret**         | From the Turnstile widget settings                                                           |
| `IP_HASH_SECRET`               | **secret**         | 32+ random bytes, e.g. `openssl rand -base64 48`. Rotating it resets the per-network limits. |
| `BURST_LIMITER`                | rate-limit binding | `namespace_id` must be unique in your Cloudflare account                                     |

Set the secrets with `wrangler secret put <NAME>`.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in the service-role key and an IP hash secret
supabase start                   # from the repo root; applies migrations and the seed
pnpm --filter @zephyr/api dev
```

`.dev.vars.example` uses Turnstile's always-pass test secret.

## Scripts

`pnpm --filter @zephyr/api <script>`:

- `test`: Vitest. Turnstile, PostgREST and the rate limiter are mocked.
- `typecheck`
- `build`: a Wrangler dry run that writes the bundle to `dist/`.
- `deploy`
