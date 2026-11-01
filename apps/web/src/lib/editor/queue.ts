import {
  type EditRecipe,
  type PhotoEdit,
  type PhotoItem,
  VARIANT_LIMITS,
  type VariantKind,
} from '@zephyr/shared/client';
import { ApiFailure, errorMessage } from '../api';
import { emitLibrary } from '../bus';
import { getEdit, putEditVariant } from '../edits';
import { sessionUserId } from '../sessionGuard';
import { encodeVariant } from './encode';
import * as geometry from './geometry';

/**
 * Background queue that renders edited thumbnails and previews on this device and uploads them for the
 * edit version they were made from. Edits are already saved on the server; this only updates what the grid
 * shows. Batch jobs (paste, apply recipe, revert) show in the tray; the editor's own saves run silently.
 *
 * Every item is bound to the member who queued it, and the whole queue is reset when the session ends.
 */
export type RenderState = 'pending' | 'processing' | 'completed' | 'failed';

export interface RenderItem {
  photoId: string;
  name: string;
  version: number;
  state: RenderState;
  message?: string;
  /** Shown in the tray (batch work) or silent (editor saves, resumed renders). */
  visible: boolean;
}
export interface RenderJob {
  id: number;
  label: string;
  /** Undoes the batch (puts each photo's previous edit back). */
  undo?: () => Promise<void>;
  /** Extra line for the tray, e.g. photos skipped because they changed elsewhere. */
  note?: string;
}
export interface QueueSnapshot {
  items: RenderItem[];
  job: RenderJob | null;
  total: number;
  done: number;
  failed: number;
  busy: boolean;
}

export interface Rendered {
  thumb: Blob | null;
  preview: Blob | null;
}
export interface QueueDeps {
  owner(): string | null;
  /** Renders the photo's stored preview through the recipe (thumbnail ≤ 512 px, preview ≤ 2048 px). */
  render(photoId: string, recipe: EditRecipe): Promise<Rendered>;
  getEdit(photoId: string): Promise<PhotoEdit | null>;
  /** Uploads one variant on behalf of `owner` (the member who queued it). */
  put(photoId: string, kind: VariantKind, version: number, blob: Blob, owner: string): Promise<void>;
  onRendered?(photoId: string, version: number): void;
}

interface Rec extends RenderItem {
  owner: string;
  recipe?: EditRecipe;
  /** Variants already rendered by the editor from its own source (see enqueue). */
  rendered?: Promise<Rendered>;
}

export class RenderQueue {
  private recs = new Map<string, Rec>();
  private job: RenderJob | null = null;
  private running = false;
  private epoch = 0;
  private subs = new Set<() => void>();
  private snap: QueueSnapshot = { items: [], job: null, total: 0, done: 0, failed: 0, busy: false };
  private jobSeq = 0;

  constructor(private deps: QueueDeps) {}

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  private emit() {
    const items = [...this.recs.values()]
      .filter((r) => r.visible)
      .map(({ owner: _o, recipe: _r, ...it }) => it);
    this.snap = {
      items,
      job: this.job,
      total: items.length,
      done: items.filter((i) => i.state === 'completed').length,
      failed: items.filter((i) => i.state === 'failed').length,
      busy: items.some((i) => i.state === 'pending' || i.state === 'processing'),
    };
    for (const s of this.subs) s();
  }

  /** Starts a visible batch (replaces the finished one in the tray). */
  startJob(label: string, undo?: () => Promise<void>, note?: string): RenderJob {
    for (const [id, r] of this.recs)
      if (r.visible && r.state !== 'pending' && r.state !== 'processing') this.recs.delete(id);
    this.job = { id: ++this.jobSeq, label, undo, note };
    this.emit();
    return this.job;
  }

  /**
   * Queues renders. A newer version replaces a queued older one; older versions are ignored.
   *
   * `rendered` carries variants the editor already made from the source on screen. For a RAW that is the
   * LibRaw decode, so the grid matches what the member saw. Batch work (paste, apply recipe, resumed renders)
   * has no editor source and renders from the stored preview instead: for a RAW that is the camera's JPEG, so
   * its thumbnail can differ slightly from the editor (the camera's own tone curve sits under the recipe).
   */
  enqueue(
    items: {
      photoId: string;
      name: string;
      version: number;
      recipe?: EditRecipe;
      rendered?: Promise<Rendered>;
    }[],
    visible: boolean,
    /** The member the work belongs to (an open editor's member). Nothing is queued if someone else is signed in. */
    forOwner?: string,
  ): void {
    const owner = this.deps.owner();
    if (!owner || (forOwner !== undefined && forOwner !== owner)) return;
    for (const it of items) {
      const have = this.recs.get(it.photoId);
      if (have && have.version > it.version) continue;
      if (have && have.version === it.version && have.state !== 'failed') {
        if (visible && !have.visible) have.visible = true;
        continue;
      }
      this.recs.set(it.photoId, {
        photoId: it.photoId,
        name: it.name,
        version: it.version,
        recipe: it.recipe,
        rendered: it.rendered,
        state: 'pending',
        visible: visible || Boolean(have?.visible && have.state !== 'completed'),
        owner,
      });
    }
    this.emit();
    void this.pump();
  }

  /** Picks up edits whose thumbnails were never rendered (the tab closed mid-batch, say). */
  resume(photos: Pick<PhotoItem, 'id' | 'filename' | 'edit'>[]): void {
    const todo = photos
      .filter((p) => p.edit && !p.edit.rendered && !this.recs.has(p.id))
      .map((p) => ({ photoId: p.id, name: p.filename, version: (p.edit as { version: number }).version }));
    if (todo.length) this.enqueue(todo, false);
  }

  /** Marks a photo as needing nothing (reverted): drop any queued render. */
  forget(photoId: string): void {
    const r = this.recs.get(photoId);
    if (r && r.state === 'pending') this.recs.delete(photoId);
    this.emit();
  }

  retryFailed(): void {
    for (const r of this.recs.values())
      if (r.state === 'failed') {
        r.state = 'pending';
        r.message = undefined;
      }
    this.emit();
    void this.pump();
  }

  dismiss(): void {
    if (this.snap.busy) return;
    for (const [id, r] of this.recs) if (r.visible) this.recs.delete(id);
    this.job = null;
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch;
    try {
      for (;;) {
        if (epoch !== this.epoch) return;
        const next = [...this.recs.values()].find((r) => r.state === 'pending');
        if (!next) return;
        if (next.owner !== this.deps.owner()) {
          next.state = 'failed';
          next.message = 'Signed in as someone else';
          this.emit();
          continue;
        }
        next.state = 'processing';
        this.emit();
        await this.run(next, epoch);
        if (epoch !== this.epoch) return;
        this.emit();
      }
    } finally {
      if (epoch === this.epoch) this.running = false;
    }
  }

  private async run(r: Rec, epoch: number): Promise<void> {
    const version = r.version;
    try {
      let recipe = r.recipe;
      if (!recipe) {
        const e = await this.deps.getEdit(r.photoId);
        if (epoch !== this.epoch) return;
        if (!e || e.version !== version) {
          // Reverted or edited again since: whoever changed it renders the newer version.
          r.state = 'completed';
          return;
        }
        recipe = e.recipe;
      }
      const pre = r.rendered;
      r.rendered = undefined; // a retry renders from the stored preview
      const out = (pre && (await pre.catch(() => null))) || (await this.deps.render(r.photoId, recipe));
      if (epoch !== this.epoch || this.recs.get(r.photoId) !== r) return;
      for (const kind of ['thumb', 'preview'] as const) {
        const b = out[kind];
        if (!b) continue;
        if (r.owner !== this.deps.owner() || epoch !== this.epoch) return;
        await this.deps.put(r.photoId, kind, version, b, r.owner);
      }
      r.state = 'completed';
      this.deps.onRendered?.(r.photoId, version);
    } catch (e) {
      if (epoch !== this.epoch) return;
      if (
        e instanceof ApiFailure &&
        (e.code === 'upload_expired' || e.status === 410 || e.code === 'not_found')
      ) {
        // A newer edit (or a revert) replaced this version: nothing to do.
        r.state = 'completed';
      } else if (e instanceof ApiFailure && (e.code === 'storage_full' || e.code === 'quota_exceeded')) {
        // The edit is saved; the grid keeps the original thumbnail with an edited badge.
        r.state = 'completed';
        r.message = 'Storage full · original thumbnail kept';
      } else {
        r.state = 'failed';
        r.message = errorMessage(e);
      }
    }
  }

  /** Empties the queue (session ended). Work in flight finishes but its results are dropped. */
  reset(): void {
    this.epoch++;
    this.running = false;
    this.recs.clear();
    this.job = null;
    this.emit();
  }
}

// ------------------------------------------------------------ app instance
/**
 * Renders edited variants (preview ≤ 2048 px, thumbnail ≤ 512 px) from whatever source `gl` holds. Both
 * pixel reads happen synchronously, before this returns, so the editor can switch photos straight after
 * without the variants picking up the next photo; only the encoding is async.
 */
export function renderVariantsFrom(
  gl: import('./gl').Renderer,
  recipe: EditRecipe,
  baselineEv: number,
): Promise<Rendered> {
  return renderVariantsSync(gl, recipe, baselineEv, geometry, encodeVariant);
}
export function renderVariantsSync(
  gl: import('./gl').Renderer,
  recipe: EditRecipe,
  baselineEv: number,
  geo: typeof import('./geometry'),
  encodeVariant: typeof import('./encode').encodeVariant,
): Promise<Rendered> {
  // A cut-out whose mask isn't in memory yet: the queue renders from the stored preview instead.
  if (!gl.cutoutReady(recipe)) {
    const missing = Promise.reject(new Error('The cut-out mask isn’t loaded yet.'));
    missing.catch(() => undefined); // handled by the queue later; not an unhandled rejection
    return missing;
  }
  const full = geo.outputSize(recipe.crop, gl.sourceSize);
  const jobs = (['preview', 'thumb'] as const).map((kind) => {
    const s = geo.fitLongEdge(full, VARIANT_LIMITS[kind].maxEdge);
    const px = gl.renderPixels({ recipe, width: s.width, height: s.height, baselineEv });
    return encodeVariant(px, s.width, s.height, kind);
  });
  return Promise.all(jobs).then(([preview, thumb]) => ({ preview: preview ?? null, thumb: thumb ?? null }));
}

/** Batch path: the stored preview (camera JPEG for a RAW) through the recipe. */
async function renderWithGpu(photoId: string, recipe: EditRecipe): Promise<Rendered> {
  const [{ withRenderer }, { loadPreview, releaseSource }, { activeCutout, loadMask }] = await Promise.all([
    import('./background'),
    import('./sources'),
    import('./cutout'),
  ]);
  // A background removal needs its mask first; if it can't load, the render fails (and can be retried)
  // rather than storing thumbnails without the cut-out.
  const cut = activeCutout(recipe);
  if (cut) await loadMask(photoId, cut.mask);
  return withRenderer(async (gl) => {
    const loaded = await loadPreview(photoId, Math.min(gl.maxTexture, 4096));
    try {
      gl.setSource(loaded.source);
      return await renderVariantsSync(gl, recipe, 0, geometry, encodeVariant);
    } finally {
      releaseSource(loaded.source);
    }
  });
}

export const renderQueue = new RenderQueue({
  owner: sessionUserId,
  render: renderWithGpu,
  getEdit: (id) => getEdit(id),
  put: (id, kind, version, blob, owner) => putEditVariant(id, kind, version, blob, undefined, owner),
  onRendered: (id, version) =>
    emitLibrary({ type: 'updated', photos: [{ id, edit: { version, rendered: true } }] }),
});
