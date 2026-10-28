# Phase 2: accounts, invites and the admin Sign-ups page

Decided with the product owner on 28 Oct 2026:
- **Email:** Resend, for invite emails and as Supabase Auth's SMTP server.
- **Sign-in:** email codes (always on) and passkeys (Supabase passkeys, beta). No Google or Apple yet.
- **Default sign-up mode:** invite only.

Mockups: PWA desktop and phone canvases, row "Sign in & joining"; admin canvas, "Admin sign-in" and "Admin · first sign-in, enrol passkey".

## Sessions (backend-for-frontend)

- The API Worker talks to Supabase Auth (GoTrue REST) and keeps the access and refresh tokens in httpOnly cookies.
  The browser never holds a token, so no script on the page (including Free-plan ads later) can steal a session.
- **App** (zephyrapp.midnightpoetry.studio):
  - Cookies: `__Host-zs-at` and `__Host-zs-rt`.
  - Attributes: `Path=/; Secure; HttpOnly; SameSite=Lax`. The `__Host-` prefix means they can't carry a Domain, so
    a sibling `*.midnightpoetry.studio` site can't plant a session.
- **Admin** (zephyr.midnightpoetry.studio/admin):
  - Cookies: `__Host-za-at`, `__Host-za-rt`, and `__Host-za-seen`, an HMAC-signed last-activity time.
  - Attributes: `Path=/; SameSite=Strict`.
  - Idle timeout: 30 minutes.
- **Duplicate cookies:** a request carrying the same session cookie name twice gets a 401 and has its cookies
  cleared.
- **Access tokens:**
  - Verified on every request against Supabase's JWKS (`/auth/v1/.well-known/jwks.json`) with `jose`.
  - Refreshed by the API when under 5 minutes are left.
  - Revoked with GoTrue `logout` on sign-out.
- **CSRF:** SameSite cookies, an exact Origin allow-list, and JSON-only bodies on every non-GET.
- **Staff and members are separate:** the app API rejects users in `staff`; the admin API accepts only them.

## Sign-in

- **Email code:**
  - `POST /otp` with `create_user: false`, protected by Turnstile.
  - The reply is the same for unknown emails.
  - `POST /verify` with `type: email` returns a session.
  - Rate limits:
    - 5 starts per network per 15 minutes, and 10 codes per address per day.
    - Every verify attempt is reserved atomically before it reaches Supabase: 5 per address and network, 25 per
      address per 15 minutes. Parallel guesses can't slip past the count.
  - Turnstile: the first verify attempt needs no check; every later one needs a fresh token (action `email_verify`).
  - Wrong-code replies take at least 400 ms, so response times don't show which addresses have accounts.
  - Staff addresses never get codes from the app routes.
- **Passkey:** GoTrue `/passkeys/authentication/options` and `/passkeys/authentication/verify`, proxied by the API.
  The browser runs the ceremony with `@simplewebauthn/browser`.
- **Origin binding:** the API decodes each WebAuthn response and requires the ceremony type and the realm's own
  origin. An assertion made on the app can't be used to sign in to admin.
- **Changing passkeys:** adding or removing a passkey needs a sign-in within the last 10 minutes (`reauth_required`
  otherwise), and the account is emailed about every change.
- **Relying party:**
  - RP ID: `midnightpoetry.studio`.
  - RP origins: `https://zephyrapp.midnightpoetry.studio` and `https://zephyr.midnightpoetry.studio` only, so no other studio app's origin is accepted.

## Invites

- **Link:** `https://zephyrapp.midnightpoetry.studio/join#t=<token>`.
  - The token is 32 random bytes in base64url, stored as SHA-256.
  - It sits in the URL fragment, so it never reaches server logs or Referer headers.
- **Preview:** `POST /invites/preview` returns the email, inviter and expiry. Unknown, expired, revoked and used tokens all get the same 404.
- **Redeem:** `POST /invites/redeem`. The API locks the invite row, then:
  1. Creates the user with the admin API (`email_confirm: true`, since the link proves the address). An address that
     already has an account gets the same 404 as a dead link, so an invite can never become a login link.
  2. Mints a session server-side: admin `generate_link` with type `magiclink`, then `verify` with the `token_hash`.
  3. Sets the session cookies. The confirm trigger marks the invite accepted, so the link works once.
  4. The app then offers "Sign in faster next time" (add a passkey).
- **Invite code:** `POST /invites/code` takes code, email and a Turnstile token.
  - If the code is live, the database atomically uses it once and creates an invite tied to that email, and the API emails the link.
  - An address that already has a live invite gets nothing new: no email, no rotation, no use of the code. Each
    address can get at most one code invite a day.
  - The reply is the same whether or not the code is valid.
  - Rate limit: 5 per network per 15 minutes.
- **Member invites:** limited by `member_invites_per_month` (default 3) and only when `member_invites_enabled` is on.
  Every attempt counts toward the quota, and member invites carry no free-text note (so they can't be used to email
  links from Zephyr's domain).
- **Admin invites:** up to 50 emails per call. Approving an invite request creates an invite and emails it.
- **Expiry and pausing:** invites expire after `invite_ttl_days` (default 7). `signups_paused` blocks every path.

## Admin

- **Access control, in layers:**
  1. Cloudflare Access protects `/admin*`; the API verifies `Cf-Access-Jwt-Assertion` against the team's certificates and the application AUD.
  2. A staff session, whose email must match the Access identity.
  3. A passkey.
- **Enrolment:** a staff member with no passkey can sign in once with an email code. That session can only enrol a passkey (`enrolOnly`).
- **Roles:**
  - Owner and Admin can change sign-up settings.
  - Only Owners can switch the sign-up mode.
  - Other roles get read-only access.
- **Audit:** every change goes to `audit_log` with the actor.
- **Pages:** only Sign-ups & invites is live in this phase. The other pages appear in the menu marked with the phase they arrive in.

## Hosting

- **App:**
  - `apps/web` (React + Vite PWA) is served by its own Worker on `zephyrapp.midnightpoetry.studio`.
  - `/api/*` goes to the API through a service binding.
  - The service worker caches only static files, never `/api`.
- **Admin:**
  - `apps/admin` (React + Vite, base `/admin/`) is built into the landing Worker's assets under `/admin`.
  - The landing Worker serves the admin SPA fallback and forwards `/admin/api/*` to the API.
- **Email:** Resend over HTTPS from the API Worker for invite emails. Supabase Auth sends sign-in codes through Resend SMTP, using the templates in `supabase/templates`.
