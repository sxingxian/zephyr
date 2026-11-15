# Phase 8: Admin portal and storage switch

Mockups:
- **Admin canvas, rows "Admin portal · phase 8":**
  - Users (detail, Override plan, Suspend).
  - Safety (queue, hold, Reveal for review, revealed).
  - Plan limits (draft, Schedule).
  - Ads (sponsored cards, AdSense with its accepted risk, New card).
  - Storage (stores, health check, Switch, moving).
  - Retention, Staff & roles, Audit log, System settings.
- **Desktop app canvas, row "Admin follow-ups (phase 8)":** Replace a gallery link, Remove an Editor with "replace their links", Free plan with a sponsored card + AdSense behind Google's consent message, the retention Trash notice, the suspended-account screen.

Contract: `packages/shared/src/admin-types.ts` (browser-safe) and `admin-schemas.ts` (zod, API only). New error codes: `account_suspended`, `read_only_mode`, `last_owner`.

Decisions (15 November):
- **High-risk admin changes need a passkey sign-in in the last 10 minutes and email every Owner.** This covers plan limits, the storage switch, staff roles, plan overrides, unsuspending, releasing a hold, turning AdSense on and retention approvals. It replaces the database's two-person rule, which locked out a one-Owner team. Changes that only lower risk (suspending, ending a comp, cancelling a scheduled version, turning things off) save at once. Everything is audit-logged with a reason. A change that would change nothing (unsuspending an active account, lifting sharing that isn't suspended, giving someone the role they have, turning AdSense on when it's on with the same settings) writes no audit row and emails no one: the first three answer 409, and AdSense answers with its current state.
- **Free-plan ads: sponsored cards and Google AdSense, with Google's certified consent message (CMP) for the EEA, UK and Switzerland.**
  - AdSense's policy forbids ads in a frame, so its script runs inside the app.
  - Professional advice given and **risk accepted by the Owner:** that script can see what a Free member sees (private photos, file names) and act as them, and neither httpOnly cookies nor CSP can stop that.
  - Mitigations are listed under Ads below. AdSense stays off until an Owner turns it on with a passkey.
- **On-premises stores: both connections.** Workers VPC (a private Tunnel binding with no public hostname; beta, free during beta) is the default. A Tunnel hostname behind a Cloudflare Access service token is the fallback.
- **No cold storage yet.** R2 Infrequent Access saves about 33% but charges a retrieval fee on every view and only applies on R2. Revisit when lapsed storage is a real cost.
- **After the year of read-only storage:** the oldest photos beyond the Free plan's storage go to the member's Trash (30-day undo), after emails at 30 and 7 days and a staff approval per batch. Nothing within the Free plan's storage is touched, and held photos and photos in live galleries are skipped.
- **Plan limits: one version applies to everyone on a set date.** A version with only increases may apply now. Any decrease needs a date at least 30 days out, and the affected members are emailed when it's scheduled. This replaces the "at each subscriber's renewal" mode.

Professional notes (changes from the original design, with reasons):
- **Storage credentials never touch the admin screen or the database.** Stores (endpoint, bucket, connection, declared cost, capacity, encryption at rest) are declared in the API's deployment config (`STORAGE_STORES` var), and their keys are Worker secrets (`docs/setup.md` §3.8). Workers VPC services are bindings, so stores can't be added at runtime anyway. Admin › Storage checks the stores, compares cost and switches between them.
- **What moves:** the photo library bucket (originals, previews, thumbnails, edited variants, masks: everything under `u/<owner>/p/<photo>/`). Guest renditions and branding (`zephyr-shared`) stay on R2 behind the media host's cache, so the CSAM Scanning Tool keeps covering everything guests see. They are re-creatable derived copies, deleted when galleries end.
- **The store is tracked per photo** (`photos.store_id`). Every key of a photo lives under its prefix, so a photo moves as one unit and is read from wherever it is. In-progress uploads record their store (`uploads.store_id`), so a switch never splits a multipart upload.
- **Old copies are deleted only after every photo is verified** (a checksum of the original, recomputed by reading the new copy back), plus a 7-day hold for rollback.
- **The audit log is kept indefinitely** (it's append-only by trigger). The mockup's "2 years" is corrected.
- **Reveal for review** shows a re-encoded preview (≤ 1600 px, metadata stripped, `no-store`, the grant token bound to one staff member and 10 minutes), with the staff member's name overlaid in the admin app. Server-side name watermarks would need a dynamic image per reveal; not worth it for 10-minute grants.
- **The admin plan override** finally gives `profiles.plan_source = 'admin'` a writer (phase 7's open item). When an override ends, the plan goes back to what Stripe says.

## Data model (`20261115100000_admin.sql`, `20261115100100_storage.sql`)

All new tables: RLS on, no grants to anon or authenticated, SECURITY DEFINER functions with `search_path = ''`, `service_role` only. Every staff function takes `p_staff uuid`, checks the role in SQL (`_staff_can(p_staff, '<action>')`, the same table as `STAFF_CAN`) and writes `audit_log`.

**Users:**
- `profiles` gains:
  - `plan_override_plan`, `plan_override_until`, `plan_override_by`, `plan_override_reason`. `plan_source = 'admin'` while an override is on.
  - `suspended_at`, `suspended_category`, `suspended_by`.
  - `lapsed_at`: set by `billing_apply` when a paid plan ends, cleared on a new paid plan.
- `_plan_effective(owner)`: override if live, else Stripe (phase 7 rules). `billing_apply` and the cron keep working through it.
- **`admin_user_override(p_staff, p_user, p_plan, p_until, p_reason)` / `admin_user_override_end(...)`:**
  - recompute `profiles.plan_id`;
  - a downgrade through an override end follows the phase 7 lapse rules (read-only if over, `lapsed_at` set when it falls from paid to free).
- **`admin_user_suspend(p_staff, p_user, p_category, p_note)` / `admin_user_unsuspend(...)`:**
  - suspending sets `sharing_suspended_at` too (galleries offline) and ends every member session (`_auth_sign_out_all(user)` deletes `auth.sessions`/refresh tokens);
  - `profiles.sharing_by_suspension` records that the suspension alone took sharing offline. It is set only when sharing wasn't already suspended, and cleared by any other reason to suspend sharing (a Safety `suspend_sharing`, a hold from the scanner or from Safety). Unsuspending lifts sharing only when that flag is set and no photo is on hold; otherwise sharing stays suspended until `admin_user_sharing_lift` (its own high-risk action);
  - `library_access` returns null for teammates of a suspended owner.
- `admin_user_sign_out(...)`.
- **`admin_user_grant_credits(p_staff, p_user, p_amount, p_reason, p_reauthed)`** (the phase 6 `admin_adjust` ledger reason). The limits are checked under the granter's lock, then the member's credits lock, and totals come from the `users.credits` audit rows (which record the amount and the granter's role):
  - **Support and Safety:** at most 1,000 a grant, 5,000 in any 24 hours across all members, and 1,000 in any 24 hours to one member from Support and Safety together (`SUPPORT_CREDIT_*` in `admin-types.ts`). Over any of them: 403 `limit_reached`; an Owner or Admin can grant it.
  - **Owner and Admin:** a grant above 1,000, or one that takes the granter's own 24-hour total above 5,000, is large. It needs a recent passkey (`p_reauthed`; else 403 `reauth_required`) and emails every Owner.
- `admin_user_sharing_lift(...)`, `admin_user_deletion_schedule(...)` / `_cancel(...)` (Owner; reuses phase 2 deletion, sets `deletion_by_staff`, which the member's own restore refuses).
- `admin_users(p_staff, p_q, p_plan, p_source, p_status, p_cursor)`: keyset by `created_at, id`; masked emails; total from a cheap estimate when unfiltered. `admin_user(p_staff, p_user)` → `AdminUserDetail` (logs `user.viewed`).
- `member_suspended(p_user) → boolean`: checked in `requireMember` (cached per request). Sign-in for a suspended account answers `account_suspended`.

**Safety:**
- `safety_holds` view over `photos.safety_hold_at` plus a `safety_hold_reports(photo_id, authority, reference, recorded_by, recorded_at)` table.
- `gallery_reports` gains `resolved_by`, `resolution` jsonb, `resolution_note`.
- `reveal_grants(id, staff_id, report_id, photo_ids uuid[], token_hash, reason, expires_at, created_at)`: 10 minutes, never containing a held photo (checked in SQL).
- **Functions:**
  - `admin_safety(p_staff, p_state)`, `admin_report(p_staff, p_id)`;
  - `admin_reveal(p_staff, p_report, p_reason, p_token_hash)` (Safety only; returns the photo ids and keys of the previews);
  - `reveal_grant_check(p_grant, p_token_hash, p_staff, p_photo)`;
  - `admin_report_resolve(p_staff, p_report, p_actions, p_note)` (each action through the existing phase 5 functions: remove photos from the gallery, end the gallery, suspend sharing, hold photos; plus `admin_user_suspend`);
  - `admin_hold_report(...)`, `admin_hold_release(p_staff, p_photo, p_reason)` (Owner). A photo that isn't held answers null (404): no audit row and no Owners email.

**Plan limits:**
- `plan_limit_versions`:
  - drop `plan_limit_versions_two_person` and `_no_self_approval`;
  - add `effective_at timestamptz`;
  - status gains `scheduled` and `cancelled` (`approved` is unused from now on);
  - one draft and one scheduled version at most (partial unique indexes).
- **Functions:**
  - `admin_limits(p_staff)`;
  - `admin_limits_draft_create(p_staff, p_from)` / `_save(p_staff, p_limits jsonb)` / `_delete`;
  - `admin_limits_preview(p_staff, p_effective_at)`;
  - `admin_limits_schedule(p_staff, p_effective_at, p_reason)` (refuses decreases sooner than 30 days; returns the members to email, in batches, via `limits_notices_due(p_limit)`);
  - `admin_limits_cancel(p_staff, p_reason)`;
  - `limits_activate_due()` (cron: scheduled → active, old active → superseded).
- All plan readers already go through the active version.

**Ads:**
- `ad_cards(id, advertiser, headline, body, url, placements text[], starts_at, ends_at, weight, image_key, image_version, status, created_by, updated_at)`.
- `ad_stats_daily(card_id, day, placement, impressions, clicks)`: counts only, no member or network ids.
- AdSense config in `app_settings` (key `adsense`: enabled, publisher id, slots, enabled_at, enabled_by).
- **Functions:**
  - `admin_ads(p_staff)`, `admin_ad_card_save(...)`, `admin_ad_card_delete(...)`, `admin_ad_image_set(...)`;
  - `admin_adsense_set(p_staff, p_patch jsonb, p_reason)` (enabling: Owner; the API checks reauth);
  - `ads_for_member(p_user)` (empty unless the effective plan has `ads`);
  - `ad_event(p_card, p_kind, p_placement)` (upsert-increment; rate-limited per member in the API).

**Retention:**
- `retention_items(owner_id pk, lapsed_at, due_at, over_bytes, photos_to_trash, notice_30_at, notice_7_at, state, approved_by, approved_at, trashed_at, resolved_at)`, refreshed by `retention_sweep()` (daily).
  - A lapsed library over the Free storage enters at `lapsed_at`.
  - Notices are due at `due_at − 30d` and `− 7d`.
  - The state becomes `ready` once `due_at` has passed and both notices are sent.
  - The item is resolved if the member renews or gets under the limit.
- `admin_retention(p_staff)`, `admin_retention_approve(p_staff, p_owner_ids, p_reason)`.
- `retention_trash_batch(p_owner, p_limit)`: moves the oldest photos (by `taken_at`, then `created_at`) to Trash until the library is under the Free storage. It skips held photos and photos in live galleries, and is idempotent.

**Staff:**
- `staff_invites(id, email citext, role, token_hash, created_by, created_at, expires_at, accepted_at, revoked_at)`, 72 hours.
- **Functions:**
  - `admin_staff(p_staff)`;
  - `admin_staff_invite(p_staff, p_email, p_role, p_token_hash, p_reason)` (Owner);
  - `staff_invite_accept(p_token_hash) → { inviteId, email, role, existingUserId }`, which only checks the link. An address that belongs to a member answers `member_account`, and one that belongs to current staff answers `already_staff` (both 409 `conflict`). Otherwise the API creates the staff auth user the same way the first Owner was created, or reuses `existingUserId` for a former staff member. `staff_invite_complete(p_invite_id, p_user_id)` then uses the invite up and adds the staff row. A former staff member's auth user is unbanned only after that succeeds, so a second accept of the same link that loses the race changes nothing at Auth. If completing fails or throws, a user created just now is deleted unless `account_kind` already says staff (a commit whose reply was lost). The normal admin email-code + passkey enrolment follows;
  - `admin_staff_set_role(...)`, `admin_staff_remove(...)` (both refuse to leave zero Owners: `last_owner`; removal ends their admin sessions).
- **Former staff:**
  - `admin_staff_remove` records the person in `former_staff(user_id, display_name, role, removed_by, removed_at)` (RLS on, no grants).
  - The auth user is kept, because audit rows and invites point at it, but the API bans it in Supabase Auth.
  - `account_kind` answers `former_staff`, which neither sign-in accepts, and `get_session_profile` reports the account as staff-side, so the member app refuses it too. The address can't receive member invites.
  - The audit log keeps showing their actions as "Name (former staff)" with the role they last held.
  - A new staff invite for the address brings them back.
- `staff_lookup` already rejects removed staff.

**Audit:**
- `audit_log` gains `kind` (generated from the action prefix: `users.`, `safety.`, ...).
- `admin_audit(p_staff, filters, p_cursor)` (keyset by id desc).
- `admin_audit_export(p_staff, filters)` (≤ 50,000 rows; Owner/Admin; the export itself is logged).

**Settings:**
- `app_settings` keys: `read_only` (on, auto, message, since), `maintenance` (notice).
- `admin_settings(p_staff)`, `admin_settings_set(p_staff, p_patch, p_reason)`.
- `app_status()`: public data only, for `/api/v1/status`.
- `read_only_auto(p_on boolean, p_reason text)`: for the storage health check.

**Storage (`20261115100100_storage.sql`):**
- `photos.store_id text not null default 'r2'`, `uploads.store_id text not null default 'r2'`.
- `storage_state(singleton: write_store, updated_at)`.
- `storage_checks(store_id, at, result jsonb)`: keeps the last 50 per store.
- `storage_migrations(id, from_store, to_store, state, direction ('forward' | 'back'), started_by, started_at, reason, delete_old_after, last_error, topped_up_at)`.
- `storage_migration_items(migration_id, photo_id, src, dst, state ('pending','copied','verified','failed','deleted','skipped'), bytes, attempts, error, lease_until, token, stamp, cleanup_store, deleting_at, cleaned_at)`.
- Store ids follow one rule everywhere: `STORE_ID_RE` in `admin-schemas.ts` = SQL `_store_id_ok` (a lower-case letter, then lower-case letters, digits and dashes, 2-32 characters). Secret names map dashes to underscores.
- **Stamps:** `photos.write_seq` and `photo_edits.write_seq` take a fresh number from one sequence whenever a photo's variant columns or its edit row are written (triggers), and masks are stamped by their id set. `_photo_stamp(photo)` combines the three, so any write that records an object under the photo's prefix changes it (including `record_edit_variant`, which doesn't touch `updated_at`).
- **Functions:**
  - `storage_switch(p_staff, p_to, p_reason)`: one migration at a time. It sets the write store, enqueues every photo on the old store (uploads in progress included), and records new uploads with the new store at once. With nothing to move it's done at once.
  - `storage_migration_batch(p_migration, p_limit)`: under the storage lock, walks pending items in order (a partial index, so it stops at the limit) and checks each: a photo that went away is skipped, a photo still uploading or publishing its variants (`publish_pending`; its staging copies sit outside the photo prefix) is put back for 2 minutes without counting an attempt, and the rest are claimed with a 10-minute lease and a fresh token each. About 4 ms a batch with 200k photos queued (2–6 s before).
  - **Late arrivals:** a photo whose insert read the write store just before a switch or rollback committed lands on the store being emptied. Batches look for them at most every 2 minutes, and again before the migration finishes, among photos created since the last look (an index range on `photos (store_id, created_at)`); switches and rollbacks look at every photo there. A photo that already has an item is never touched by these looks.
  - **Finishing:** photos still uploading or publishing on the store being emptied are pending items, so a migration can't finish (holding, done or rolled back) while any remain. An upload that expires is purged, which skips its item. A forward move with no old copy to delete is done at once, so it never blocks the next switch.
  - `storage_item_touch(p_migration, p_photo, p_token)`: renews one item's lease just before it's copied and takes the stamp then. Returns the keys a copy must include (the original, the variants the photo has, recorded edited variants and masks) and the original's size. Null for any token but the current one.
  - `storage_item_mark(..., p_token, p_store)`: only the current lease's token can report an item. `verified` needs at least the original's size in bytes and flips `photos.store_id` in the same transaction under the photo's row lock, only while the stamp is unchanged, so readers switch atomically.
  - `storage_migration_action(p_staff, p_action, p_reason)`: resume and retry carry on in the migration's direction, so a failed or paused rollback stays a rollback.
  - `storage_old_copies_due(p_limit)` lists old copies once every item is verified and the hold has passed. `storage_old_copy_claim(p_migration, p_photo, p_store)` claims one under the storage lock before it's deleted. From the first claim on, the move can't be rolled back (`rollback_closed`; Admin hides the button). It says whether missing objects go to the photo's store first: only for a photo that moved and is still ready or in Trash (never one being purged). A deletion is reported with `storage_item_mark(..., 'deleted', p_store => the store emptied)`.
  - `storage_status()` also says `cleanupPending`: some migration (finished or rolled back included) still holds old copies, or a follow-up copy is outstanding, so the orphan sweep leaves copies away from their photo's store alone.
  - `storage_followup_add / storage_followups_due / storage_followup_done`: follow-up copies (`storage_followups(photo_id, key, from_store, attempts, next_at)`, RLS on, nothing for anon or authenticated). See "Writers" under API.
  - `storage_photo_store(p_photo)`: where a photo is now (see "Writers" under API).
  - `storage_usage()`: objects and bytes per store, from three grouped scans (photos, edits, masks); `admin_storage` derives its totals from it (about 0.35 s for 200k photos, 3.2 s before). A migration's `bytes.total` is approximate while photos move (photos not copied yet count their original and variants), and `photos.waiting` counts queued photos still uploading or publishing.
  - `ai_mask_key`, `bulk_photos` (delete forever) and `empty_trash` name each photo's store, like the other wrapped functions.
- **Rollback:** writes go back to `from`. Photos not moved yet stay put (a partial copy is cleaned up), photos already moved get copy items in the other direction (the same pipeline), and photos on the new store with no item (uploaded, or still uploading, since the switch) are queued back too. Available while the move goes forward and no old copy's deletion has started.
- **Lock order:** the storage advisory lock, then the migration row, then item rows, then the photo row. Photo writers take only the photo row.

## API

**Storage (`apps/api/src/storage/`):**
- `ObjectStore` (phase 5 seam) gains multipart: `createMultipart(key, contentType) → uploadId`, `uploadPart(key, uploadId, n, body, length) → etag`, `completeMultipart(key, uploadId, parts)`, `abortMultipart(...)`.
- **Backends:**
  - `r2Store` (binding).
  - `s3Store` (aws4fetch SigV4, path-style or virtual-host per config, streaming `UNSIGNED-PAYLOAD` bodies with `Content-Length`, XML parsing for list/multipart via a tiny parser without DOMParser).
  - A `fetcher` hook so the same S3 code runs over a Workers VPC binding (`env[binding].fetch`) or over a Tunnel hostname with `CF-Access-Client-Id/Secret` headers.
- `storeFor(env, storeId)` reads `STORAGE_STORES` (validated once per isolate) and the matching secrets: `STORE_<ID>_ACCESS_KEY_ID`, `STORE_<ID>_SECRET`, and for tunnels `STORE_<ID>_ACCESS_CLIENT_ID/SECRET`. An unknown id → 503 `server`.
- **Every `env.PHOTOS` use goes through `photoStore(env, photo.store_id)`:** uploads, completion copies, photos, edits, masks, the AI consumer, jobs and purges. A grep test fails the build on a direct `env.PHOTOS` outside `storage/`.
- Account purge and Trash purge delete each photo's keys on its own store. Account purge also lists the owner prefix on every configured store to catch leftovers.
- **Migration:**
  - The queue `zephyr-storage` (consumer in the API Worker) takes batches of 20 photos.
  - For each object under the photo's prefix, it streams the source into the destination (SHA-256 computed while streaming), then reads the destination back and compares the hash, then marks the item verified.
  - Each item's lease is renewed just before it's copied. A copy counts only if the original was copied from the source, every other key `storage_item_touch` listed was copied or is already on the destination (an object whose follow-up copy hadn't reached the new store, met again by a rollback; keys are never rewritten with different content), and it weighs at least the original; an empty or partial listing is never a copy.
  - Failures retry with backoff; the fifth attempt (counted by the claim) becomes `failed`, which is shown in Admin and retryable.
  - The 5-minute cron re-enqueues a batch for a migration that's copying, rolling back, verifying or holding, deletes up to 50 old copies once due, and retries up to 50 follow-up copies. Each deletion is claimed first, and a missing object is copied forward only for a photo that moved and is still ready or in Trash.
  - **Writers:** an edited variant or mask is stored on the store read before writing, then recorded. After recording, the writer calls `followMove`: if `storage_photo_store` now says another store, the object is copied there. The record changes the photo's stamp and the flip checks it under the photo's row lock, so either the copy in flight is refused and redone, or the photo had already moved and the object follows it. The copy is recorded as a follow-up first and cleared once done; one that fails (or a Worker that stops half-way) is retried by the cron with a growing backoff, to wherever the photo is then. Upload variants never need this: publishing photos aren't moved.
- **Health check:**
  - A cron every 5 minutes checks the write store (reachability, a signed write/read/delete round trip, latency); on demand from Admin it also measures upload speed (a 4 MB object) and free space (declared capacity minus usage, or the store's own report where it has one).
  - Three failures in a row on the write store turn on `read_only_auto` and email the Owners. Two successes turn it off (auto only, never a manual read-only).
- **Read-only mode:** an app-wide gate (`library/read-only-gate.ts`, before any route) checks `app_status().readOnly` (cached 15 s per isolate) for every write under the library prefixes (`uploads`, `photos`, `albums`, `trash`, `recipes`, `ai`, `galleries`, `me/branding`) and answers 503 `read_only_mode`. A route added later under these prefixes therefore starts closed. `requireWritable` (phase 7) also checks it. Reads, downloads and guest galleries still work. **The rule:** anything that adds or changes library content, or writes bytes, is refused. Anything that only reduces exposure, or finishes work already started, stays open:

  | Stays open in read-only mode                                                                           | Refused                                                                                                                                   |
  | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | Upload parts, variants, complete and abort for an upload that already started                          | New uploads                                                                                                                               |
  | `photos/bulk` trash, restore, delete forever; `trash/empty`                                            | `photos/bulk` favourites and albums; photo renames; edits of any kind (save, revert, variants, bulk paste/apply/revert)                   |
  | Gallery: end it (`DELETE`), replace its link, set a new passcode, remove photos                        | New galleries; gallery settings (`PATCH`, including a new expiry: end the gallery instead); adding photos; renders; removing the passcode |
  | Zephyr AI: cancel or pause a job, "Turn off and delete" face data                                      | New jobs and retries; device-job claims and progress; signals, faces, people, cleanup, settings                                           |
  | Branding: remove an image                                                                              | Branding changes and new images                                                                                                           |
  | Account-level routes: sign-in, `/me`, billing, team membership (including removal with `replaceLinks`) | Albums and recipes                                                                                                                        |

**Admin routes (`routes/admin-users.ts`, `admin-safety.ts`, `admin-limits.ts`, `admin-ads.ts`, `admin-storage.ts`, `admin-retention.ts`, `admin-staff.ts`, `admin-audit.ts`, `admin-settings.ts`):**
- Every route uses `requireStaff()` plus a `staffCan` check, so a role can't call a route its screen hides.
- **Reauth:** every write named under "High-risk" checks `recentPasskey` (403 `reauth_required`; the admin app re-prompts like Admin › Zephyr AI).
- **Owner emails** go through `ai_alert_recipients('owners')` and a new `email/admin-templates.ts`: plain text and HTML, escaped, no member emails or photo names.
- Rate limit: `ADMIN_LIMITER` (namespace 1012; 60 a minute per staff member) on admin writes.

**Member routes:**
- `/api/v1/status`: no session, `Cache-Control: public, max-age=30`.
- `/api/v1/ads`, `/api/v1/ads/events`: `ADS_LIMITER` (1013; 120 a minute per member).
- The ad image is public, `immutable`, re-encoded through the Images binding at upload.
- `galleries/:id/link/replace`: the galleries role; rotates the link token and its encrypted copy, kills guest sessions for that gallery, and logs to the owner's activity.
- `TEAM_API.member` DELETE `?replaceLinks=1`: rotates every live gallery's link in that library in one transaction (phase 7 `liveGalleries`).
- **Suspension:** `requireMember` → 403 `account_suspended` and the session cookies cleared. Guest galleries of a suspended owner answer as unavailable.

**Crons (existing scheduled handler):**
- every 5 min: storage health, keep migrations moving (re-enqueue a batch), and old-copy deletion (up to 50 per run);
- 15 min (existing): `limits_activate_due`, notices, plan override expiries;
- daily 02:20 UTC: `retention_sweep`, retention notices, ad status (scheduled → live → ended).

## Ads (member app)

- Free members only: the effective plan has `ads` and the library is their own. A team library never shows ads (Studio).
- **AdSense never goes to a member of any team library** (`ads_for_member`, mirrored in the app), even in their own library. Their session reaches every library they're in, through `X-Zephyr-Library`, and the team's owner didn't accept the risk. They still get sponsored cards.
- **Placements:** Library grid (after the first 24 tiles, then every 48), sidebar card, batch queue. Only on the library pages listed in `apps/web/worker/adPages.js` (Library, Favourites, Albums, People, Scenes, AI queue). Never in the editor, viewer, sharing, billing, settings, sign-in or guest galleries.
- **Sponsored cards:**
  - Rendered by the app from `/api/v1/ads` and labelled "Sponsored". Links open in a new tab with `rel="noopener noreferrer sponsored"`.
  - Impressions are sent once per card per page view when 50% visible for 1 s; clicks on activation.
  - The database counts at most one impression and one click per member, card and UTC day, and only from members who are shown ads. The dedup key is HMAC(member, day, card, kind) in `ad_event_seen`, kept for two days and never joined to the stats.
- **AdSense, only when `adsense` is present in `/api/v1/ads`:**
  - The app loads `adsbygoogle.js?client=<publisherId>`, whose built-in consent message is Google's certified CMP (Privacy & messaging).
  - It renders `<ins class="adsbygoogle">` units only in the placements above.
  - **Once the script is loaded, a page without ads is never rendered in that document.** The route gate opens it with a full page load instead, which drops the script, and the Worker serves it with the strict CSP.
  - A document first loaded on a page without ads (strict CSP) reloads when the member arrives on an ad page with AdSense to show, for example after signing in.
  - The page reloads when the member the script was loaded for is gone (sign-out, an ended session, another member) or no longer gets ads. That includes an upgrade or a staff override made in this tab, another tab or another device: tabs broadcast plan changes, and a tab holding the script re-reads the session every 2 minutes and on focus.
  - Any 401, or a session found ended, goes to sign-in with a full page load.
  - Auto ads, anchor and vignette ads must stay off in the AdSense console (`docs/setup.md` §3.9). The code can't enforce this.
- **CSP:**
  - The app Worker serves HTML responses (`run_worker_first: true`; static files still come from ASSETS untouched).
  - It adds Google's ad and consent hosts to `script-src`, `frame-src`, `img-src` and `connect-src` only for documents on the ad pages, and only while AdSense is enabled. Every other document gets the strict policy. So does `/index.html`, which is served directly rather than redirected to `/`, because the service worker precaches it as the offline fallback.
  - The config is read from the API with a 60-second cache in both Workers, and the public endpoints are rate-limited per client network.
  - `scripts/csp.mjs` checks both variants, and that the ad pages are anchored and cover no sensitive page.
  - `/ads.txt` is served by the app Worker from the configured publisher id; it 404s when AdSense is off.
- **Residual risk (accepted, see Decisions):** Google's script runs with the Free member's privileges on the library pages of the page loads where it's loaded. `docs/security.md` item 18 records this.

## Admin app (`apps/admin`)

New pages matching the mockups: Users, Safety, Plan limits, Ads, Storage, Retention, Staff & roles, Audit log, System settings.
- **Navigation:** nav items appear only for roles that can view them; the matching routes 403 server-side too.
- **Writes:** every write dialog asks for a reason. The ones the API marks high-risk use the same `withReauth` retry as phase 7.
- **Reveal:**
  - Images are fetched with the grant token and shown blurred until the reviewer clicks each one.
  - The reviewer's name and the expiry time are overlaid.
  - Images are removed from the DOM and their object URLs revoked at expiry or on navigation, and never kept in a cache (`no-store`, `cache: 'no-store'`).
- **Staff invite accept:** `/admin/staff-invite#t=…` (fragment, stripped on load), then the existing email-code → passkey enrolment.

## Web app (`apps/web`)

- **Status banner:** read-only and maintenance notices from `/api/v1/status`, polled every 2 minutes and on `read_only_mode` errors. Write entry points are disabled while read-only.
- **Ads:** as above.
- **Gallery settings:** Replace link (dialog), shows the new link once.
- **Team:** the removal dialog with "Replace the links of N galleries" (on by default when N > 0). The API replaces every live or paused gallery's link, in chunks of 500 (`GALLERY_LINKS_REPLACE_MAX`), before removing the member. If any chunk fails, the member stays.
- **Suspended:** `account_suspended` from any call ends the session and shows the suspended screen (sign-in too).
- **Retention notice:** the Library shows the "moved to Trash" banner when the member's own library had a retention batch in the last 30 days (`/me` gains `retention: { trashedAt, photos, restoreBy } | null`).

## Security checklist

- **Staff:** every admin route checks the staff role server-side, and every staff SQL function re-checks it. High-risk writes need a recent passkey and email the Owners. There's always at least one Owner. Staff invites are email-bound, single-use, hashed, 72 hours, and still gated by Cloudflare Access.
- **Members' privacy:** lists mask emails; the detail view is logged. Staff never get photo bytes except through a Safety reveal grant (one staff member, 10 minutes, `no-store`, never for held photos, logged with a reason).
- **Suspension:** sessions are ended in Auth, not only by cookie. Teammates and guests lose access at once.
- **Storage:**
  - Credentials only in secrets.
  - S3 requests are signed; tunnel requests also carry the Access service token; the Workers VPC binding has no public hostname.
  - A photo flips store only after its copy is verified (every recorded key, at least the original's size, reported by the current lease), and old copies are deleted only after the hold and a claim that closes rollback.
  - Purges cover every store.
  - Responses never leak store endpoints, keys or bucket names to members.
  - Store error bodies are never logged; only short codes are.
- **Ads:**
  - Card URLs are https only with no credentials, and images are re-encoded.
  - Stats hold no identities.
  - The AdSense CSP widening applies only while it's on.
  - AdSense is never loaded on paid plans, in team libraries, or on sensitive pages, and an upgrade or account change reloads the page.
- **Read-only mode:** enforced server-side for every library write by the app-wide gate; only exposure-reducing writes and already-started uploads stay open (table under API).
- **Retention:** only beyond the Free storage, never held photos or live-gallery photos, only after both notices and a staff approval, and always into Trash (30-day undo).
- **Audit:** append-only, with reasons. Exports are limited and logged.

## Build plan (forks)

1. **Database:** both migrations plus tests (`90_admin_test.sql`, `95_storage_test.sql`, `92_admin_race.sh`).
2. **API admin:** the admin routes, member routes (status, ads, link replace, team replaceLinks), suspension, read-only enforcement, emails, crons for limits/retention/ads.
3. **API storage:** the store backends, the refactor of every `env.PHOTOS` use, the migration queue, health checks, auto read-only, the admin storage routes, wrangler (queue, VPC/tunnel config docs).
4. **Web:** member side + the app Worker (HTML CSP variants, `ads.txt`).
5. **Admin:** all pages.

## Tests

- **SQL:**
  - role checks on every staff function;
  - override and expiry;
  - suspend/unsuspend effects (sessions, sharing, `library_access`);
  - reveal grants (expiry, held photos refused, staff binding);
  - resolve actions;
  - limits (draft, decreases need 30 days, activate, cancel; no two-person constraint left);
  - ads counters and member gating;
  - retention (entry, notices, ready, batch trashes oldest beyond Free only, skips held and live-gallery photos, resolves on renewal);
  - staff (invite accept once, last Owner);
  - audit filters;
  - storage (switch, batch leases, verified flips the store, rollback, old copies only after verify plus hold, usage);
  - RLS for every new table.
- **Race:** two parallel role changes can't leave zero Owners; migration item claims don't double-process; retention approve twice trashes once.
- **API:**
  - every admin route: role matrix and reauth;
  - the S3 backend against a mock S3 (signing, streaming put, multipart, list XML);
  - migration copy/verify with a mismatch;
  - health check, auto read-only on and off;
  - read-only enforcement on library writes;
  - suspension 403 and cookie clear;
  - ads endpoints and gating;
  - link replace and team replaceLinks;
  - the `env.PHOTOS` grep test.
- **Web:** status banner; read-only disabling; sponsored card render and events; AdSense loader only for Free with config, unmounted on sensitive routes, reload on upgrade; replace link; team removal toggle; suspended screen.
- **Admin:** each page's role visibility, reason required, reauth retry, reveal grant handling (no-store, cleared at expiry), limits scheduling rules in the UI.

## Launch gates added by this phase

- Put Cloudflare Access in front of `/admin` for every staff email (already required); add each invited staff member's email to the Access policy.
- For each extra store, follow `docs/setup.md` §3.8 (bucket, keys as secrets, encryption at rest confirmed, `STORAGE_STORES` entry; for on-premises, the Tunnel and Workers VPC service or the Access-protected hostname), then run a health check before switching.
- AdSense:
  - get the site approved;
  - set up the European regulations message in AdSense › Privacy & messaging;
  - have counsel review the privacy notice for ads and the accepted script risk;
  - keep AdSense off until then.
- Have counsel approve the CSAM reporting process recorded on holds.
