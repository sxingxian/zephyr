import {
  type EditRecipe,
  EMPTY_RECIPE,
  isEmptyRecipe,
  normalizeRecipe,
  type PhotoEdit,
  recipeJson,
} from '@zephyr/shared/client';
import { ApiFailure, errorMessage } from '../api';
import { activeCutout, getMask, loadMask } from './cutout';
import { onEditorReset } from './resets';

/**
 * One photo's edit while the editor is open: the current recipe, undo/redo history, and autosave.
 *
 * Slider drags call `preview` (no history entry, no save); releasing calls `commit`, which records one
 * undo step and schedules a save 800 ms later. Saves run one at a time against the version they were based
 * on; a 409 from the server (another tab saved first) puts the session in `conflict` until the member
 * picks "Load the newer edit" or "Keep mine".
 */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

export interface EditSnapshot {
  recipe: EditRecipe;
  canUndo: boolean;
  canRedo: boolean;
  status: SaveStatus;
  error: string | null;
  /** The newer edit the server has, while in conflict. */
  conflict: PhotoEdit | null;
  version: number | null;
}

export interface EditDeps {
  /** `signal` aborts when the session closes (the member signed out or someone else signed in). */
  save(
    photoId: string,
    recipe: EditRecipe,
    baseVersion: number | null,
    signal: AbortSignal,
  ): Promise<PhotoEdit>;
  remove(photoId: string, signal: AbortSignal): Promise<void>;
  /** A save landed: render edited thumbnails for this version (null: reverted). */
  onSaved?(photoId: string, edit: PhotoEdit | null, recipe: EditRecipe): void;
  debounceMs?: number;
}

export const HISTORY_LIMIT = 100;

/** Every open session, so the end of a member's session can close them all (shared devices). */
const open = new Set<EditSession>();

export class EditSession {
  private recipe: EditRecipe;
  private committed: EditRecipe;
  private past: EditRecipe[] = [];
  private future: EditRecipe[] = [];
  private savedJson: string;
  private version: number | null;
  private status: SaveStatus = 'saved';
  private error: string | null = null;
  private conflict: PhotoEdit | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private subs = new Set<() => void>();
  private snap: EditSnapshot;
  private closed = false;
  private ctrl = new AbortController();

  /**
   * `owner` is the member who opened the photo. The caller binds it into `deps` (every save names that
   * member), and the session is closed when that member's session ends.
   */
  constructor(
    readonly photoId: string,
    initial: PhotoEdit | null,
    private deps: EditDeps,
    readonly owner: string | null = null,
  ) {
    open.add(this);
    this.recipe = normalizeRecipe(initial?.recipe ?? EMPTY_RECIPE);
    this.committed = this.recipe;
    this.savedJson = recipeJson(this.recipe);
    this.version = initial?.version ?? null;
    this.snap = this.makeSnap();
    this.watchMask();
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  private emit() {
    this.watchMask();
    this.snap = this.makeSnap();
    for (const s of this.subs) s();
  }
  private makeSnap(): EditSnapshot {
    return {
      recipe: this.recipe,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      status: this.status,
      error: this.error,
      conflict: this.conflict,
      version: this.version,
    };
  }

  /**
   * Phase 6: when the recipe shows a cut-out whose mask isn't loaded yet, load it, then hand out a fresh
   * recipe object so the editor renders again with the cut-out. A failed load leaves the photo showing its
   * background (the renderer skips a cut-out without a mask).
   */
  private maskWanted: string | null = null;
  private watchMask() {
    const c = activeCutout(this.recipe);
    if (!c || c.mask === this.maskWanted || getMask(c.mask)) return;
    this.maskWanted = c.mask;
    const id = c.mask;
    loadMask(this.photoId, id, this.ctrl.signal).then(
      () => {
        if (this.closed || activeCutout(this.recipe)?.mask !== id) return;
        this.recipe = { ...this.recipe };
        if (recipeJson(this.committed) === recipeJson(this.recipe)) this.committed = this.recipe;
        this.snap = this.makeSnap();
        for (const sub of this.subs) sub();
      },
      () => {
        // Not retried for this photo while it stays open (no request on every slider move).
      },
    );
  }

  /** Live change while dragging: shown, not recorded or saved yet. */
  preview(next: EditRecipe): void {
    this.recipe = normalizeRecipe(next);
    this.emit();
  }

  /** Records a change as one undo step and schedules a save. Pass nothing to commit the last preview. */
  commit(next?: EditRecipe): void {
    const n = normalizeRecipe(next ?? this.recipe);
    if (recipeJson(n) === recipeJson(this.committed)) {
      this.recipe = n;
      this.emit();
      return;
    }
    this.past.push(this.committed);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.committed = n;
    this.recipe = n;
    this.schedule();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.committed);
    this.committed = prev;
    this.recipe = prev;
    this.schedule();
  }
  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.committed);
    this.committed = next;
    this.recipe = next;
    this.schedule();
  }
  /** Revert to original: one undo step, saved as a delete. */
  revert(): void {
    this.commit(EMPTY_RECIPE);
  }

  private schedule() {
    if (this.closed) return;
    if (this.status !== 'conflict') {
      this.status = recipeJson(this.committed) === this.savedJson ? 'saved' : 'pending';
      this.error = null;
    }
    this.emit();
    if (this.timer) clearTimeout(this.timer);
    if (this.status === 'pending')
      this.timer = setTimeout(() => void this.flush(), this.deps.debounceMs ?? 800);
  }

  /** Saves now (leaving the photo, closing the editor). Resolves when everything is saved or failed. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    if (this.inflight) {
      await this.inflight;
    }
    if (this.status === 'conflict') return;
    const target = this.committed;
    const json = recipeJson(target);
    if (json === this.savedJson) {
      if (this.status !== 'saved') {
        this.status = 'saved';
        this.emit();
      }
      return;
    }
    this.status = 'saving';
    this.emit();
    this.inflight = this.write(target, json).finally(() => {
      this.inflight = null;
    });
    await this.inflight;
    // Changes made while saving: save again.
    if (
      !this.closed &&
      (this.status as SaveStatus) === 'saved' &&
      recipeJson(this.committed) !== this.savedJson
    )
      await this.flush();
  }

  private async write(target: EditRecipe, json: string): Promise<void> {
    try {
      if (isEmptyRecipe(target)) {
        if (this.version !== null) await this.deps.remove(this.photoId, this.ctrl.signal);
        this.version = null;
        this.savedJson = json;
        this.deps.onSaved?.(this.photoId, null, target);
      } else {
        const edit = await this.deps.save(this.photoId, target, this.version, this.ctrl.signal);
        this.version = edit.version;
        this.savedJson = json;
        this.deps.onSaved?.(this.photoId, edit, target);
      }
      this.status = recipeJson(this.committed) === this.savedJson ? 'saved' : 'pending';
      this.error = null;
    } catch (e) {
      if (this.closed) return; // aborted because the session ended: nothing to show
      if (e instanceof ApiFailure && e.code === 'conflict') {
        const edit = (e.body as { edit?: PhotoEdit } | undefined)?.edit ?? null;
        this.status = 'conflict';
        this.conflict = edit;
      } else {
        this.status = 'error';
        this.error = errorMessage(e);
      }
    }
    this.emit();
  }

  /** "Load the newer edit": take the server's version (one undo step back to mine). */
  takeTheirs(): void {
    const c = this.conflict;
    this.conflict = null;
    this.status = 'saved';
    const theirs = normalizeRecipe(c?.recipe ?? EMPTY_RECIPE);
    this.version = c?.version ?? null;
    this.savedJson = recipeJson(theirs);
    this.past.push(this.committed);
    this.future = [];
    this.committed = theirs;
    this.recipe = theirs;
    this.emit();
  }
  /** "Keep mine": save over the newer version. */
  keepMine(): void {
    const c = this.conflict;
    this.conflict = null;
    this.version = c?.version ?? null;
    this.status = 'pending';
    this.emit();
    void this.flush();
  }
  /** Retry after an error. */
  retry(): void {
    if (this.status === 'error') {
      this.status = 'pending';
      void this.flush();
    }
  }

  get dirty(): boolean {
    return recipeJson(this.committed) !== this.savedJson || this.status === 'saving';
  }

  /** Stops autosave and aborts any save in flight, without saving (left the photo, or the session ended). */
  close(): void {
    this.closed = true;
    open.delete(this);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ctrl.abort();
    this.subs.clear();
  }
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The member's session ended. On a deliberate sign-out the session is still valid, so unsaved edits are
 * saved first (signing out waits a few seconds at most); otherwise nothing more is sent. Either way every
 * open session is closed, so no autosave or retry can go out under the next member.
 */
export async function closeEditSessions(saveFirst: boolean): Promise<void> {
  const all = [...open];
  if (saveFirst) await Promise.all(all.map((s) => s.flush().catch(() => undefined)));
  for (const s of all) s.close();
}
onEditorReset(({ server }) => closeEditSessions(server));
