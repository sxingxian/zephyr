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

11. **Photos (phase 3):** a private R2 bucket with no public access and no r2.dev URL. Every byte goes through the
    API Worker after the session and owner checks; there are no signed URLs to leak. Keys are
    `u/<ownerId>/p/<photoId>/…` and never come from the client.
    - **Uploads:** each file's type and size are checked against the plan, and the first part's magic bytes must
      match the declared type. Every part needs a Content-Length, and storage is reserved under a per-owner lock
      before any part is accepted. On completion the API reads the real sizes of the original and its variants from
      R2 and counts those, not the client's claims. Variant writes are refused once the upload is closed, and any
      object written after that is deleted.
    - **Aborting:** an abort is claimed in the database first; R2 objects are deleted only by whichever side won.
      Anything left over is removed by the clean-up job.
    - **Serving:** responses carry `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox;
      frame-ancestors 'none'` and `Cross-Origin-Resource-Policy: same-origin`. Thumbnails and previews are
      `private, no-cache` with an ETag, so the browser re-checks the session every time. Originals are `no-store`
      downloads. Sign-out and account deletion send `Clear-Site-Data: "cache"`.
    - **Shared devices:** the upload queue belongs to the user who started it. Sign-out, a 401 or a change of user
      aborts it and deletes its open uploads, then reloads the page so no photo data stays in memory.
    - **Retention:** a 15-minute Cron Trigger purges expired uploads, trash older than 30 days, accounts 30 days
      after deletion (with backoff and an audit alert after repeated failures) and orphaned objects. R2 lifecycle
      rules abort unfinished multipart uploads after one day and delete leftover `staging/` objects after two.

12. **Editor (phase 4):**
    - **Recipes:** numbers, enums and booleans only, checked strictly (unknown keys, including `__proto__`, are
      rejected), clamped and rounded by the shared `normalizeRecipe`, and capped at 4 KB in both the API and the
      database. Recipe names are plain text with control characters stripped.
    - **Versions:** every save and revert takes a new version, and a save based on an older version gets 409.
    - **Edited thumbnails and previews:** each upload goes to its own random key. It is recorded under the storage
      lock only if its version is still current, measured from R2, and counted toward storage; a losing upload
      deletes only its own object. The orphan sweep removes anything not recorded, and ids in keys are always
      canonical lower case.
    - **Untrusted files:** images and RAWs are decoded only in the browser: LibRaw runs in a Worker from a
      same-origin WebAssembly file, with a signature check, a size cap and a time limit. The server never decodes
      images.
    - **Exports:** made on the device with no metadata, and file names are cleaned. Save as copy is bound to the
      member who started it and is cancelled if the session ends.
    - **Shared devices:** the edit clipboard, the render queue, open edit sessions, exports and the RAW worker are
      reset with the upload queue when the session ends.

13. **Shared galleries (phase 5):**
    - **Links:** 256-bit tokens, looked up by hash and kept encrypted (AES-256-GCM) so the owner can copy them again.
      Guest pages and API replies send no referrer and are never cached.
    - **Passcodes** (optional per gallery, on by default):
      - kept as an HMAC with a server-side pepper and checked in constant time;
      - every attempt is counted before it's checked: 5 per network per 15 minutes, Turnstile after 2, and a
        gallery-wide pause after 25;
      - a new passcode signs every guest out.

    - **Guest images:** always re-encoded on the server (Cloudflare Images), with no metadata. They are served only
      through the API Worker, using one-hour signed URLs, and the database is checked on every request. The media
      host behind it is closed to everyone but the Worker (WAF rule) and sits behind the Cloudflare cache for CSAM
      scanning. An edited photo whose edited preview isn't ready, or a watermarked gallery whose watermark image is
      missing, is served as "Preparing", never as the unedited or unwatermarked original, and a cropped photo's guest size is its cropped shape. Downloads are re-checked
      against the gallery's current settings on every request, and download names never use the member's file
      names.
    - **Safety:** a scanner block puts the photo on hold everywhere, suspends sharing for the account, alerts
      `SAFETY_ALERT_EMAIL` and preserves the photo. Guests can report a gallery without unlocking it (10 reports per network per day). Safety is emailed about
      child-safety reports at most once an hour per gallery, with a running count; every report is kept.
    - **Branding:** a member's branding can only use preset accent colours and re-encoded images, and guest-visible
      text is plain text.

Later phases add ads isolation, the admin Safety queue and face-data opt-in. See the design decisions doc.
