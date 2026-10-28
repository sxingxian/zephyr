# Phase 4: the editor

Mockups:
- PWA desktop canvas, row "Editor": Adjust, Split compare, Crop, Recipes, Developing a RAW, Export, Paste edits, Applying edits, Batch export.
- Phone canvas, row "Editor": Adjust, Crop, Paste sheet, Export sheet.

Contract: `packages/shared/src/edit-types.ts` (browser-safe) and `edit-schemas.ts` (zod, API only).

Decisions:
- **RAW:** full RAW decoding on the device with LibRaw compiled to WebAssembly.
- **Export:** downloads a JPEG, or Save as copy puts the edited version into the library as a new photo.
- **History:** undo/redo while editing, plus Revert to original. One saved edit per photo.

## Scope (SRS FR-ED-01 to 04, NFR-PERF-02)

- **Adjustments:**
  - Light: exposure, contrast, highlights, shadows, whites, blacks.
  - Colour: temperature, tint, vibrance, saturation.
  - Colour mixer: hue, saturation and luminance for 8 bands.
  - Detail: sharpening, noise reduction.
  - Effects: vignette.
- **Crop and transform:**
  - Aspect presets: original, free, 1:1, 4:5, 3:2, 16:9 and their portrait forms.
  - Straighten, from −45° to 45°.
  - Quarter turns and flips.
  - Vertical and horizontal perspective.
- **Non-destructive:** every edit is a sparse JSON recipe on top of the untouched original.
- **Copy and paste:** copy one photo's edits and paste any chosen sections onto one photo or a selection. Crop is off by default.
- **Recipes:** members save their own (up to 200; never the crop). Six Zephyr recipes ship in code. Hovering previews a recipe on the photo; applying is one undoable step.
- **Batch:** paste edits, apply a recipe, revert, or export a selection. Selections are capped by the plan's batch size (25 on Free, 500 on paid plans).
- **Export:**
  - Full size, long edge 2048 px, or a custom long edge, as a JPEG with adjustable quality in sRGB.
  - A single photo downloads directly; a selection downloads as a .zip.
  - **Save as copy** uploads the rendered JPEG through the phase 3 upload pipeline as a new photo, counted toward storage.
- **Library:** an "Edited" filter, an edited badge on tiles, and edited thumbnails in the grid and viewer.

Out of scope: Zephyr AI (phase 6), local or brush adjustments, saved versions, and writing EXIF into exports.

## Recipe

```json
{"v":1,"light":{"exposure":0.35,"highlights":-42},"color":{"temperature":12},
 "mixer":{"orange":{"saturation":-10}},"crop":{"aspect":"4:5","rect":{"x":0.12,"y":0,"w":0.64,"h":1},"angle":-2.4}}
```

- `normalizeRecipe` is the only serialiser, and both the browser and the API run it. It:
  - clamps and rounds every value to the shared `RANGES`;
  - drops neutral values and unknown keys;
  - writes keys in a fixed order;
  - never throws.
- The API also checks the shape strictly: unknown keys are rejected and numbers must be finite. Stored recipes are capped at 4 KB.
- `mergeRecipe(target, source, sections)` defines paste: each ticked section of the source replaces the same section of the target.
- Temperature and tint are relative (−100 to 100), so a recipe means the same on a JPEG and a RAW. For a RAW, 0 is the camera's white balance.

## Rendering (WebGL 2, on the device)

One pipeline renders everything: the live view, edited thumbnails and previews, and exports. A photo therefore looks the same everywhere.

1. **Decode.**
   - JPEG, PNG, WEBP: `createImageBitmap` with EXIF orientation applied.
   - RAW: see below.
   - The source is uploaded as an RGBA16F texture in linear light. 8-bit sources are linearised from sRGB; RAW output is already linear.
2. **Geometry pass.** Quarter turns, flips, straighten and a perspective homography map output pixels to source coordinates. The crop rectangle is a sub-rect of the transformed image. Edges are clamped, and straighten auto-zooms so no empty corners show.
3. **Develop pass, in linear light:**
   - exposure: `2^ev`;
   - white balance: temperature and tint as channel multipliers;
   - highlights, shadows, whites and blacks: a tone curve weighted by a blurred-luminance mask (a mip of the luminance), so they act locally like Lightroom's, without haloing at normal strengths;
   - contrast: an S-curve around middle grey in log space;
   - vibrance, saturation, and the HSL mixer on smooth hue-band weights;
   - vignette relative to the crop.
   - The output is sRGB-encoded.
4. **Detail.**
   - Noise reduction: a bilateral filter on luminance and chroma.
   - Sharpening: an unsharp mask on luminance, scaled to output size so the preview matches the export.
5. **Output.**
   - Live view: an RGBA8 canvas sized to the screen (at most 2560 px on the long edge); the full source is used only when zoomed to 100% or more.
   - Thumbnails and previews: FBO readback, then `OffscreenCanvas.convertToBlob` (WEBP, falling back to JPEG) within `VARIANT_LIMITS`.
   - Export: rendered in tiles whenever the output exceeds `MAX_TEXTURE_SIZE` or a 64 MP memory budget, then encoded as a JPEG. The canvas re-encode carries no metadata, so exports contain no GPS or camera serial.
- **Performance:** dragging a slider re-runs only the develop and detail passes on a cached geometry texture, at the proxy size. This meets the ≥30 fps target (NFR-PERF-02), checked in the browser test.
- **Correctness:** the colour maths lives in `apps/web/src/lib/editor/develop.ts` as a CPU reference. The shader is tested against it on a small image in Chromium (Playwright with SwiftShader), with a tolerance of ≤ 2/255.
- **No WebGL 2:** the editor explains that it needs a newer browser. The library and viewer keep working.

## RAW decoding

- **Decoder:** `@colorhythm/libraw-wasm`. The TypeScript wrapper is MIT-licensed; LibRaw is LGPL-2.1 or CDDL-1.0 (we use LGPL-2.1).
  - The exact version is pinned and its glue code reviewed.
  - `libraw.wasm` is served as a separate same-origin file, so it can be replaced as LGPL requires.
  - Settings › About › Open-source licences lists it with its licence text and a link to its source.
- **Worker:** LibRaw runs in a dedicated Worker, loaded only when a RAW opens. The CSP already allows `'wasm-unsafe-eval'`.
  - A file is parsed only after its TIFF signature is checked.
  - The worker is killed after 60 s, and decodes above 100 MP are refused.
  - The worker holds only the bytes of the photo being decoded.
- **Two passes:**
  - Opening a RAW shows its stored preview straight away (the camera JPEG from phase 3).
  - A half-size decode (fast, about 6 MP for 24 MP files) replaces it for editing.
  - Export does a full-size decode.
  - All decodes use camera white balance, linear 16-bit output and no auto-brightness. The demosaic is AHD for exports and the half-size path for editing.
- **Original download:** RAW originals reach the browser through the existing owner-only `GET /photos/:id/original`, which is `no-store`. Nothing is cached to disk.

## Saving edits and edited thumbnails

- **Autosave:** about 800 ms after the last change, and when leaving the photo. The save is `PUT /photos/:id/edit { recipe, baseVersion }`.
  - A different `baseVersion` (another tab edited the photo) gets 409 `conflict` with the current edit. The editor offers "Load the newer edit" or "Keep mine", which saves again with the new base.
  - Revert to original is `DELETE /photos/:id/edit`. It is one undoable step while the editor is open.
- **Edited thumbnails:** after each save the browser renders an edited thumb and preview from the stored 2048 px preview and uploads them to `PUT /photos/:id/edit/variants/:kind?v=<version>`.
  - Each variant is checked like the phase 3 variants: type signature, byte cap and pixel dimensions.
  - Each version writes to its own key, `u/<owner>/p/<photo>/edit-<version>-<kind>`. It is recorded under the owner's storage lock only if that version is still current. The previous key is then returned for deletion; otherwise the new object is deleted and the request gets 410. The bytes are measured from R2, never trusted from the client.
  - Edited variants count toward storage. When storage is full the edit is still saved, and the grid shows the original with an edited badge.
  - The edit row records `rendered` once both variants exist for the current version.
- **Serving:**
  - `GET /photos/:id/thumb` and `/preview` serve the edited variant when it's current. `?original=1` always serves the original variant.
  - The ETag includes the edit version.
  - All phase 3 serving headers stay: owner check, `no-cache`, sandbox CSP, `nosniff`.
- **Bulk:** `POST /photos/edits/bulk { ids, recipe | null, sections }` merges per photo on the server with `mergeRecipe`, bumps versions, and returns the new edits.
  - The browser then renders the thumbnails in a background queue. The tray shows Pending, Processing, Completed or Failed.
  - Photos still waiting show their original thumbnail with a pending badge. The queue resumes on the next visit for any edit with `rendered = false`.
- **Undo paste:** the tray's "Undo paste" sends a second bulk request that restores each photo's previous recipe, which the browser kept.

## Database

- **`photo_edits`:**
  - Columns: `photo_id` (PK, references photos, cascade on delete), `owner_id`, `recipe jsonb` (≤ 4 KB check), `version int`, `thumb_key`/`thumb_bytes`, `preview_key`/`preview_bytes` (nullable), `variants_version int`, `updated_at`.
  - RLS on, nothing granted to browser roles.
- **`recipes`:** `id`, `owner_id`, `name` (1–60), `recipe jsonb` (≤ 4 KB, no `crop` key), timestamps. At most 200 per owner, enforced in the function under a lock. RLS on, nothing granted.
- **Functions:** `security definer`, `search_path = ''`, service role only:
  - `get_edit`, `save_edit` (version check);
  - `delete_edit`, which returns the variant keys and releases their bytes;
  - `record_edit_variant`, under the storage lock;
  - `bulk_edits`, owner-filtered;
  - `list_recipes`, `create_recipe`, `update_recipe`, `delete_recipe`.
- **Existing jobs:**
  - Photo purge and account purge also delete edit variant keys.
  - The orphan sweep learns the `edit-<n>-<kind>` keys and deletes any object that isn't the recorded key for its photo, skipping objects less than an hour old.
  - `storage_bytes` includes edit variant bytes.
- **Photo list:** gets an `edited` view and returns `edit { version, rendered }`. Photo detail returns the recipe.

## API rules

- **Access:** every route requires a member session and a photo the member owns. Trashed photos can't be edited (404). The 403 `account_pending_deletion` gate applies.
- **Limiter:** an `EDIT_LIMITER` binding allows 600 edit writes per minute per member; variant PUTs share the upload limiter.
- **Bulk:** `ids` ≤ the member's plan `batch_size` (and ≤ 500). Other members' ids are ignored, not reported.
- **Recipes:** names have control characters stripped and stay plain text. They are always rendered as text, never HTML.

## Browser

- **Routes:** `/edit/:photoId` (desktop: panel on the right, filmstrip below; phone: tool tabs and a dial at the bottom).
  - Entry points: Edit in the viewer; Copy edits, Paste edits, Apply recipe and Export in the library selection bar; `E` from the viewer.
  - Keyboard: ⌘Z / ⇧⌘Z, hold `\` for the original, `C` for crop, ⌘C / ⌘V for edits, and arrow keys on a focused slider (Shift for ×10). Double-clicking a slider resets it.
- **Sliders:** native `<input type=range>` with labels and `aria-valuetext`. Panels collapse; an unchanged section shows no dot.
- **Compare:** Before / Split / After. Split is a draggable divider with keyboard support.
- **Clipboard:** the copied recipe lives in memory, bound to the signed-in member, and is cleared by the phase 3 session-end hook. It is never put in localStorage.
- **Loading:** WebGL, the RAW worker, fflate (for .zip) and the editor code are lazy chunks, so the library's 2 s load budget is untouched.
- **Motion:** panel and tab changes use the existing easing tokens (150–200 ms). Slider updates aren't animated. Reduced motion is respected.

## Security notes

- **Untrusted files:** RAW and image parsing happen only in the browser, in a Worker (LibRaw) or the browser's own decoders. The server never decodes images; it only checks signatures, sizes and dimensions from headers.
- **No content from recipes:** a recipe is numbers, enums and booleans only. Names are text. Nothing from a recipe reaches HTML, CSS or SQL as code.
- **Edited variants:** these follow the same rules as phase 3 uploads. The size is measured, writes are versioned and recorded under the storage lock, a losing write is deleted, and the orphan sweep is the backstop.
- **Exports:** made on the device, with no metadata. Save as copy is an ordinary upload that counts toward storage.
- **Shared devices:** the edit clipboard, render queue and decode worker are reset with the upload queue when the session ends.
