# Security baseline

1. **/admin shares the landing origin.** The landing site therefore loads no third-party scripts except Turnstile,
   ships a strict CSP (`apps/landing/scripts/csp.mjs`), and /admin (next phase) will sit behind Cloudflare Access
   with passkeys and an httpOnly cookie scoped to /admin.
2. **Sessions never reach JavaScript.** The API keeps Supabase tokens in httpOnly, Secure, host-only cookies
   (`__Host-` cookies with `Path=/`; app SameSite=Lax; admin SameSite=Strict with a 30-minute idle lock), verifies access
   tokens against the project's JWKS on every request, and refreshes them server-side. Cookies are never set on
   `.midnightpoetry.studio`. Staff and member accounts are kept apart: each API side rejects the other's users.
   Admin needs Cloudflare Access (JWT verified, email must match the staff account) plus a passkey.
3. **Least privilege in Postgres.** RLS on every table; defaults revoked so new tables start closed; `security
   definer` functions pin `search_path = ''`; `audit_log` is append-only (UPDATE/DELETE/TRUNCATE blocked).
4. **Invite-only is enforced on the server.** Public sign-up is off in Supabase Auth; accounts are created only by
   the API after it checks an invite token (single-use, ≥128-bit, stored as a SHA-256 hash, tied to one email,
   expiring), using a passwordless admin invite link. The before-user-created hook re-checks the sign-up mode, and an
   invite counts as used only once the email is confirmed.
5. **Invite requests:** Turnstile (action and hostname checked), a burst limiter, 5 per network per 15 minutes and
   20 per day counted per attempt (IPv6 grouped by /64), a global daily cap, Origin allow-list, 4 KB body cap, and
   the same reply for every email so the form can't reveal who has an account or a pending request. IPs are stored
   only as HMAC hashes, cleared once a request is decided; attempt logs go after 2 days and unapproved requests
   after 90 days. Worker invocation logs are off so raw IPs aren't logged.
6. **Function privileges:** new functions start closed (`alter default privileges for role postgres revoke execute
   on functions from public`), and a SQL test fails if any public function is callable by `anon` or `authenticated`.
7. **No PII in logs:** never log emails, raw IPs, tokens or passcodes.
8. **Headers:** HSTS, `nosniff`, `frame-ancestors 'none'`, COOP, restrictive Permissions-Policy on every page.
9. **Supply chain:** lockfile installs only, pnpm `minimumReleaseAge` of one day, install scripts allow-listed,
   GitHub Actions pinned to commit SHAs, Dependabot, `pnpm audit` and a checksum-verified gitleaks scan in CI.
   Deploys run from main only, behind the `production` environment, and the Cloudflare token is given to the
   deploy step only, never to the build.
10. **Secrets** live in Cloudflare (`wrangler secret put`) and GitHub environment secrets, never in the repo.
    `.dev.vars` and `.env*` files are git-ignored.

Later phases add the rules for photos (private R2, signed URLs, re-encoding uploads, magic-byte checks), passcode
galleries, ads isolation, CSAM scanning, face-data opt-in and retention jobs. See the design decisions doc.
