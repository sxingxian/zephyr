# Phase 6: Zephyr AI

Mockups:
- **PWA desktop canvas, row "Zephyr AI (phase 6)":**
  - Editor · Zephyr AI (after auto-enhance); background removed (white, and transparent).
  - Library · Zephyr AI for 12 selected; AI queue.
  - People when off, the consent dialog, People while grouping, one person's page.
  - Scenes, Cleanup, Settings › Zephyr AI with credits (cloud paused).
- **Phone canvas, row "Zephyr AI":** editor AI tab, background removed, AI queue, face-grouping consent, People.
- **Admin canvas:** AI jobs, Zephyr AI controls.

Contract: `packages/shared/src/ai-types.ts` (browser-safe) and `ai-schemas.ts` (zod, API only). Also:
- the recipe's new `cutout` section, `PASTE_SECTIONS` and the cut-out `RANGES` in `edit-types.ts` and `edit-schemas.ts`;
- `plans.ts` `qualityCleanup`;
- the `scene` and `person` filters on `PhotoListQuery`;
- the `insufficient_credits` and `feature_off` error codes.

Decisions (1 November):
- **Background removal:** Runware BiRefNet (`runware:112@5`, US$0.0006 a photo) is the default until the 50-photo bake-off. fal's Bria RMBG 2.0 (US$0.018) is the fallback. Both go through AI Gateway, and switching is a setting.
- **Face data:** found on the device and kept in the account, so it works across devices. One switch deletes it.
- **Admin › Zephyr AI** is built in this phase. Cloud AI never goes live without the kill switch and the spend caps.
- **Scene tags:** Workers AI ResNet-50 on the 512 px thumbnail, mapped to 14 scenes; Night is decided on the device.

Professional notes (changes from the plan doc, with reasons):
- **Bria costs more than it earns.** At US$0.018 a photo it costs more than a top-up credit sells for (about US$0.01). Credits per photo are therefore an admin setting (`bgCreditsPerPhoto`), not a constant.
- **Admin changes save without a second approver.** Two-person approval would lock a one-person team out of its own kill switch. Instead:
  - changes that can only lower risk save at once;
  - anything else needs a passkey sign-in in the last 10 minutes and emails every Owner (`isRiskLowering`).
- **HDR & interior balance sets sliders.** It writes the existing highlights, shadows, whites, blacks, contrast and exposure sliders. Highlights and shadows are already local (they use the blurred luminance base in the pipeline). A separate local tone-mapping stage can come later if real interiors need it.
- **Colour match sets sliders.** It approximates Lab statistics transfer with exposure, contrast, temperature, tint, saturation and vibrance, so the result stays editable and looks the same everywhere.
- **Masks don't count toward storage.** They are small greyscale PNGs, at most 2 MB each, with no more than 2 per photo. Recipes don't count either, and this keeps the storage invariants of phases 3–5 untouched.
- **Credit periods are calendar months in UTC** until phase 7 brings Stripe subscription periods.
- **There's no "Places".** Place names would need a reverse-geocoding service, which isn't in scope; the nav item is "Scenes".

## Scope (SRS FR-AI-02, FR-AI-03, FR-AI-04, FR-GAL-02, NFR-PERF-03)

| Feature                                                      | Where                 | Plan                                 | Cost to the member              |
| ------------------------------------------------------------ | --------------------- | ------------------------------------ | ------------------------------- |
| Auto-enhance (exposure, white balance, contrast, skin tones) | Device                | All                                  | Free                            |
| HDR & interior balance                                       | Device                | All                                  | Free                            |
| Colour match (reference photo)                               | Device                | All                                  | Free                            |
| Cleanup: duplicates, blurry, similar bursts                  | Device                | Pro, Studio (`quality_cleanup`, new) | Free                            |
| Face grouping (opt-in)                                       | Device + account      | Pro, Studio (`people_grouping`)      | Free                            |
| Scene tags                                                   | Cloud (Workers AI)    | All (member can turn off)            | Free                            |
| Studio background removal                                    | Cloud (Runware / fal) | All                                  | `bgCreditsPerPhoto` credits (1) |

`AiStatus.features` tells the app the state of each feature: on, off in Admin, not on the plan, off by the member, or paused.
- When the master switch is off, every AI control is hidden and the app shows "Zephyr AI is paused".
- Manual editing always works.
- The app never downloads a model for a feature that is off.

## Credits

- **Balance:** `credit_balances` (one row per member) plus `credit_ledger` (every change, with reason and job).
- **Locking:** every change takes `pg_advisory_xact_lock(hashtextextended('credits:'||owner,0))`. The balance can't go below 0 (check constraint).
- **Periods:** calendar months (UTC).
  - The first touch of a new period (status, a charge, or the 15-minute cron for active members) runs `_credits_roll(owner)`.
  - It expires the unused balance (`period_expiry`, unless `plan_limits.credits_rollover`), then grants the plan's `cloud_credits_month` (`monthly_grant`).
  - Rolling is idempotent per `(owner, period_start)`.
- **Charge at enqueue:** creating a background-removal job charges `n × bgCreditsPerPhoto` in one `job_charge` entry.
  - If the balance is short, the whole job is refused (402 `insufficient_credits`, with `needed` and `balance`); nothing is partly queued.
- **Refunds:**
  - Each failed or canceled item is refunded (`job_refund`, one entry per item, labelled with the file name), so the queue and history agree.
  - A refunded item is never charged twice. A retry charges again, through a new `job_charge`.
- **Top-ups:** `top_up` and `admin_adjust` exist in the enum for phases 7 and 8; nothing writes them yet.

## Cloud work: queue, providers, caps

**Queue.** A Cloudflare Queue, `zephyr-ai`, is consumed by the API Worker itself (`queue()` handler). The producer binding is `AI_QUEUE`, with `max_batch_size` 5, `max_retries` 3 and a dead-letter queue `zephyr-ai-dlq`. There are two message types:
```
{ t: 'bg',    item: <ai_job_items.id> }
{ t: 'scene', photo: <photos.id>, owner: <uuid> }
```
Messages carry ids only, never image bytes or URLs. The consumer:
1. reloads everything from Postgres;
2. checks the item still exists, isn't canceled, and the photo isn't trashed or deleted;
3. checks the feature is on;
4. reserves spend;
5. calls the provider;
6. records the outcome.

**Waiting instead of failing.** When a cap is reached or an admin paused cloud work, the item goes back to `pending` with `wait_until`. The message is acked, and the cron re-enqueues waiting items at `wait_until`, or after 00:00 UTC for a cap. Nothing is refunded for waiting.

**Stuck items.** An item stuck in `processing` for more than 10 minutes is retried once by the cron, then failed and refunded.

**Background removal, per item:**
1. **Source:** the photo's untouched preview (`PHOTOS` key `…/preview`, at most 2048 px), never the original. With no preview → `no_preview`, refunded.
2. **Primary provider** (`bgProvider`), through AI Gateway:
   - **Runware:** `POST https://gateway.ai.cloudflare.com/v1/<AI_GATEWAY_ACCOUNT_ID>/<AI_GATEWAY_ID>/custom-runware/v1`, with body `[{ taskType: 'removeBackground', taskUUID, model: runwareModel, inputs: { image: 'data:image/jpeg;base64,…' }, outputType: 'base64Data', outputFormat: 'PNG', includeCost: true }]` and header `Authorization: Bearer RUNWARE_API_KEY`. The cost comes from the response's `cost` field; otherwise `costs.runwareMicros`.
   - **fal:** `POST https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/fal/<falModel>`, with body `{ image_url: 'data:…', sync_mode: true }` and headers `Authorization: Key FAL_KEY` and `X-Fal-Store-IO: 0`. The cost is `costs.falMicros`.
   - **Gateway auth:** when `AI_GATEWAY_TOKEN` is set, every call carries `cf-aig-authorization: Bearer <token>` (authenticated gateway).
   - **Development only:** without `AI_GATEWAY_ID` the calls go straight to the providers. Production refuses to start cloud work without a gateway.
3. **Timeouts and fallback:** 30 s per call, and the item is tried twice on the primary. After the second failure it goes to `bgFallback` once, if that's set. A provider whose output was rejected (`bad_output`) isn't asked again for that item. The provider used is recorded on the item.
   - **Reservation:** before the first call, `ai_item_begin` reserves the item's worst case (every primary attempt plus the fallback), so whatever the calls cost stays inside the caps; it's settled to the real cost afterwards.
   - **Failure budget:** provider failures are refunded, so once a member has `AI_FAILURE_BUDGET` (50) refunded provider failures in a UTC day, their further items wait until tomorrow.
   - **Concurrency:** the queue consumer runs at most 4 batches (20 items) at once (`max_concurrency`).
4. **Output check** (`apps/api/src/ai/png.ts`): the result is untrusted and goes through a strict PNG reader built on `fflate` inflate.
   - Signature and IHDR are checked.
   - Bit depth must be 8.
   - Colour types 0, 4 or 6 are accepted; anything else is `bad_output`.
   - Dimensions are checked straight after IHDR, before anything is allocated or inflated: no larger than the source preview, with its aspect within `MASK_LIMITS.aspectTolerance`.
   - The input is capped at `providerMaxBytes` (8 MB), and the IDAT data is inflated in 4 KB slices into a buffer of exactly the expected size. fflate inflates a whole push before calling back, so slicing is what stops a decompression bomb after a few MB.
   - The alpha channel is extracted (or grey, for type 0). The mask is scaled to the preview's size when it differs, then re-encoded as an 8-bit greyscale PNG (filter 0, fflate deflate).
   - A mask over `MASK_LIMITS.maxBytes` is `bad_output`.
   - The provider's RGB pixels are thrown away.
5. **Store:** `PHOTOS` key `u/<owner>/p/<photo>/m/<maskId>.png`, a row in `photo_masks`, and at most 2 masks per photo (older ones are deleted). If recording the row fails (or its reply is lost), the object is left alone: the orphan sweep deletes `m/` keys no row records once they're an hour old.
6. **Apply:** `ai_item_complete` records the mask and, in the same transaction, sets the photo's recipe `cutout` to `{ mask, …apply }` as a new edit version, the same as a save from another tab. It marks the edit unrendered so the app re-renders thumbnails. (There's no separate `ai_attach_mask` function.)
7. **Spend:** `ai_item_complete` / `ai_item_failed` settle the reservation to the real (or estimated) cost through `_ai_spend_settle`, on the day it was reserved. A report for an item that moved on meanwhile (canceled, or taken over as stuck) still records what its calls cost.

**Scene tags.** Upload complete enqueues `{t:'scene'}` when scene tags are on (Admin and member) and not capped. The cron backfills older photos of members with scene tags on, at most 500 per run. The consumer:
- reads the original thumbnail (`…/thumb`, 512 px);
- runs `env.AI.run(sceneModel, { image: [...bytes] }, { gateway: { id: AI_GATEWAY_ID } })`;
- maps the top-5 labels to scenes with `sceneForLabels` (`packages/shared/src/scene-map.ts`, generated from the 1000 ImageNet class names);
- stores rows in `photo_scenes`, plus `night` from the device signals;
- sets `photos.scene_state` (`done` / `failed` / `skipped`).

Failures are not retried more than the queue's retries. Turning scene tags off deletes the member's scene rows, and a result that arrives after that (or after Admin turned scene tags off) is dropped.
- `ai_scene_begin` returns the day it reserved on, and `ai_scene_done` settles on that day. If a run breaks after the reservation (R2 or the database), the consumer reports `retry`, which settles it.
- Photos that have to wait get `photos.scene_retry_at` instead of going straight back into the backfill: cap reached → tomorrow, cloud paused → 15 minutes, thumbnail not there yet or a broken run → 1 hour.
- The backfill skips members at their daily per-member cap and accounts scheduled for deletion, so one capped member can't fill every run.

**Spend caps:** `ai_spend_daily(day, feature)` and `ai_user_spend_daily(day, owner)` are in micro-dollars. `ai_spend_reserve(day, feature, owner, estimate)`:
- runs under an advisory lock per day;
- checks the total, feature and per-user caps against spent + reserved + estimate;
- either reserves the estimate or returns `capped` (with the cap that tripped).

After the call, the reservation is settled to the real cost. When a cap is first crossed on a day, and on each threshold in `alerts`, `ai_spend_alerts(day, scope, threshold)` makes sure an email goes to the Owners (and Finance with `owners_finance`) only once. With `atCap: 'alert_only'`, work continues past the cap but still emails.

**Member rate limits:**
- `AI_LIMITER` (namespace 1007): 120 AI writes a minute per member.
- `FACES_LIMITER` (namespace 1008): 10 face batches a minute per member.
- `AI_READ_LIMITER` (namespace 1009): 300 AI reads a minute per member.
- `memberJobsPerMinute` is enforced in Postgres for job creation.
- Face-data writes (add, merge, move, rename) wait at most 3 s for the member's faces lock (`lock_timeout`), then answer 429 with `Retry-After: 5` instead of piling up on the lock and the connection pool. (A function-level `statement_timeout` doesn't bound the running RPC in Postgres, so the work itself is bounded instead: see the people cap below.)

## Device features

All of these live in `apps/web/src/lib/ai/`. They load lazily, run off the main thread where they're heavy, and write only through the existing edit routes (`PUT /photos/:id/edit` with `baseVersion`, so a conflict means the device reloads and tries again once).

**Auto-enhance** (`enhance.ts`):
- **Proxy:** works on a 256 px proxy of the photo's develop input (the source the editor renders, RAW included), rendered through `develop.ts`, the CPU reference of the shader.
- **Light:** finds `light.exposure` by bisection so the median display luminance hits about 0.46. It then sets `whites`, `blacks`, `highlights` and `shadows` from the 0.5 % / 99.5 % percentiles and the clipped fractions, and `contrast` from the interquartile spread.
- **White balance:** grey-world on near-neutral pixels, mapped to `temperature`/`tint` by inverting `whiteBalance()`.
- **Colour:** vibrance is +8 to +15 depending on mean chroma.
- **Strength:** 0–100 scales every delta.
- **Skin tones** (default on): YuNet finds faces on a 640 px copy. Skin pixels inside the face boxes (YCbCr skin range) are measured, and `mixer.orange` / `mixer.red` hue, saturation and luminance nudge them toward a natural hue band (about 15–35°) and away from over-saturation, bounded to ±15. No face data is kept.
- **Writes:** the result replaces the light and colour sections, plus mixer red/orange when skin ran. The crop, detail, effects and cut-out are kept.
- **Testing:** deterministic for the same input. Unit tests use synthetic images (dark, bright, colour cast).

**HDR & interior balance** (`hdr.ts`): uses the same proxy.
- It raises shadows and lowers highlights in proportion to the dark and bright mass, and pulls whites and blacks to keep the endpoints.
- It adds a little contrast back, and re-solves exposure for the median.
- Strength 0–100 scales the result.

**Colour match** (`match.ts`):
- Lab mean and standard deviation of the reference proxy versus the target proxy.
- Coordinate descent over exposure, contrast, temperature, tint, saturation and vibrance, at most 60 develop evaluations on 128 px proxies, minimising the Lab statistics distance.
- Strength 0–100 interpolates toward the result.

**Quality signals** (`signals.ts`, a Web Worker) on the original 512 px thumbnail:
- a DCT pHash (32×32 grey → 8×8 low frequencies, median threshold);
- the variance of the Laplacian (3×3) on luminance;
- the mean luminance;
- `night`: mean luminance < 0.18 and the 99th percentile > 0.6, or mean < 0.28 with takenAt local hour ≥ 19 or < 6.

A background scanner (`scanner.ts`) runs while the app is open and idle (requestIdleCallback, one photo at a time). It pages `signalsPending`, posts batches of up to 100, and pauses on hidden tabs and on session end.

**Cleanup** (`cleanup.ts`, Pro and Studio):
- **Data:** pages `AI_API.cleanup` (1000 per page).
- **Duplicates:** pHash distance ≤ 4. They are found with 5-way chunk buckets (by the pigeonhole principle, distance ≤ 4 means at least one 13-bit chunk matches), then confirmed pairwise.
- **Similar bursts:** distance ≤ 10 and taken ≤ 60 s apart, found in a time-sorted sweep.
- **Blurry:** sharpness < `CLEANUP.blurSharpness`, and below 40 % of the median of its burst or day.
- **Keep best:** highest sharpness, then largest size, then earliest.
- **Actions:** "Keep best, move N others to Trash" uses the existing bulk trash route. "Not duplicates" and "Keep" call `cleanupIgnore`.

**Face grouping** (`faces.ts`, a Web Worker with onnxruntime-web, wasm SIMD, single thread):
- **Models:** YuNet `face_detection_yunet_2023mar.onnx` and SFace `face_recognition_sface_2021dec_int8.onnx` from OpenCV Zoo.
  - They're self-hosted under `/models/` with their licences (MIT, Apache 2.0 + NOTICE).
  - They're checked against pinned SHA-256 values before use, and cached in Cache Storage.
  - The onnxruntime-web wasm files are self-hosted from the package too; CSP `script-src` gains `'wasm-unsafe-eval'` for the app only.
- **Pipeline:** on each photo's original preview (2048 px):
  1. YuNet at 640 px on the long edge; faces below `FACE_LIMITS.minScore` and under `minPixels` are dropped.
  2. 5-point similarity alignment to 112×112.
  3. SFace → 128 floats, sent as base64.
- **Scanner:** pages `facesPending` and posts `FacesBody` in batches of up to 20 photos, showing "Finding faces on this device · n of N" with Pause.
- **Server** (`ai_faces_add`, one transaction per batch, advisory lock per owner):
  1. L2-normalises each embedding and drops any that isn't finite or is zero.
  2. Stores the face (`faces.embedding vector(128)`, pgvector).
  3. Matches it to the owner's people by centroid cosine similarity ≥ `FACE_LIMITS.match`, skipping people the face was rejected from.
  4. Otherwise starts a new unnamed person. A member has at most `MAX_PEOPLE` (3000) people: beyond it the oldest unnamed one-face people are pruned (their faces stay, unassigned), which bounds the per-face scan. A per-owner HNSW index isn't used: pgvector can't scope an approximate index to one owner without losing recall.
  5. Updates the person's centroid as a renormalised running mean, and sets `photos.faces_version`.
- **Who shows:** people with at least `MIN_PERSON_FACES` faces, or a name.
- **Suggestions:** auto-matches to named people with similarity < `FACE_LIMITS.sure` that aren't confirmed yet.
- **Actions:**
  - Not this person: unassigns, records a rejection, and recomputes the centroid.
  - Move: to another person or a new one.
  - Merge and rename.
  - Hide (hidden people stay out of the grid and search).
- **Privacy:**
  - Face rows are only ever readable by their owner, through the API.
  - They're never in logs, never sent to a provider, and never compared across accounts (every query filters by owner).
  - Turning face grouping off (or `DELETE /faces`) deletes faces, people and rejections in one transaction and clears the consent. Every face write checks the opt-out again after taking the member's faces lock, so a scan racing the opt-out can't store anything.
  - Scheduling account deletion deletes the face data at once (a restore brings the account back with face grouping off), and cancels and refunds pending cloud work.
  - If the plan loses `people_grouping`, scanning stops at once and the cron deletes the face data 30 days later. The member is emailed when it stops and again 3 days before deletion.
- **Consent:** turning it on needs `faceConsent: { version: FACE_CONSENT_VERSION, rightsConfirmed: true }`; any other version is refused (zod and SQL). The version and time are stored, and `audit_log` gets `ai.face_grouping.on` / `off` (no face data).

**Device jobs (batches across devices):** `POST /ai/jobs { kind: 'device' }` stores the photo list, steps and parameters, and the creating device claims it.
- **Lease:** a device holds a lease (`DEVICE_LEASE_SECONDS`). It processes photos in order and posts progress after each one or every 2 s, which renews the lease.
- **Hand-over:** when the lease lapses, the job shows "Waiting for this device" and any of the member's devices can "Continue here" (claim).
- **Pausing:** pause releases the lease.
- **The server never runs device steps.** It only records progress, so device jobs cost nothing and need no caps.

## Cut-out rendering (`apps/web/src/lib/editor`)

- The mask is fetched once per photo (owner route, `Cache-Control: private, no-cache` with `ETag` = the mask id, so the browser revalidates every use and a 304 costs one database lookup) and uploaded as an R8 texture.
- The geometry pass samples it with the same transform as the photo, so crops, rotation and perspective line up.
- **New pass `COMPOSITE`** after sharpen:
  - `a = smoothstep(0.5 − w − shift', 0.5 + w − shift', m)`, with `w` from `softness`.
  - The shadow comes from a blurred copy of the mask, made on the CPU at 512 px with 3 box passes. It is offset down (soft: 2.5 % of the height, blur radius 3 %; contact: an elliptical falloff at the subject's bottom edge), and multiplies the background by `1 − strength × shadow × 0.6`.
  - `out = mix(bg × (1 − s), photo, a)`. With bg `original` the pass is skipped; with `transparent` the alpha is `a`.
- **CPU reference:** `compositePixel` in `develop.ts`. `test:gl` gains a cut-out case.
- **Exports:**
  - A transparent background exports as PNG (an option next to JPEG; JPEG flattens onto white).
  - Edited variants of transparent cut-outs upload as WEBP with alpha.
  - Shared full-size renders flatten onto white.
- **Paste dialog:** uses `PASTE_SECTIONS`; a cut-out is never pasted.
- **Saves:** may keep or drop `cutout` but never point it at a mask the photo doesn't own. `save_edit` refuses it (`invalid`); any other writer (bulk paste or apply) has the foreign cut-out dropped by the `photo_edits` trigger, keeping the rest of the recipe, instead of failing the whole request. `ai_item_complete` is the only writer of a new mask id. "Save as copy" uploads a rendered file as a new photo and never carries a recipe.

## Data model (migration `20261103100000_ai.sql`)

**New tables (RLS on, no grants to anon or authenticated; all access through SECURITY DEFINER functions called by the API with the secret key):**
- **`ai_settings`:** one row, the `AiSettings` fields. The default has every feature on, Runware primary, fal fallback, caps of 10 / 8 / 2 / 0.50 USD, alerts at 50, 80 and 100, and pause at the cap.
- **`ai_member_settings`:** `face_grouping`, `face_consent_at`, `face_consent_version`, `scene_tags`, `cleanup`, `face_plan_lapsed_at`.
- **Credits:** `credit_balances` and `credit_ledger`.
- **Jobs:** `ai_jobs` and `ai_job_items`. Each item has a status and an error, `attempts`, `provider`, `cost_micros`, `credits`, `mask_id`, `wait_until`, `started_at` and `finished_at`. Device jobs keep their photo list in items too, with `lease_device` and `lease_until` on the job.
- **Spend:** `ai_spend_daily`, `ai_user_spend_daily` and `ai_spend_alerts`.
- **Masks:** `photo_masks`. Photo purge and account purge delete the mask keys: `_photo_keys` includes them, and the orphan sweep treats `m/` keys with a `photo_masks` row as known.
- **Signals:** `photo_signals`, holding `phash` as a bigint, `sharpness`, `brightness`, `night`, `version`, `dup_ignored` and `blur_ignored`.
- **Scenes:** `photo_scenes(photo_id, scene, score)`, plus `photos.scene_state`.
- **Faces:** `people`, `faces` (pgvector `vector(128)`, with a btree index on `(owner_id, person_id)`) and `face_rejections`, plus `photos.faces_version`.

**Other changes:**
- `plan_limits.quality_cleanup`: Pro and Studio true.
- `list_photos` gains `p_scene` and `p_person`.
- Face, scene and signal rows cascade with their photo. Trashed photos are left out of people, scenes and cleanup lists.

## API (`apps/api/src/ai/`, `routes/ai.ts`, `routes/admin-ai.ts`)

- **Member routes:** all of `AI_API`, behind requireMember and the account-pending-deletion guard, with `X-Zephyr-Expected-User` on writes (409 `session_changed`). The mask route is in `photoRoutes`.
- **Admin routes:** `ADMIN_AI_API`.
  - Owner and admin can write; finance can read.
  - A PATCH runs `isRiskLowering`; if false and the session isn't recent → 403 `reauth_required`.
  - Each change is written to `audit_log` with a before/after diff of the settings (no secrets), and risk-raising changes email the Owners.
  - Settings are cached in the isolate for 30 s, so a change reaches every Worker within about 30 s.
- **Env:**
  - Bindings: `AI` (Workers AI) and `AI_QUEUE`.
  - Vars: `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`.
  - Secrets: `RUNWARE_API_KEY`, `FAL_KEY` and `AI_GATEWAY_TOKEN`.
  - `docs/setup.md` §3.6 covers creating the gateway (authenticated, with logs on), the Runware custom provider and the queue.

## Admin (`apps/admin`)

- **Zephyr AI** (`/admin/ai`), as mocked up:
  - master switch, features, providers and models, credits per photo, cost estimates;
  - today's spend bars with the 50 % and 80 % marks;
  - caps, alerts and the at-cap action.
  - When a save needs it, the app asks for the passkey again and retries.
- **AI jobs** (`/admin/ai/jobs`): queue counts, seconds per photo (p50/p95, last hour), the providers table and recent failures (job and member ids only). The "Pause new cloud jobs" button patches `cloudPaused`.

## Security checklist (for the reviews)

- Every query is scoped by owner.
- Device-submitted signals, faces and progress are validated and bounded: a member can only write their own photos, with sizes and counts capped.
- Provider output is untrusted: it goes through the strict PNG reader with size and dimension bounds and a decompression bomb guard. Masks are stored only as re-encoded greyscale.
- Providers get only the ≤ 2048 px preview, inline. There are no URLs to our storage, and fal storage is off.
- API keys stay in Worker secrets. Calls go only to the fixed gateway or provider hosts (no user-controlled URLs), and model ids are checked by regex.
- Credits can't go negative or be double-spent or double-refunded: everything happens under a lock, with unique refund per item.
- Caps are checked before every provider call. A cap can't be passed by parallel consumers (reserve under the lock).
- Face data is opt-in, deleted on opt-out, never logged, and never in any response except to its owner. Embeddings are never returned to the client at all.
- The model files are integrity-checked before use, and same-origin only.
- Shared devices: session end stops the scanner, the device job lease and pending posts (sessionGuard `onSessionEnd`), and clears cached masks.

## Tests

- **Shared:**
  - `isRiskLowering`;
  - `normalizeRecipe` cut-out cases;
  - the schemas: faces, signals, jobs, and settings with caps rounding;
  - `sceneForLabels`.
- **SQL** (`supabase/tests/60_ai_test.sql`, `70_ai_race.sh`):
  - credits roll and expiry, charge, refund once, and no negative balance;
  - caps reserve and settle, and parallel reserves can't exceed a cap;
  - face add, match, reject, merge and delete-all;
  - list_photos with scene and person filters;
  - the mask ownership check in `save_edit`;
  - purge deleting mask keys.
- **API:**
  - the PNG reader (good, wrong type, bomb, oversize, aspect mismatch);
  - Runware and fal adapters with mocked fetch, including the gateway URL and headers;
  - the consumer flow: success, fallback, failure with refund, waiting at a cap, admin pause, photo deleted;
  - job create with insufficient credits;
  - the device job claim conflict;
  - admin PATCH reauth.
- **Web:**
  - enhance, HDR and match on synthetic images (deterministic, within bounds);
  - pHash and Laplacian;
  - cleanup grouping;
  - the composite CPU reference against the shader (test:gl);
  - the editor AI tab;
  - the batch dialog credit maths;
  - the consent dialog (Turn on disabled until ticked);
  - the scanner stopping on session end.
- **Admin:** the settings form, and the reauth retry.

## Launch gates added by this phase

- Run the 50-photo bake-off (`scripts/bakeoff.mjs` writes a side-by-side HTML page from both providers' masks) and set the winner in Admin.
- Ask Runware to turn on zero data retention for the organisation.
- Measure Workers AI cost per scene tag in week 1 and set `costs.sceneMicros`.
- Check the face-grouping wording in the privacy notice (PDPA/GDPR biometric data) with counsel before turning it on for EU users.
