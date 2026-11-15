# Security baseline

1. **/admin shares the landing origin.** The landing site therefore loads no third-party scripts except Turnstile,
   ships a strict CSP (`apps/landing/scripts/csp.mjs`), and /admin sits behind Cloudflare Access with passkeys
   and an httpOnly cookie scoped to /admin.
2. **Sessions never reach JavaScript.** The API keeps Supabase tokens in httpOnly, Secure, host-only cookies
   (`__Host-` cookies with `Path=/`; app SameSite=Lax; admin SameSite=Strict with a 30-minute idle lock), verifies access
   tokens against the project's JWKS on every request, and refreshes them server-side. Cookies are never set on
   `.midnightpoetry.studio`. Staff and member accounts are kept apart: each API side rejects the other's users.
   Admin needs Cloudflare Access (JWT verified, email must match the staff account) plus a passkey.
   Members' passkeys and account deletion change only from a single-use link emailed to the account (phase 8,
   item 18): asking needs a sign-in in the last 10 minutes; the change itself needs the link, opened while signed
   in to that account.
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

14. **Zephyr AI (phase 6):**
    - **Owner scoping:** every AI function takes the member id from the verified session and filters by it;
      device-submitted signals, faces and job progress can only touch the member's own ready photos, with counts
      and sizes capped by the schemas and again in SQL.
    - **Providers:** called only through AI Gateway (authenticated) in production, at fixed hosts with model ids
      checked against strict patterns; API keys live in Worker secrets. Providers get the photo's ≤ 2048 px preview
      inline, never the original or a link to our storage; fal storage is off (`X-Fal-Store-IO: 0`); a provider
      result that is a URL instead of inline data is refused.
    - **Untrusted output:** masks go through a strict PNG reader (8-bit grey, grey+alpha or RGBA; no interlace or
      palette; input capped at 8 MB). The size is checked against the source preview straight after IHDR (never
      larger, same aspect), and IDAT data is inflated in 4 KB slices into a buffer of exactly that size, so a
      decompression bomb stops after a few MB. Masks are stored re-encoded as greyscale; the provider's RGB pixels
      are discarded. A mask with no database row (a crash between storing and recording it) is removed by the
      orphan sweep after an hour, never by the request that might have recorded it.
    - **Money:** credits are charged when a job is created and refunded once per failed or canceled item, under a
      per-member advisory lock; a balance can't go negative. Before an item's first provider call, its worst case
      (every primary attempt plus the fallback) is reserved under the day's lock, so parallel consumers can't pass
      a daily cap; it's settled to the real cost on the day it was reserved. Every run carries a token (the item's
      attempt number, a scene run's id), so only the run in flight reports, once: a late or repeated report (a run
      taken over as stuck, whose whole reservation was counted then, or a lost reply) changes and counts nothing.
      A provider whose output was rejected isn't asked again for that item; at most 20 items are in flight; and a
      member with 50 provider failures in a day waits until tomorrow. Failures are counted as they happen in an
      append-only daily counter, so retrying failed items doesn't reset it, and retries count toward the per-minute
      job limit like new jobs. Items stuck in processing are picked up again even when their job was canceled, and
      refunded and settled.
    - **Face data (biometric):** off by default, on only with recorded consent to the current wording (version and
      time, audit log), Pro and Studio only. Faces are found on the device; face codes are stored per member, never
      returned to any client, never logged, never compared across accounts. Every face write re-checks the opt-out
      after taking the member's faces lock, so a scan racing "Turn off and delete" stores nothing. Turning it off
      deletes every face, person and rejection at once; scheduling account deletion does too; a plan that loses
      people grouping stops scanning and the data is deleted 30 days later, with emails.
    - **Load:** face batches (10 a minute), AI writes (120) and AI reads (300) have per-member limits; face writes
      wait at most 3 s for the faces lock, then answer 429; a member has at most 3000 people (the oldest unnamed
      one-face groups are pruned), which bounds the per-face matching.
    - **Admin:** any change that could raise spend or turn something on needs a passkey sign-in in the last 10
      minutes, is audited with a before/after diff and emails every Owner; switching things off or lowering a cap
      saves at once, so a one-person team can always pull the kill switch.
    - **Shared devices:** AI writes (and bulk photo actions) carry `X-Zephyr-Expected-User`, captured when the work
      began. Device-job leases belong to a sign-in session and to one tab's random runner token (set when the tab
      creates the job; a claim or report with no token, or another tab's, can't use a live lease); a Web Lock keeps a
      second tab of the browser off the same job, and a photo edited after its job started is left alone, so
      steps never stack. Masks are served to their owner only, privately cached but revalidated on every use
      (`no-cache` + ETag), so a browser never shows a mask its member can no longer read. Sign-out, an account
      switch or pending deletion stop the scanner, the face worker and device jobs, and forget the AI status,
      the scanner's counts and decoded masks; a status request is never shared across members.
    - **On the device:** "Turn off and delete" stops the face pass and waits for a face batch already sent before
      deleting; turning faces off anywhere (or a 403 `feature_off` / `plan_required`) shuts the face worker
      down. A model that fails to download or verify is remembered with a growing back-off, so it's never
      re-downloaded per photo. 429s are waited out with their Retry-After. Spending actions show their credit
      cost and ask first ("Retry all failed").
    - **Scene tags:** a result and a "scene tags off" take the member's scenes lock first, so whichever comes
      second sees the other: no tags survive an opt-out, and a re-tag can't deadlock with it.
    - **Account deletion:** scheduling it deletes face data, cancels and refunds pending cloud work, and the scene
      backfill and the queue consumer skip the account. A background removal already running when deletion is
      scheduled attaches nothing and is refunded; its stored mask has no row, so the sweep removes it.

15. **Billing and teams (phase 7):**
    - **Library context:** every library-scoped query uses the owner id from `library_access`, never from the
      request header directly; every write checks the role, and a removed member loses access on their next request.
    - **Prices:** come only from our table by lookup key; the client never sends a price id or amount. Top-up credits
      come from our price table and are granted once per Checkout session.
    - **Webhooks:** signature checked with a tolerance, raw body read once with a size cap, idempotent and
      order-independent; no payload is stored or logged, and no Stripe ids or emails go to logs.
    - **Team invites:** ≥ 256-bit tokens, hashed, single use, 7 days, email-bound; seats re-checked under a lock.
    - **No double billing:** a second live subscription is cancelled and refunded; open Checkouts are expired first.
    - **Admin price raises** need a recent passkey, are audited and email every Owner.

16. **Admin portal (phase 8):**
    - **Roles:** Owner, Admin, Finance, Safety, Support (`STAFF_CAN` in `packages/shared/src/admin-types.ts`). Every
      admin route checks the role, and every staff SQL function checks it again. There is always at least one Owner.
    - **High-risk changes** (plan limits, storage switch, staff roles, plan overrides, unsuspending, releasing a hold,
      turning AdSense on, retention approvals) need a passkey sign-in in the last 10 minutes and email every Owner.
      Changes that only lower risk save at once, so one Owner can always pull a kill switch. All are audit-logged.
    - **Members' privacy:** lists mask emails and opening a member's detail is logged. Staff never see photo bytes
      except through a Safety reveal grant: one staff member, 10 minutes, a re-encoded `no-store` preview with the
      reviewer's name over it, logged with a reason.
    - **Suspension** ends sessions in Supabase Auth, not only the cookie; teammates and guests lose access at once.
    - **Staff invites:** email-bound, single use, hashed, 72 hours, and still behind Cloudflare Access.
    - **Removed staff** become former staff. Their auth user is banned in Supabase Auth, and neither sign-in accepts
      them. The audit log still names what they did.
    - **Credits:** Support and Safety have rolling 24-hour limits: 1,000 per member and 5,000 in total, checked in
      SQL under locks. A large grant by an Owner or Admin needs a recent passkey and emails every Owner.
    - **Read-only mode** is enforced by one gate in front of every library route. Only exposure-reducing writes
      (Trash, ending a gallery, replacing a link) and uploads already started get through.
    - **Audit log:** append-only, kept indefinitely; exports are role-limited and logged.

17. **Storage switch (phase 8):**
    - Store credentials live only in Worker secrets and the deployment config, never in the database or admin UI.
    - S3 requests are SigV4-signed. A Tunnel hostname also needs a Cloudflare Access service token; a Workers VPC
      binding has no public hostname at all.
    - Only the photo library moves. Guest renditions and branding stay on R2 behind the media host's cache, so CSAM
      scanning still covers everything guests see.
    - Each photo records its store. It flips only after its copy is verified by a SHA-256 read-back, and old copies
      are deleted only after a 7-day hold. Purges cover every store. Members never see endpoints, keys or bucket
      names, and store error bodies are never logged.

18. **Ads (phase 8) and the accepted AdSense risk:**
    - **Sponsored cards** are rendered by the app: https links only, no credentials or IP hosts, re-encoded images,
      `rel="noopener noreferrer sponsored"`, and stats with no identities.
    - **AdSense runs in the app's own page.** Google's policy forbids putting ads in a frame. That means Google's script
      can read what a Free member sees (their private photos, file names) and act as them. httpOnly cookies and CSP
      cannot stop that. **The Owner accepted this risk on 15 November 2026** after professional advice against it.
    - **Mitigations:**
      - Free members, in their own library, only. Never a member of any team library, nor a member whose own
        library still has teammates (a lapsed Studio owner): their session reaches every library they're in, and
        those teams didn't accept the risk. They still get sponsored cards.
      - Only on the Library grid, sidebar and batch queue, on the library pages (`apps/web/worker/adPages.js`).
      - Once the script is loaded, every other page (editor, viewer, sharing, billing, settings, sign-in) opens
        with a full page load, so the script is never in a document showing those pages.
      - **Nothing secret is ever shown in a document holding the script.** A new gallery's link and passcode,
        copy buttons and anything shown once render nothing there (`NoAdsSurface`). Share from a library page
        hands the selection to `/share/new`, a page without ads opened with a full page load, and the create
        flow runs there. While a create dialog or its one-time passcode is open, the script isn't added at all
        (`holdAdsense`); if it was already there when a gallery is created, the app opens the gallery page
        (no ads) instead of showing the passcode, where a new one can be set.
      - **Account takeover is closed by emailed action links.** For every member, adding or removing a passkey
        and deleting the account are only _requested_ in the app. The API emails the account a single-use link
        (`/account-action/<nonce>#t=…`: 256-bit token stored only as an HMAC, bound to the member, the change and
        the passkey, 15 minutes, at most 3 open per change, 5 an hour and 10 a day per change), and the change is
        made on the page that link opens, carrying the token. The fresh nonce in the path makes every link's
        address unique, so opening it always loads a new document: a page with the script loaded can't set its
        own address to the link's and receive the token as a same-document fragment change. The options call
        checks the link before anything reaches GoTrue. The script acts with the session but can't read
        the member's email, can't drive a page it isn't in, and a passkey created on that page comes from the
        member's own authenticator. A new passkey's verify call must present the challenge the link was spent on.
        A code typed into the app would not do: the script could draw the prompt itself.
      - The app Worker widens the CSP for Google's hosts only for documents on the library pages, only while
        AdSense is on, and only for requests carrying a valid AdSense cookie (`__Host-zads`): HttpOnly,
        SameSite=Strict, 15 minutes, its value `v1.<expiry>.<member>.<HMAC>` signed with `ADS_COOKIE_SECRET`,
        which both Workers hold (packages/shared `ads-cookie.ts`). Page script can write a cookie of that name
        but not a valid value, so the wider policy can't be made to stick for a paid plan or another member. The
        API sets it only when it shows the member AdSense and clears it otherwise, on every sign-in, on sign-out,
        and when the session check finds it isn't the member's or their plan has no ads. Every other document,
        including `/index.html`, gets the strict policy. `scripts/csp.mjs` checks both variants and that the ad
        pages stay narrow.
      - A widened document is marked by a `<meta name="zephyr-ads">` the Worker puts first in its `<head>` (the
        app reads it; a Server-Timing entry isn't exposed for navigations a service worker answers in every
        browser). It's also sent `Cross-Origin-Opener-Policy: same-origin-allow-popups`, while every other page
        keeps `same-origin`, so a popup it opens onto another app page lands in a new browsing context group,
        out of the opener's reach. `noopener-allow-popups` on the sensitive pages was considered and not used: a
        browser that doesn't know a COOP value treats it as `unsafe-none`, which would weaken those pages there.
        The side effect: an advertiser's page opened from an ad keeps `window.opener` to the library tab (it could
        redirect that tab), which gives nothing Google's script doesn't already have. **Launch gate:** verify this
        popup isolation in current Chrome, Safari and Firefox before turning AdSense on.
      - The page reloads when the member the script was loaded for is gone (sign-out, an ended session, another
        member) or loses ads. That includes an upgrade or a team joined in this tab, another tab, another device
        or by staff. Tabs tell each other about plan and team changes. A tab holding the script re-reads the
        session, the member's libraries and their ads every 2 minutes and on focus.
      - **Caches and storage.** The service worker serves nothing from Cache Storage: no precache, and the
        offline page is built into `sw.js`. Scripts, styles and WebAssembly come from the HTTP cache, which page
        script can't write. `scripts/csp.mjs` fails the build if `sw.js` reads a cache. Sign-out, account
        deletion and every reload off the script answer `Clear-Site-Data: "cache", "storage"`, which wipes Cache
        Storage, local and session storage, IndexedDB and the service worker. When a session ends in a document
        without the script (a 401, another member, suspension), the app asks the same, and the server clears only
        if this browser may have run the script (`__Host-zseen`, an HttpOnly cookie set for 30 days whenever
        AdSense is returned). Values the app reads back from storage are validated, never used as markup, script
        or a navigation target as they are. What isn't covered: leaving the library pages for another page of the
        same member keeps storage (the session goes on), and closing the tab clears nothing until that browser's
        next session end; neither carries code into a later document.
      - App pages are sent `no-store`, and a page restored from the back/forward cache reloads.
      - Google's certified consent message runs for the EEA, UK and Switzerland. Auto ads and other formats that
        Google places itself stay off in the AdSense console (`docs/setup.md` §3.9).
      - AdSense stays off until an Owner turns it on with a recent passkey. Turning it off needs no passkey and
        reaches new page loads within 75 seconds (15 s API cache plus the app Worker's 60 s). Members stop
        loading the script at once, because `/api/v1/ads` isn't cached.

    - **Residual risk (accepted):** while a Free member is on a library page with the script loaded, Google's
      script can read that page and act as the member through the API. That includes creating share links and
      passcodes (or invites) and sending them elsewhere: such access outlives the page view until the member
      revokes it (Shared › the gallery › End). It can't add a passkey of its own, remove passkeys or delete the
      account: those only complete on a page opened from a link emailed to the member, and a passkey created there
      comes from the member's own authenticator. Its code can't persist through the origin's caches or storage.
    - **Also accepted:**
      - **Phishing the link.** The script could draw a "paste your link here" prompt on the real domain. The
        email's warning ("click the link, never paste it into Zephyr; Zephyr only asks from a link in an email")
        is the mitigation, and the account-action page only takes a token from the emailed link's own address.
      - **Denial of service.** Within 10 minutes of the member's sign-in, the script can ask for links until the
        daily cap (10 per change) is used up, blocking these changes for up to a day. It can't cancel a link
        already sent (3 stay open), and the account-action page ignores other tabs' session broadcasts while it
        holds an unspent link. - **Ad events** count at most one impression and one click per member, card and day. Only members who are
        shown ads can send them. The dedup key is pseudonymous, not anonymous: an HMAC of member, day, card and kind
        under its own secret (`AD_DEDUP_SECRET`). Whoever holds that secret and the database could recompute it for a
        given member, so it's kept for two days and never joined to the stats. - **Never** on the landing origin: /admin lives there, so the landing still loads nothing third-party except
        Turnstile.

See the design decisions doc and `docs/phase-8.md` for the details.
