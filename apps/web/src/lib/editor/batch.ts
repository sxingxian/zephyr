import type { EditRecipe, EditSection, PhotoEdit, PhotoItem } from '@zephyr/shared/client';
import { emitLibrary } from '../bus';
import { bulkEdits, getEdit, saveEdit } from '../edits';
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

/**
 * Paste or apply a recipe to several photos (one request per 500), then render their thumbnails in the
 * background. Keeps each photo's previous edit so the tray's "Undo paste" can put it back.
 */
export async function applyToPhotos(
  photos: Photo[],
  recipe: EditRecipe | null,
  sections: EditSection[],
  label: string,
): Promise<number> {
  if (!photos.length) return 0;
  const names = new Map(photos.map((p) => [p.id, p.filename]));
  // Previous recipes, for undo: only photos that have an edit need fetching.
  const previous = new Map<string, EditRecipe | null>();
  await mapLimit(photos, 6, async (p) => {
    previous.set(p.id, p.edit ? ((await getEdit(p.id).catch(() => null))?.recipe ?? null) : null);
  });
  const res = await bulkEdits({ ids: photos.map((p) => p.id), recipe, sections });
  announce(res.edits);
  const changed = res.edits;
  const undo = async () => {
    const back = changed.map((c) => ({ id: c.photoId, prev: previous.get(c.photoId) ?? null, now: c.edit }));
    const toRevert = back.filter((b) => !b.prev).map((b) => b.id);
    const restored: { photoId: string; edit: PhotoEdit | null }[] = [];
    if (toRevert.length) {
      const r = await bulkEdits({ ids: toRevert, recipe: null, sections: [] });
      restored.push(...r.edits);
    }
    await mapLimit(
      back.filter((b) => b.prev),
      6,
      async (b) => {
        const e = await saveEdit(b.id, b.prev as EditRecipe, b.now?.version ?? null);
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
    );
  };
  renderQueue.startJob(label, undo);
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
  );
  for (const c of changed) if (!c.edit) renderQueue.forget(c.photoId);
  return res.affected;
}
