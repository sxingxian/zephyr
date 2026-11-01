import {
  type DeviceJobParams,
  type EditRecipe,
  normalizeRecipe,
  type PhotoEdit,
  type PhotoItem,
  recipeJson,
} from '@zephyr/shared/client';
import { ApiFailure } from '../api';
import { emitLibrary } from '../bus';
import { getEdit, originalPreviewUrl, saveEdit } from '../edits';
import { sessionUserId } from '../sessionGuard';
import type { FaceBox } from './enhance';
import type { AiProxy } from './proxy';

/**
 * Runs a device job's steps on one photo (phase 6): auto-enhance, HDR & interior balance and colour match, in
 * that order, on the photo's proxy, then saves the result as a normal edit (PUT with the base version; on a
 * conflict it reloads the photo's edit once and starts again). Only sliders change: the crop, detail,
 * effects and cut-out the photo already has are kept. The thumbnails are then re-rendered in the background.
 *
 * Everything is done for `ctx.owner`, the member who started the job: if someone else is signed in by the
 * time a request goes out, the server refuses it (409 session_changed) and the job stops.
 */
export type Photo = Pick<PhotoItem, 'id' | 'filename' | 'fileType' | 'hasPreview'>;
export interface Reference {
  proxy: AiProxy;
  recipe: EditRecipe | null;
}
export interface RunDeps {
  getEdit(photoId: string, signal?: AbortSignal): Promise<PhotoEdit | null>;
  saveEdit(
    photoId: string,
    recipe: EditRecipe,
    base: number | null,
    owner: string,
    signal?: AbortSignal,
  ): Promise<PhotoEdit>;
  loadProxy(photo: Photo, recipe: EditRecipe, signal?: AbortSignal): Promise<AiProxy>;
  /** Face boxes (source uv) for skin tones; [] when none or when detection isn't available. */
  faces(photo: Photo, signal?: AbortSignal): Promise<FaceBox[]>;
  /** Tells the library the edit changed and queues its thumbnails. */
  saved(photo: Photo, edit: PhotoEdit, owner: string): void;
  owner(): string | null;
}
export interface RunContext {
  owner: string;
  signal?: AbortSignal;
  /** The colour-match reference, loaded once per job (loadReference). Required when the steps include it. */
  reference?: Reference;
  deps?: Partial<RunDeps>;
}
export type RunResult =
  | { status: 'done'; edit: PhotoEdit; changed: number }
  | { status: 'unchanged' }
  | { status: 'failed'; error: string };

const abortIf = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
};

const defaultDeps: RunDeps = {
  getEdit,
  saveEdit: (id, recipe, base, owner, signal) => saveEdit(id, recipe, base, owner, signal),
  async loadProxy(photo, recipe, signal) {
    const { loadProxy } = await import('./proxy');
    return loadProxy(photo, recipe.crop, { signal });
  },
  async faces(photo, signal) {
    try {
      const res = await fetch(originalPreviewUrl(photo.id), { credentials: 'same-origin', signal });
      if (!res.ok) return [];
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
      try {
        const { detectFaces } = await import('./faces');
        return (await detectFaces(bmp, 0.7)).map((f) => ({
          x: f.box[0],
          y: f.box[1],
          w: f.box[2],
          h: f.box[3],
        }));
      } finally {
        bmp.close();
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      return []; // no model, no preview: auto-enhance runs without skin tones
    }
  },
  saved(photo, edit, owner) {
    emitLibrary({
      type: 'updated',
      photos: [{ id: photo.id, edit: { version: edit.version, rendered: false } }],
    });
    void import('../editor/queue').then(({ renderQueue }) =>
      renderQueue.enqueue(
        [{ photoId: photo.id, name: photo.filename, version: edit.version, recipe: edit.recipe }],
        false,
        owner,
      ),
    );
  },
  owner: sessionUserId,
};

/** The colour-match reference photo's proxy and current recipe. */
export async function loadReference(
  photo: Photo,
  signal?: AbortSignal,
  deps: Partial<RunDeps> = {},
): Promise<Reference> {
  const d = { ...defaultDeps, ...deps };
  const recipe = (await d.getEdit(photo.id, signal))?.recipe ?? null;
  return { proxy: await d.loadProxy(photo, normalizeRecipe(recipe), signal), recipe };
}

/** The steps applied to one photo's proxy (pure; exported for tests). */
export async function applySteps(
  proxy: AiProxy,
  recipe: EditRecipe,
  params: DeviceJobParams,
  faces: FaceBox[],
  reference?: Reference,
): Promise<EditRecipe> {
  let r = normalizeRecipe(recipe);
  for (const step of params.steps) {
    if (step === 'auto_enhance') {
      const { autoEnhance } = await import('./enhance');
      r = autoEnhance(proxy, r, { strength: params.strength ?? 70, skin: params.skin ?? true, faces });
    } else if (step === 'hdr') {
      const { hdrBalance } = await import('./hdr');
      r = hdrBalance(proxy, r, { strength: params.hdrStrength ?? 50 });
    } else if (step === 'color_match') {
      if (!reference) throw new Error('Colour match needs its reference photo.');
      const { colorMatch } = await import('./match');
      r = colorMatch(proxy, r, reference.proxy, reference.recipe, { strength: params.matchStrength ?? 80 });
    }
  }
  return r;
}

const stopping = (e: unknown) =>
  (e as Error)?.name === 'AbortError' ||
  (e instanceof ApiFailure &&
    (e.code === 'unauthenticated' || e.code === 'session_changed' || e.code === 'account_pending_deletion'));

/**
 * One photo of a device job. Resolves 'failed' for problems with this photo (it couldn't be decoded, it was
 * deleted); throws when the whole job must stop (aborted, signed out, someone else signed in).
 */
export async function runDeviceSteps(
  photo: Photo,
  params: DeviceJobParams,
  ctx: RunContext,
): Promise<RunResult> {
  const d = { ...defaultDeps, ...ctx.deps };
  const { signal, owner } = ctx;
  const skinWanted = params.steps.includes('auto_enhance') && (params.skin ?? true);
  let faces: FaceBox[] | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      abortIf(signal);
      if (d.owner() !== owner) throw new DOMException('Signed in as someone else.', 'AbortError');
      const edit = await d.getEdit(photo.id, signal);
      const base = normalizeRecipe(edit?.recipe);
      const proxy = await d.loadProxy(photo, base, signal);
      if (skinWanted && faces === null) faces = await d.faces(photo, signal);
      abortIf(signal);
      const next = await applySteps(proxy, base, params, faces ?? [], ctx.reference);
      if (recipeJson(next) === recipeJson(base)) return { status: 'unchanged' };
      try {
        const saved = await d.saveEdit(photo.id, next, edit?.version ?? null, owner, signal);
        d.saved(photo, saved, owner);
        const { changedSliders } = await import('./enhance');
        return { status: 'done', edit: saved, changed: changedSliders(base, next) };
      } catch (e) {
        if (e instanceof ApiFailure && e.code === 'conflict' && attempt === 0) continue; // edited elsewhere: once more
        throw e;
      }
    }
    return { status: 'failed', error: 'conflict' };
  } catch (e) {
    if (stopping(e)) throw e;
    if (e instanceof ApiFailure) return { status: 'failed', error: e.code };
    return { status: 'failed', error: (e as Error)?.message || 'failed' };
  }
}
