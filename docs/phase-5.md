# Phase 5: sharing

Mockups:
- PWA desktop canvas, row "Sharing": create link (passcode on and off), gallery live, shared galleries, gallery photos, favourites, activity, sharing & branding, guest gallery, send favourites, guest viewer, gallery ended, link not working.
- Phone canvas, row "Sharing": share sheet, shared galleries, guest gallery. The round-1 passcode screens (Guest, GuestLocked) still apply.

Contract: `packages/shared/src/share-types.ts` (browser-safe) and `share-schemas.ts` (zod, API only).

Decisions:
- **Delivery:** guest images are served by the API Worker on the Cloudflare Free plan, so there's no plan upgrade.
- **Passcode:** on by default, and members can turn it off for a gallery.
- **Plan features:** every plan feature ships now, including the Studio extras.
- **Full-size downloads:** copies of edited or RAW photos are rendered on the member's device and count toward storage while the gallery is live.

## Scope (SRS FR-SHR-01 to 03, NFR-SEC-01)

- **Galleries:**
  - A member shares a selection of photos (or an album's photos) as a gallery: a name, an optional message, an expiry, guest downloads (none, web size, or full size on Pro and above) and the Studio extras.
  - A gallery is its own list: photos can be added or removed later, and nothing in the library changes.
  - Up to 2,000 photos per gallery.
- **Link and passcode:**
  - Each gallery gets an unguessable link, `zephyrapp.midnightpoetry.studio/g/<43-char token>` (256 bits).
  - A 6-digit passcode is optional; it is on by default, and turning it off shows a warning.
  - The passcode is shown once. Afterwards the member can regenerate it (which ends every unlocked guest session) or turn it off.
  - The link can be copied again at any time from the gallery page. It is looked up by its SHA-256 hash and also stored encrypted (AES-256-GCM, key `GALLERY_LINK_KEY`, gallery id as associated data), so a database leak alone doesn't reveal links.
- **Expiry and revoke:**
  - Galleries expire at the end of the chosen day, capped by the plan's `max_link_days` (7 on Free) and a system ceiling of 365 days.
  - Revoke is permanent: the link stops working at once and the gallery's renditions are deleted.
- **Guests:**
  - A light page, separate from the app, at `/g/<token>`: a passcode screen when needed, then a masonry grid, a viewer, downloads (single photo, or the whole gallery as a .zip built in the browser), favourites, and "Send favourites".
  - Guests never see the mascot next to a client's photos (brand rule). The passcode and ended screens use it unless the member's branding is on.
  - No ads, ever.
- **Plan limits:** these are Admin-editable, with new `plan_limits` columns marked "new" below.

  | Limit                                      | Free   | Pro       | Studio    |
  | ------------------------------------------ | ------ | --------- | --------- |
  | Live galleries (`galleries`)               | 3      | unlimited | unlimited |
  | Longest link (`max_link_days`)             | 7 days | 365       | 365       |
  | Full-size downloads (`guest_full_res`)     | no     | yes       | yes       |
  | Guest favourites (`guest_favourites`, new) | no     | no        | yes       |
  | Watermark (`watermark`, new)               | no     | no        | yes       |
  | Branding (`branding`)                      | no     | no        | yes       |
  | Access log (`access_log`, new)             | no     | no        | yes       |

  Limits are enforced when a gallery is created or changed, and again when it is served. After a downgrade, features the plan no longer has stop working, but the gallery stays live.
- **Members:**
  - Shared galleries list.
  - Gallery page with Photos, Favourites (Studio), Activity (Studio) and Settings tabs.
  - Copy link, new passcode, open as a guest (preview for the owner, no passcode), revoke, reopen a paused gallery.
  - Settings › Sharing & branding (Studio): logo, studio name, accent colour (from a contrast-checked set), and a watermark (text drawn on the device, or the logo, plus position and opacity).
- **Reports:** "Report this gallery" (footer, or a single photo from the viewer) works without unlocking: a reason, optional details and Turnstile. Reports go to `gallery_reports`. A child-safety report emails `SAFETY_ALERT_EMAIL` at once (no image in the email) and is written to `audit_log`. Limit: 10 per network per day. Staff review comes in phase 8.
- **Owner preview:** `/g/preview/<galleryId>` shows the guest page to the owner (member session, no passcode, no events, no favourites or downloads).
- **Notifications:** emails through Resend when:
  - a gallery is paused after wrong passcodes;
  - a guest sends favourites (at most one email per gallery per hour, summarising);
  - a gallery is about to expire (3 days before).

## Passcodes and guessing (the passcode is a second lock; the link is the first)

- **Storage:** the code is stored as `HMAC-SHA256(GALLERY_PEPPER, galleryId ‖ generation ‖ code)`.
  - `GALLERY_PEPPER` is a Worker secret, so a database leak alone can't be brute-forced offline.
  - The check is constant-time.
  - A new passcode increments `generation`, which invalidates every unlock cookie.
- **Limits** (`PASSCODE_LIMITS`), counted per attempt before checking (the same pattern as email codes):
  - 5 failures per gallery per network (IPv6 grouped by /64) every 15 minutes, as SRS NFR-SEC-01 requires.
  - Turnstile after 2 failures from a network.
  - 25 failures per gallery from anywhere in 15 minutes pauses unlocking for 15 minutes and emails the owner (423 `gallery_paused`). Guests who already unlocked keep access.
  - Networks are kept only as HMAC hashes (as in phase 1). Attempt rows are deleted after 2 days.
- **Unknown tokens:** these get 404 after the same work as a real lookup, and token lookups are rate-limited per network (60 a minute), so links can't be enumerated.
- **Unlock cookie:** a successful unlock sets `__Host-zg-<first 12 hex of gallery id>`.
  - Its value is `HMAC(GUEST_COOKIE_SECRET, galleryId ‖ generation ‖ expiry)`, with a 12-hour expiry.
  - It is HttpOnly, Secure, SameSite=Lax and Path=/.
  - Galleries without a passcode need no cookie.

## Guest images

**How they're served.** All guest image bytes go through the API Worker. The Worker checks a signed URL and the gallery's state, then fetches the rendition from a dedicated media hostname, so it passes through Cloudflare's standard cache:
```
guest → /api/v1/g/<token>/m/<photoId>/<size>?e=<exp>&s=<sig>   (API Worker: verify, then fetch)
      → https://media.midnightpoetry.studio/<key>                (R2 custom domain, through the cache)
```

**The media hostname:**
- The `zephyr-shared` R2 bucket holds only renditions made for guests, at random keys `o/<ownerId>/g/<galleryId>/<photoId>/<size>-<nonce>` (branding assets under `o/<ownerId>/b/`). The owner prefix lets an account purge delete by prefix. Full-size renders from the member's device go to the photos bucket under `u/<ownerId>/g/…`. Deletions go through a queue drained by the clean-up job, which re-checks key shapes so it can never touch an original.
- Its custom domain is behind a WAF custom rule (Free plan: 5 rules), set up during deployment (`docs/setup.md`): _block_ when `http.host eq "media.midnightpoetry.studio"` and the `X-Zephyr-Media` header doesn't match a secret. The Worker sends that header; anyone else is blocked.
- The bucket has no r2.dev URL. Objects carry `Cache-Control: public, max-age=86400`.

**Child-safety scanning.** Content served through the Cloudflare cache is what the CSAM Scanning Tool hashes and checks. It is enabled on the zone at deployment.
- **Launch gate:** get Cloudflare support to confirm in writing that renditions fetched this way are scanned, and record the answer in `docs/setup.md`. This is the open question behind the Free-plan choice.
- **Blocked responses:** when Cloudflare blocks a URL, the media fetch returns a non-success status (451). The Worker then:
  - puts the photo on a safety hold (`photos.safety_hold_at`), which removes it from every gallery and blocks all serving and downloads of it, including to the owner;
  - suspends sharing for the account;
  - writes `safety.csam_match` to `audit_log` and emails `SAFETY_ALERT_EMAIL`.
- Held photos are excluded from every purge so they can be preserved for legal requests. Staff review comes with the admin Safety queue (phase 8).

**Signed URLs:**
- The signature is `HMAC(MEDIA_URL_SECRET, galleryId ‖ photoId ‖ size ‖ generation ‖ exp)`, and URLs last one hour.
- They are issued only in the photo list, after unlock.
- Each image request checks the gallery in the database, so revoking or expiry takes effect at once, even for URLs already handed out. A new passcode stops old URLs within 60 seconds (a cached state check).

**Renditions** are always re-encoded on the server with the Cloudflare Images binding (`IMAGES`) and never served from member uploads directly. Re-encoding strips metadata and normalises the image.
- **`grid` (640 px) and `view` (2048 px):** made from the member's edited preview (phase 4), or the original preview when the photo is unedited.
- **`full`:**
  - For unedited JPEG, PNG and WEBP, the original is re-encoded at full size.
  - For edited or RAW photos, the member's device renders a full-size JPEG after the gallery is created or the edit changes (the phase 4 exporter). It is uploaded to `PUT /galleries/:id/renders/:photoId?v=<editVersion>`, checked like an upload (signature, size, dimensions), then re-encoded. Until it's ready, guests see "Preparing" for that photo.
- **Watermark:** drawn into every guest rendition with `.draw()` when on. Text watermarks are drawn on the member's device as a PNG and uploaded like the logo, because the binding can't draw text. Originals and the member's own library never carry it.
- **When they're made:** lazily on the first guest request for that size, then reused. A rendition is keyed to the photo's edit version and the watermark version, so an edit or a watermark change makes a new one and the old one is deleted.
- **Storage:** rendition bytes count toward the member's storage while the gallery exists, recorded under the storage lock like edited variants. Grid and view renditions are recorded even when storage is full, so a full account doesn't break its galleries. Full-size renditions and device renders are refused when storage is full.
- **Cost:** the Images binding bills unique transformations (5,000 a month free, then $0.50 per 1,000; repeats in the same month count once). Enable Images Paid before launch so the free allowance can't run out mid-month.
- **Cleanup:** revoke, expiry and removal delete renditions (the clean-up job sweeps them). Cached copies at the media host can't be reached by anyone but the Worker, which refuses ended galleries, and they age out within a day.

## Data

- **`galleries`:**
  - Columns:
    - `id`, `owner_id`, `name`, `message`;
    - `token_hash` (unique, SHA-256 of the token), `link_hint`;
    - `passcode_hmac` (null = no passcode) and `passcode_generation`;
    - `expires_at`, `revoked_at`, `paused_until`;
    - `downloads`, the four extras, and timestamps.
  - RLS on, with nothing granted to browser roles.
- **Related tables:**
  - `gallery_photos (gallery_id, photo_id, position)`.
  - `gallery_renditions (gallery_id, photo_id, size, key, bytes, edit_version, wm_version)`.
  - `gallery_renders (gallery_id, photo_id, edit_version, status)`, for full-size renders from the device.
  - `gallery_guests (id, gallery_id, cookie_hash, name, note, sent_at)` and `gallery_favourites (guest_id, photo_id)`.
  - `gallery_attempts` for passcode limits, and `gallery_events` for the access log and counters.
  - `branding (owner_id, studio_name, accent, logo_key, watermark_*)`.
- **Retention:**
  - Events are kept 90 days. No IPs are stored, only HMAC network hashes for counting, cleared after 2 days.
  - Guests' names and notes are deleted with the gallery.
- **Functions:** all entry points are `security definer`, `search_path = ''` and service role only.
  - Member functions filter by owner; guest functions take the token hash and check status in the same statement.
  - The clean-up job adds: expire galleries; delete renditions of ended galleries after 1 day; delete gallery data 30 days after it ends; delete attempt rows after 2 days and events after 90.
- **Account purge** removes galleries, renditions in `zephyr-shared`, branding assets and guest data.

## API rules

- **Member routes:** a member session plus ownership, the pending-deletion gate, `EDIT_LIMITER`-style write limits (a new `SHARE_LIMITER`), and expected-user checks on writes.
- **Guest routes:**
  - Rate-limited per network (a new `GUEST_LIMITER`).
  - They never reveal whether a token exists beyond a 404, and never return photo ids or URLs before unlock.
  - Responses are `Cache-Control: no-store` (except media) with `Referrer-Policy: no-referrer`, so the token doesn't leak through the Referer header.
  - The guest page sets `<meta name="referrer" content="no-referrer">` and `robots: noindex, nofollow`.
- **Media responses:** `Cache-Control: private, max-age=3600` to the browser, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`, and `Cross-Origin-Resource-Policy: same-origin`. Downloads add `Content-Disposition: attachment` with a cleaned filename.
- **Favourites:** guests are identified by a random `__Host-zv` cookie (HttpOnly, 90 days) whose hash keys `gallery_guests`. "Send favourites" takes a name (1–60 chars) and an optional note (≤ 1,000), both plain text.

## Browser

- **Member side (`apps/web`):**
  - **Entry points:** a Share action in the library selection bar and on albums.
  - **Create dialog:** fields and states as in the mockups (passcode toggle with warning, plan-aware options with badges).
  - **Gallery live dialog:** shows the link and passcode once, plus "Preparing full-size downloads".
  - **Full-size render queue:** reuses the phase 4 exporter and the render-queue patterns. It is bound to the owner, reset at session end, resumes on the next visit, and its progress shows in the existing tray.
  - **Pages:** shared galleries list, gallery page tabs, Settings › Sharing & branding.
- **Guest side:** a separate Vite entry (`guest.html`, `src/guest/`).
  - It shares no session code with the member app and doesn't register the service worker, which also never serves `/g/*`.
  - Turnstile is allowed by the CSP on this entry only.
  - Zip downloads use fflate, loaded only on click and streamed like phase 4.
  - Accent colours come only from `BRAND_ACCENTS`, so nothing a member types reaches CSS.

## Security notes

- The link token is the capability. It is only ever in the URL path on the guest host and stored hashed, and every request that carries it is no-store and no-referrer.
- Turning a passcode off is the member's choice, and the UI warns about it. Every other protection still applies (unguessable link, expiry, revoke, signed media URLs, the media host closed to everyone but the Worker).
- Guests never receive original files unless full-size downloads are on, and even then they get a server re-encoded copy without metadata. Location data never leaves Zephyr.
- Branding assets are re-encoded server-side and served the same way as photos. Accent colours come from a fixed list; names and messages are plain text.
