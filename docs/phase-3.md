# Phase 3: the photo library

Mockups: PWA desktop canvas, row "Library basics"; phone canvas, row "Library basics". The screens are uploading,
drop to upload, viewer, albums, trash, delete account and the restore screen.

## Storage

- One private R2 bucket, `zephyr-photos`. It has no public access and no r2.dev URL, and is bound to the API
  Worker as `PHOTOS`.
- Object keys: `u/<ownerId>/p/<photoId>/original`, `…/thumb` and `…/preview`. Grouping by owner lets account
  deletion purge by prefix.
- **Usage accounting:** `profiles.storage_bytes` counts originals and variants of ready and trashed photos. Open
  uploads hold a reservation, so parallel uploads can't overshoot the plan's storage limit.

## Uploading (through the API, never presigned)

Every byte passes through the API Worker into R2 using R2 multipart upload. This means:
- no R2 credentials or CORS rules;
- the server sees, measures and checks every file;
- uploads can resume part by part;
- no 100 MB request limit (parts are 16 MiB).

1. `POST /api/v1/uploads` with up to `batch_size` files, each `{ name, size, type, sha256, lastModified }`. For each
   file the server either:
   - **accepts** it and returns `{ uploadId, photoId, partSize, partCount }`, after it:
     - checks the extension and declared type against the plan's `file_types` allow-list;
     - checks the size against `max_file_mb`;
     - reserves the storage;
     - creates an R2 multipart upload;
   - **skips** it as a `duplicate`: an identical file (same SHA-256 and size) is already in this owner's library.
     The hash comes from the browser and only decides what to skip for that same owner;
   - **rejects** it for its `type`, size (`too_large`) or `quota`.
2. `PUT /api/v1/uploads/:uploadId/parts/:n` sends the raw bytes:
   - `Content-Length` is required and must match the expected part size, and the stream is cut off at that length.
   - Part 1's first bytes must match the file type's signature: JPEG `FF D8 FF`, PNG `89 50 4E 47`, WEBP `RIFF…WEBP`,
     CR2/NEF/ARW TIFF `II*\0` or `MM\0*`, plus `CR` at byte 8 for CR2.
   - Part ETags are kept on the server and never trusted from the client.
3. `PUT /api/v1/uploads/:uploadId/variants/:kind` (`thumb` up to 512 px, `preview` up to 2048 px) uploads a WEBP or
   JPEG the browser made:
   - Size caps: 300 KB for thumbs, 1.5 MB for previews.
   - The signature and image dimensions are checked from the header.
4. `POST /api/v1/uploads/:uploadId/complete` sends `{ metadata }`:
   - Metadata the browser read from EXIF: width, height, taken-at, camera make and model, lens, focal length,
     aperture, shutter, ISO, orientation. Every field is length- and range-checked.
   - The server finishes the multipart upload and checks that the stored size equals the declared size.
   - It reads the thumb and preview sizes from R2 (capped at their limits) instead of trusting earlier records, then
     switches the reservation to real usage and marks the photo `ready`.
   - A variant written after the upload has closed is deleted straight away and the request gets 410.
5. `DELETE /api/v1/uploads/:uploadId` aborts the upload and releases the reservation. The abort is claimed in the
   database first, under the owner's storage lock, and only the winner deletes R2 objects, so an abort can't race a
   completion into a counted photo with no files. Uploads left unfinished for 24
   hours are aborted by the clean-up job.

**Browser side.**
- Hashing uses incremental SHA-256 (hash-wasm).
- EXIF is read with exifr.
- Thumbnail and preview come from `createImageBitmap` (honouring EXIF orientation) and `OffscreenCanvas`: WEBP where
  the browser can encode it, JPEG otherwise.
- For RAW files, the largest embedded JPEG preview is used, so no RAW decoder is needed until the editor (phase 4).
- Uploads run three files at a time, with pause, cancel and retry. Retries resume from the last confirmed part.
- The queue belongs to the user who started it. Sign-out, a 401 or a change of user aborts it, deletes its open
  uploads, frees its object URLs and reloads the page.

**GPS** stays inside the original file. Zephyr never parses, stores or shows location in this phase.

## Serving images

- `GET /api/v1/photos/:id/thumb`, `…/preview` and `…/original`.
- Access is checked against the owner's session cookie (same-origin, so no signed URLs are needed for the owner).
  Guests get signed links in phase 5.
- **Headers:**
  - A fixed `Content-Type`.
  - `X-Content-Type-Options: nosniff`.
  - `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`.
  - `Cross-Origin-Resource-Policy: same-origin`.
  - `Cache-Control: private, no-cache` with an ETag for variants, so every view re-checks the session (a 304 is
    cheap). Originals are `no-store`.
  - Sign-out and account deletion send `Clear-Site-Data: "cache"` so nothing private stays in the browser cache.
- Originals always download (`Content-Disposition: attachment`, RFC 5987 filename).

## Library API

- **Photos:**
  - `GET /api/v1/photos`: keyset-paginated list.
    - Sort by date taken (falling back to date added) or by date added.
    - Filters: all, favourites, RAW, album, search text (filename, camera; uses a trigram index) and date range.
  - `GET /api/v1/photos/:id` returns details, including the albums the photo is in.
  - `PATCH /api/v1/photos/:id` changes `{ favourite?, filename? }`.
  - `POST /api/v1/photos/bulk` takes `{ ids (≤500), action }`. Actions: favourite, unfavourite, trash, restore,
    delete forever (only from Trash), add to album, remove from album.
- **Albums:** `GET/POST /api/v1/albums` and `GET/PATCH/DELETE /api/v1/albums/:id` (name, cover). Deleting an album
  never deletes its photos.
- **Trash:**
  - Items keep their photos for 30 days (`purge_after`) and still count toward storage.
  - `POST /api/v1/trash/empty` deletes everything in the Trash.
- **Usage:** `GET /api/v1/me/usage` returns bytes used, reserved and limit, photo count, Trash bytes, and the plan's
  upload rules.

## Account deletion

- **Deleting:** `POST /api/v1/me/delete` with `{ confirm: "DELETE" }`.
  - Needs a sign-in within the last 10 minutes.
  - Signs out every session (GoTrue logout, global scope) and sets `profiles.deletion_due = now() + 30 days`.
  - Emails the account.
- **Signing in while deletion is pending:** shows the Restore screen. Every other route answers 403
  `account_pending_deletion`.
- **Restoring:** `POST /api/v1/me/restore` clears the schedule.

## Clean-up jobs

A Cron Trigger on the API Worker runs every 15 minutes, with a bounded amount of work per run. Each step is logged
to `audit_log` without personal data. It:
1. Aborts uploads older than 24 hours: R2 multipart abort, variant delete, row delete, reservation release.
2. Purges photos whose `purge_after` has passed: R2 deletes, row delete, usage update.
3. Purges accounts whose `deletion_due` has passed:
   - Lists and deletes every R2 object under `u/<ownerId>/`.
   - Deletes the Auth user with the admin API, which cascades to the profile, photos and albums.
   - A failed account is retried no more than once an hour; after 5 failures an alert goes into `audit_log`.
4. Sweeps a bounded page of `u/` keys (the cursor is kept in `job_state`) and deletes objects with no photo row,
   skipping any photo with an upload still in progress.
5. Deletes rate-limit rows older than 2 days (pg_cron already does this; the job is idempotent).

Thumbnails and previews are written to `staging/<ownerId>/<photoId>/<kind>` until their upload completes; only the
completion that wins the database claim copies them to the photo's own keys. If that copy fails, the photo stays
marked as pending and the job retries it. R2 lifecycle rules abort incomplete multipart uploads after one day and
delete anything under `staging/` after two (see DEPLOYMENT.md §4).

## Security notes

- Every database function takes the owner id from the verified session and filters by it. A test proves one member
  can't read, change, download or delete another member's photos or albums.
- Upload bytes are counted on the server, and declared sizes, part sizes and the final object size must all agree.
- Phase 5 (sharing) must re-encode guest-facing images, for example with the Cloudflare Images binding, and serve
  shared galleries through the zone cache so the CSAM scanning tool covers them.
