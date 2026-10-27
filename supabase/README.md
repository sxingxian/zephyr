# Database (Supabase)

Postgres schema, access rules and the sign-up hook for Zephyr.

| Path                                       | What it is                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `migrations/20261028000000_foundation.sql` | Tables, Row Level Security, functions, the auth hook and the new-user trigger |
| `migrations/20261028000100_plans.sql`      | Free / Pro / Studio and the first active plan-limits version                  |
| `migrations/20261028000200_cron.sql`       | Daily purge of unapproved invite requests older than 90 days (pg_cron)        |
| `seed.sql`                                 | Local-only: an invite for `dev@zephyr.local`                                  |
| `tests/`                                   | SQL assertions and a runner that uses a throwaway local Postgres              |

## Security model

- **Row Level Security is on for every table.** The only browser access is a signed-in member reading their own profile and changing its display name. Everything else goes through the API Worker with the `service_role` key, after the Worker's own checks.
- **Default privileges are revoked.** Supabase's per-schema grants to `anon` and `authenticated` on new tables, sequences and functions in `public` are revoked. Postgres's built-in grant of EXECUTE on every new function to PUBLIC is global, so the migration revokes it with `for role postgres` too. New objects stay unreachable until a migration grants access, and a test fails if any function in `public` is executable by a browser role.
- **SECURITY DEFINER functions** set `search_path = ''` and are executable only by `service_role` (or `supabase_auth_admin` for the hook).
- **`audit_log` is append-only:** triggers reject UPDATE, DELETE and TRUNCATE.
- **Plan limits** are versioned:
  - Any version past draft needs a named author and a different, named approver. Version 1, the launch limits, is the only exception.
  - The author and approver ids have no foreign key, so deleting an account can't blank them out.
  - Batch size can't exceed 2,000.
  - File types must come from the server allow-list (never SVG, HTML or PDF).
- **Invite tokens** are stored only as SHA-256 hashes.
- **Requesters' networks** (an IPv4 address or an IPv6 /64) are stored only as HMAC hashes, keyed by the API's `IP_HASH_SECRET`. A request's hash is dropped as soon as the request is approved or declined.

## Account creation

Public sign-up is **off**: `enable_signup = false` in `config.toml`.

**Mirror this in the dashboard.** Go to Authentication › Sign In / Providers and turn off "Allow new users to sign up".

Otherwise anyone who knows an invited email could call `/auth/v1/signup` with their own password before the real invitee does.

Accounts are created only by the API, in the accounts phase:

1. It checks the invite token's hash server-side.
2. It creates the user through the Auth admin API, with an invite or magic link. The account stays passwordless until the email is confirmed.

The hook below stays on as defence in depth, so the API must create the `invites` row before it creates the user.

## Sign-up mode (Invite only by default)

`app_settings.signup_mode` is `invite_only` by default. The **Before User Created** auth hook (`public.hook_before_user_created`) enforces it on the server:

- **Sign-ups paused:** rejects every sign-up.
- **Invite only:** rejects any email without an open invite (not accepted, not revoked, not expired).
- **Open:** allows everyone.

When an account is created, `handle_new_user` creates the profile.

The invite is consumed, and any pending invite request is approved, only when the email is confirmed. `handle_user_confirmed` does this on insert of an already-confirmed user, or when `email_confirmed_at` changes from null to a time. An unconfirmed sign-up never uses up an invite.

Turn the hook on in production: **Authentication › Hooks › Before User Created → Postgres function → `public.hook_before_user_created`**. `config.toml` already enables it for the local CLI.

## Invite requests

The API calls `submit_invite_request(email, use_case, ip_hash, disposable)`. It returns one of:

- **`accepted`:** the same for a new request, a duplicate, or an email that already has an account, so the form can't be used to discover members.
- **`rate_limited`:** too many attempts from this network or from everyone:
  - 5 per network per 15 minutes;
  - 20 per network per day;
  - a global backstop of 500 per day across all networks.

  Limits count rows in `invite_request_attempts`. A row is written on every call that passes the limits, before the duplicate check, so a duplicate costs the same as a new email and the limit can't reveal who is already on the list.
- **`not_accepting`:** requests are off, or sign-ups are paused.

Unapproved requests are purged after 90 days, and attempt rows after 2 days. `purge_invite_requests()` does both, and pg_cron runs it daily.

## Running the tests locally

The tests need Postgres 15+ binaries (`initdb`, `pg_ctl`, `psql`). Run them as a non-root user:

```sh
supabase/tests/run-local.sh
```

The runner:

1. starts a throwaway cluster;
2. loads `tests/00_local_stub.sql`, a stand-in for:
   - Supabase's `auth` schema, including `email_confirmed_at`;
   - `auth.uid()`;
   - the `extensions` schema;
   - Supabase's roles and its default grants in `public`, so a missing revoke shows up as a failure;
3. applies every migration, skipping the pg_cron one if the extension isn't installed;
4. applies the seed and runs `tests/*_test.sql`.

Each test runs inside a transaction that is rolled back.

With the Supabase CLI (`supabase start`) the migrations and seed apply to a real local stack instead. You can also run `tests/10_schema_test.sql` in the SQL editor of a scratch project.

## Applying to a project

```sh
supabase link --project-ref <ref>
supabase db push
```

Then enable the auth hook and the pg_cron extension in the dashboard.
