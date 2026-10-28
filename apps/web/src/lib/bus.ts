import type { PhotoItem } from '@zephyr/shared/client';

/** Library change events, so the grid, viewer, albums and storage meter stay in step without refetching. */
export type LibraryEvent =
  | { type: 'added'; photo: PhotoItem }
  | { type: 'updated'; photos: (Partial<PhotoItem> & { id: string })[] }
  | { type: 'removed'; ids: string[] }
  | { type: 'albums' };

type Listener = (e: LibraryEvent) => void;
const listeners = new Set<Listener>();

export function emitLibrary(e: LibraryEvent): void {
  for (const l of listeners) l(e);
}
export function onLibrary(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
