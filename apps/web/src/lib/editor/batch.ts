import type { EditRecipe, EditSection, PhotoEdit, PhotoItem } from '@zephyr/shared/client';
import { emitLibrary } from '../bus';
import { bulkEdits, getEdit, saveEdit } from '../edits';
import { sessionUserId } from '../sessionGuard';
import { renderQueue } from './queue';

type Photo = Pick<PhotoItem, 'id' | 'filename' | 'edit'>;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function announce(edits: { photoId: string; edit: PhotoEdit | null }[]) {
  emitLibrary({
    type: 'updated',
    photos: edits.map(({ photoId, edit }) => ({
      id: photoId,
      edit: edit ? { version: edit.version, rendered: false } : null,
    })),
  });
}

/** "3 photos changed elsewhere and were skipped" (photos another tab or device edited meanwhile). */
export function skippedNote(skipped: number): string | undefined {
  if (!skipped) return undefined;
  return `${skipped} photo${skipped === 1 ? '' : 's'} changed elsewhere and ${skipped === 1 ? 'was' : 'were'} skipped`;
}

/**
 * Paste or apply a recipe to several photos (one request per 500), then render their thumbnails in the
 * background. Keeps each photo's previous edit so the tray's "Undo paste" can put it back.
 *
 * Everything (the request, the undo, the thumbnails) is done for the member who started it.
 */
export async function applyToPhotos(
  photos: Photo[],
  recipe: EditRecipe | null,
  sections: EditSection[],
  label: string,
): Promise<{ affected: number; skipped: number }> {
  if (!photos.length) return { affected: 0, skipped: 0 };
  const owner = sessionUserId();
  if (!owner) return { affected: 0, skipped: 0 };
  const names = new Map(photos.map((p) => [p.id, p.filename]));
  // Previous recipes, for undo: only photos that have an edit need fetching.
  const previous = new Map<string, EditRecipe | null>();
  await mapLimit(photos, 6, async (p) => {
    previous.set(p.id, p.edit ? ((await getEdit(p.id).catch(() => null))?.recipe ?? null) : null);
  });
  const res = await bulkEdits({ ids: photos.map((p) => p.id), recipe, sections }, owner);
  announce(res.edits);
  const changed = res.edits;
  const undo = async () => {
    const back = changed.map((c) => ({ id: c.photoId, prev: previous.get(c.photoId) ?? null, now: c.edit }));
    const toRevert = back.filter((b) => !b.prev).map((b) => b.id);
    const restored: { photoId: string; edit: PhotoEdit | null }[] = [];
    if (toRevert.length) {
      const r = await bulkEdits({ ids: toRevert, recipe: null, sections: [] }, owner);
      restored.push(...r.edits);
    }
    await mapLimit(
      back.filter((b) => b.prev),
      6,
      async (b) => {
        const e = await saveEdit(b.id, b.prev as EditRecipe, b.now?.version ?? null, owner);
        restored.push({ photoId: b.id, edit: e });
      },
    );
    announce(restored);
    renderQueue.startJob(`Undoing · ${label}`);
    renderQueue.enqueue(
      restored
        .filter((r) => r.edit)
        .map((r) => ({
          photoId: r.photoId,
          name: names.get(r.photoId) ?? '',
          version: (r.edit as PhotoEdit).version,
          recipe: (r.edit as PhotoEdit).recipe,
        })),
      true,
      owner,
    );
  };
  renderQueue.startJob(label, undo, skippedNote(res.skipped.length));
  renderQueue.enqueue(
    changed
      .filter((c) => c.edit)
      .map((c) => ({
        photoId: c.photoId,
        name: names.get(c.photoId) ?? '',
        version: (c.edit as PhotoEdit).version,
        recipe: (c.edit as PhotoEdit).recipe,
      })),
    true,
    owner,
  );
  for (const c of changed) if (!c.edit) renderQueue.forget(c.photoId);
  return { affected: res.affected, skipped: res.skipped.length };
}
