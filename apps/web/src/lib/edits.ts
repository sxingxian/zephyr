import {
  EDIT_API,
  type EditBulkBody,
  type EditBulkResult,
  type EditRecipe,
  type EditSaveResult,
  LIBRARY_API,
  ORIGINAL_VARIANT_QUERY,
  type PhotoEdit,
  type RecipeCreateBody,
  type RecipePatchBody,
  type SavedRecipe,
  type VariantKind,
} from '@zephyr/shared/client';
import { api } from './api';
import { expectedUser, ownerHeader, putBytes } from './library';
import { withLibrary } from './libraryContext';

/** Edit and recipe calls. Writes name the member this tab believes is signed in (409 session_changed). */
export const getEdit = (photoId: string, signal?: AbortSignal) =>
  api<{ ok: true; edit: PhotoEdit | null }>(EDIT_API.photoEdit(photoId), { signal }).then(
    (r) => r.edit ?? null,
  );
/**
 * `owner` is the member the work was started for (an open editor, a queued render). When given, the request
 * names that member, so the server refuses it (409 session_changed) if someone else has since signed in.
 */
const who = (owner?: string) => (owner !== undefined ? ownerHeader(owner) : expectedUser());
export const saveEdit = (
  photoId: string,
  recipe: EditRecipe,
  baseVersion: number | null,
  owner?: string,
  signal?: AbortSignal,
) =>
  api<EditSaveResult>(EDIT_API.photoEdit(photoId), {
    method: 'PUT',
    body: { recipe, baseVersion },
    headers: who(owner),
    signal,
  }).then((r) => r.edit);
export const deleteEdit = (photoId: string, owner?: string, signal?: AbortSignal) =>
  api<void>(EDIT_API.photoEdit(photoId), { method: 'DELETE', headers: who(owner), signal });
export const putEditVariant = (
  photoId: string,
  kind: VariantKind,
  version: number,
  bytes: Blob,
  signal?: AbortSignal,
  owner?: string,
) =>
  putBytes(EDIT_API.photoEditVariant(photoId, kind, version), bytes, {
    contentType: bytes.type,
    signal,
    owner,
  });

const BULK = 500;
/** Paste, apply or revert in requests of at most 500. */
export async function bulkEdits(
  body: EditBulkBody,
  owner?: string,
): Promise<EditBulkResult & { skipped: string[] }> {
  const out = {
    ok: true as const,
    affected: 0,
    edits: [] as EditBulkResult['edits'],
    skipped: [] as string[],
  };
  for (let i = 0; i < body.ids.length; i += BULK) {
    const r = await api<EditBulkResult & { skipped?: string[] }>(EDIT_API.editsBulk, {
      body: { ...body, ids: body.ids.slice(i, i + BULK) },
      headers: who(owner),
    });
    out.affected += r.affected;
    out.edits.push(...(r.edits ?? []));
    // Photos changed elsewhere while the merge was retried (newer servers report them).
    if (Array.isArray(r.skipped)) out.skipped.push(...r.skipped.filter((x) => typeof x === 'string'));
  }
  return out;
}

export const listRecipes = (signal?: AbortSignal) =>
  api<{ ok: true; recipes: SavedRecipe[] }>(EDIT_API.recipes, { signal }).then((r) => r.recipes ?? []);
export const createRecipe = (body: RecipeCreateBody) =>
  api<{ ok: true; recipe: SavedRecipe }>(EDIT_API.recipes, { body, headers: expectedUser() }).then(
    (r) => r.recipe,
  );
export const patchRecipe = (id: string, body: RecipePatchBody) =>
  api<{ ok: true; recipe: SavedRecipe }>(EDIT_API.recipe(id), {
    method: 'PATCH',
    body,
    headers: expectedUser(),
  }).then((r) => r.recipe);
export const deleteRecipe = (id: string) =>
  api<void>(EDIT_API.recipe(id), { method: 'DELETE', headers: expectedUser() });

/** The unedited preview (always the original, even when the photo has an edit). */
export const originalPreviewUrl = (id: string) =>
  withLibrary(`${LIBRARY_API.photoFile(id, 'preview')}?${ORIGINAL_VARIANT_QUERY}`);
export const originalThumbUrl = (id: string) =>
  withLibrary(`${LIBRARY_API.photoFile(id, 'thumb')}?${ORIGINAL_VARIANT_QUERY}`);
