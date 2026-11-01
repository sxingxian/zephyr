import {
  DEFAULT_PASTE_SECTIONS,
  type EditRecipe,
  type EditSection,
  EMPTY_RECIPE,
  FILE_TYPES,
  mergeRecipe,
  normalizeRecipe,
  type PhotoDetail,
  type PhotoEdit,
  pickSections,
  RECIPE_SECTIONS,
  type SavedRecipe,
} from '@zephyr/shared/client';
import { Button, Chip, Icon, IconButton, Mascot, Spinner, useToast } from '@zephyr/ui';
import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { editorAi, useAiStatus } from '../../lib/aiClient';
import { errorMessage } from '../../lib/api';
import { emitLibrary } from '../../lib/bus';
import { copyEdits, useCopied } from '../../lib/editor/clipboard';
import { renderExport, saveBlob } from '../../lib/editor/exporter';
import { startExportJob } from '../../lib/editor/exportJob';
import { aspectFor, centredRect, FULL, orientedSize, outputSize } from '../../lib/editor/geometry';
import { Renderer, supportsEditor } from '../../lib/editor/gl';
import { cleanExportName, ExportProblem } from '../../lib/editor/names';
import { type Rendered, renderQueue, renderVariantsFrom } from '../../lib/editor/queue';
import { EditSession } from '../../lib/editor/session';
import { isRaw, loadOriginal, loadPreview, releaseSource } from '../../lib/editor/sources';
import {
  createRecipe,
  deleteEdit,
  deleteRecipe,
  listRecipes,
  originalThumbUrl,
  patchRecipe,
  saveEdit,
} from '../../lib/edits';
import { getPhoto } from '../../lib/library';
import { sessionUserId } from '../../lib/sessionGuard';
import { uploads } from '../../lib/uploads';
import { type AiToast, EditorAiPanel } from '../ai/EditorAi';
import { useViewerHost } from '../LibraryBits';
import { CropOverlay } from './CropOverlay';
import { ConflictDialog, ExportDialog, PasteDialog, SaveRecipeDialog } from './Dialogs';
import {
  AdjustPanel,
  ASPECTS,
  aspectButton,
  aspectChoice,
  type CropActions,
  CropPanel,
  cropOrientation,
  type Edit,
  Histogram,
  type RecipeActions,
  RecipesPanel,
  type Tool,
  ToolTabs,
} from './Panels';
import { PhoneAdjust, PhoneCrop, PhoneRecipes } from './Phone';

type Compare = 'before' | 'split' | 'after';
type Zoom = 'fit' | '100' | '200';
const MAX_VIEW = 2560;

function usePhone(): boolean {
  const q = '(max-width: 860px)';
  return useSyncExternalStore(
    (fn) => {
      if (typeof matchMedia !== 'function') return () => {};
      const m = matchMedia(q);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => (typeof matchMedia === 'function' ? matchMedia(q).matches : false),
    () => false,
  );
}

/** "Saved · original untouched", "Saving…", conflicts and errors, for screen readers too. */
function SaveState({
  status,
  error,
  onRetry,
}: {
  status: string;
  error: string | null;
  onRetry: () => void;
}) {
  if (status === 'saving' || status === 'pending')
    return (
      <span className="esave" role="status">
        <Spinner size={12} />
        Saving…
      </span>
    );
  if (status === 'error')
    return (
      <span className="esave esave--bad" role="status">
        <Icon name="alert" size={14} />
        {error ?? 'Not saved'}
        <button type="button" className="text-link" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  if (status === 'conflict')
    return (
      <span className="esave esave--bad" role="status">
        <Icon name="alert" size={14} />
        Edited elsewhere
      </span>
    );
  return (
    <span className="esave" role="status">
      <Icon name="check" size={14} className="esave__ok" />
      Saved · original untouched
    </span>
  );
}

/** Full-screen editor at /edit/:photoId. */
export function Editor({ photoId }: { photoId: string }) {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const phone = usePhone();
  const { list } = useViewerHost();
  const [supported] = useState(() => supportsEditor());
  const [photo, setPhoto] = useState<PhotoDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [session, setSession] = useState<EditSession | null>(null);
  const [tool, setTool] = useState<Tool>('adjust');
  const aiStatus = useAiStatus();
  const showAi = editorAi(aiStatus);
  const [aiToast, setAiToast] = useState<AiToast | null>(null);
  // The AI tab disappears if Zephyr AI is switched off while it's open.
  useEffect(() => {
    if (tool === 'ai' && !showAi) setTool('adjust');
  }, [tool, showAi]);
  useEffect(() => {
    if (!aiToast) return;
    const t = setTimeout(() => setAiToast(null), 8000);
    return () => clearTimeout(t);
  }, [aiToast]);
  const [compare, setCompare] = useState<Compare>('after');
  const [held, setHeld] = useState(false);
  const [splitX, setSplitX] = useState(0.5);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [hover, setHover] = useState<EditRecipe | null>(null);
  const [srcState, setSrcState] = useState<{
    quality: string;
    baselineEv: number;
    loadingFull: boolean;
    note: string | null;
  }>({
    quality: 'none',
    baselineEv: 0,
    loadingFull: false,
    note: null,
  });
  const [hist, setHist] = useState<ReturnType<Renderer['histogram']>>(null);
  const [dialog, setDialog] = useState<null | 'export' | 'paste' | 'save' | 'rename'>(null);
  const [renaming, setRenaming] = useState<SavedRecipe | null>(null);
  const [saved, setSaved] = useState<SavedRecipe[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const copied = useCopied();

  const canvas = useRef<HTMLCanvasElement | null>(null);
  const frameEl = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | null>(null);
  /** What the on-screen renderer currently holds, so a save can render variants from it (RAW decodes). */
  const srcRef = useRef<{ photoId: string; quality: string; baselineEv: number } | null>(null);
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 });
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 });

  const items = list?.items ?? [];
  const index = items.findIndex((p) => p.id === photoId);
  const name = photo?.filename ?? items[index]?.filename ?? '';

  // ---------------------------------------------------------- photo + session
  useEffect(() => {
    const c = new AbortController();
    setPhoto(null);
    setLoadError(null);
    setSession(null);
    setHover(null);
    // Every save names the member who opened the photo, never whoever is signed in when it goes out. Taken
    // before the photo loads, so a session that changes while it loads can't adopt this photo.
    const owner = sessionUserId();
    getPhoto(photoId, c.signal)
      .then((p) => {
        if (c.signal.aborted || !owner || sessionUserId() !== owner) return;
        if (p.trashedAt) throw new Error('This photo is in the Trash. Restore it to edit.');
        setPhoto(p);
        const initial: PhotoEdit | null = p.edit
          ? {
              photoId,
              recipe: normalizeRecipe(p.recipe ?? EMPTY_RECIPE),
              version: p.edit.version,
              rendered: p.edit.rendered,
              updatedAt: '',
            }
          : null;
        const s = new EditSession(
          photoId,
          initial,
          {
            save: (id, r, base, signal) => saveEdit(id, r, base, owner, signal),
            remove: (id, signal) => deleteEdit(id, owner, signal),
            onSaved: (id, edit, r) => {
              emitLibrary({
                type: 'updated',
                photos: [{ id, edit: edit ? { version: edit.version, rendered: false } : null }],
              });
              if (edit) {
                // A RAW open in the editor renders its variants from the LibRaw decode on screen, so the grid
                // matches what the member saw. Anything else renders from the stored preview in the queue.
                const held = srcRef.current;
                const gl = renderer.current;
                let rendered: Promise<Rendered> | undefined;
                if (
                  gl?.hasSource &&
                  held?.photoId === id &&
                  (held.quality === 'half' || held.quality === 'full')
                )
                  rendered = renderVariantsFrom(gl, r, held.baselineEv);
                renderQueue.enqueue(
                  [{ photoId: id, name: p.filename, version: edit.version, recipe: r, rendered }],
                  false,
                  owner,
                );
              } else renderQueue.forget(id);
            },
          },
          owner,
        );
        setSession(s);
      })
      .catch((e) => {
        if (!c.signal.aborted && (e as Error).name !== 'AbortError') setLoadError(errorMessage(e));
      });
    return () => c.abort();
  }, [photoId]);

  // Save on leaving the photo (filmstrip, back) and stop autosave.
  useEffect(
    () => () => {
      if (session) void session.flush().finally(() => session.close());
    },
    [session],
  );

  const snap = useSyncExternalStore(
    session?.subscribe ?? noopSub,
    session?.getSnapshot ?? emptySnap,
    session?.getSnapshot ?? emptySnap,
  );
  const recipe = snap.recipe;

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!session) return;
    const h = (e: BeforeUnloadEvent) => {
      if (session.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [session]);

  // ---------------------------------------------------------- renderer + source
  // The renderer owns its canvas (a fresh one per mount, so a lost context is never reused).
  const [rendererReady, setRendererReady] = useState(0);
  useEffect(() => {
    const host = frameEl.current;
    if (!supported || !host) return;
    const c = document.createElement('canvas');
    c.className = 'editor__canvas';
    c.setAttribute('role', 'img');
    host.prepend(c);
    canvas.current = c;
    try {
      renderer.current = new Renderer(c);
      setRendererReady((n) => n + 1);
    } catch {
      renderer.current = null;
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
      canvas.current = null;
      c.remove();
    };
  }, [supported]);
  useEffect(() => {
    canvas.current?.setAttribute('aria-label', `${name}${before ? ', original' : ''}`);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the renderer is recreated
  useEffect(() => {
    if (!photo || !supported) return;
    const r = renderer.current;
    if (!r) return;
    const c = new AbortController();
    let cancelled = false;
    setSrcState({ quality: 'none', baselineEv: 0, loadingFull: true, note: null });
    srcRef.current = null;
    (async () => {
      if (photo.hasPreview) {
        try {
          const pv = await loadPreview(photo.id, r.maxTexture, c.signal);
          if (cancelled) return releaseSource(pv.source);
          r.setSource(pv.source);
          releaseSource(pv.source);
          srcRef.current = { photoId: photo.id, quality: 'preview', baselineEv: 0 };
          setSrcState((s) => ({ ...s, quality: 'preview' }));
        } catch {
          // fall through to the original
        }
      }
      try {
        const full = await loadOriginal(photo, { full: false, maxEdge: r.maxTexture, signal: c.signal });
        if (cancelled) return releaseSource(full.source);
        r.setSource(full.source);
        releaseSource(full.source);
        srcRef.current = { photoId: photo.id, quality: full.quality, baselineEv: full.baselineEv };
        setSrcState({ quality: full.quality, baselineEv: full.baselineEv, loadingFull: false, note: null });
      } catch (e) {
        if (cancelled || (e as Error).name === 'AbortError') return;
        setSrcState((s) => ({
          ...s,
          loadingFull: false,
          note: s.quality === 'preview' ? `Editing the stored preview: ${errorMessage(e)}` : errorMessage(e),
        }));
      }
    })();
    return () => {
      cancelled = true;
      c.abort();
    };
  }, [photo, supported, rendererReady]);

  // ---------------------------------------------------------- stage size
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setStageSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------- render
  const shown = hover ?? recipe;
  const before = compare === 'before' || held;
  const ignoreRect = tool === 'crop';
  const frame = useRef(0);
  const lastHist = useRef(0);
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const r = renderer.current;
    if (!r || srcState.quality === 'none' || !r.hasSource) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const crop = before ? undefined : shown.crop;
      const full = outputSize(crop, r.sourceSize, ignoreRect);
      let w: number;
      let h: number;
      if (zoom === 'fit') {
        const pad = phone ? 0 : 64;
        const bw = Math.max(50, stageSize.w - pad);
        const bh = Math.max(50, stageSize.h - pad);
        const k = Math.min(bw / full.width, bh / full.height);
        setCssSize({ w: Math.round(full.width * k), h: Math.round(full.height * k) });
        const ps = Math.min(1, k * dpr, MAX_VIEW / Math.max(full.width, full.height));
        w = Math.max(1, Math.round(full.width * ps));
        h = Math.max(1, Math.round(full.height * ps));
      } else {
        const cap = Math.min(1, 4096 / Math.max(full.width, full.height));
        w = Math.round(full.width * cap);
        h = Math.round(full.height * cap);
        const z = zoom === '200' ? 2 : 1;
        setCssSize({ w: Math.round((w / cap) * z), h: Math.round((h / cap) * z) });
      }
      try {
        r.renderView({
          recipe: before ? null : shown,
          width: w,
          height: h,
          ignoreRect,
          split: compare === 'split' && !held ? splitX : undefined,
          before,
          baselineEv: srcState.baselineEv,
        });
      } catch {
        return;
      }
      const now = performance.now();
      const doHist = () => {
        lastHist.current = performance.now();
        setHist(r.histogram());
      };
      if (histTimer.current) clearTimeout(histTimer.current);
      if (now - lastHist.current > 150) doHist();
      else histTimer.current = setTimeout(doHist, 160);
    });
  }, [shown, before, ignoreRect, zoom, stageSize, compare, held, splitX, srcState, phone]);

  // ---------------------------------------------------------- edit actions
  const edit: Edit = useMemo(
    () => ({
      recipe,
      preview: (r) => session?.preview(r),
      commit: (r) => session?.commit(r),
    }),
    [recipe, session],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the source changes (srcState)
  const tSize = useMemo(() => {
    const r = renderer.current;
    const src = r?.hasSource ? r.sourceSize : { width: photo?.width ?? 3, height: photo?.height ?? 2 };
    return orientedSize(src, recipe.crop);
  }, [recipe.crop, photo, srcState.quality]);

  const orientation = cropOrientation(recipe.crop?.aspect, tSize);
  const cropActions: CropActions = {
    orientation,
    setAspect: (a) => {
      const def = ASPECTS.find((x) => x.id === a);
      const actual = def ? aspectChoice(def, orientation).aspect : a;
      const rect = a === 'free' ? (recipe.crop?.rect ?? FULL) : centredRect(aspectFor(actual, tSize), tSize);
      edit.commit({ ...recipe, crop: { ...(recipe.crop ?? {}), aspect: actual, rect } });
    },
    setOrientation: (portrait) => {
      const def = ASPECTS.find((x) => x.id === aspectButton(recipe.crop?.aspect));
      if (!def?.portrait) return;
      const actual = aspectChoice(def, portrait ? 'portrait' : 'landscape').aspect;
      edit.commit({
        ...recipe,
        crop: { ...(recipe.crop ?? {}), aspect: actual, rect: centredRect(aspectFor(actual, tSize), tSize) },
      });
    },
    rotate: (dir) => {
      const q = ((((recipe.crop?.quarterTurns ?? 0) + dir) % 4) + 4) % 4;
      const swapped = { width: tSize.height, height: tSize.width };
      const a = recipe.crop?.aspect;
      edit.commit({
        ...recipe,
        crop: {
          ...(recipe.crop ?? {}),
          quarterTurns: q,
          rect: centredRect(a && a !== 'free' ? aspectFor(a, swapped) : null, swapped),
        },
      });
    },
    flip: (axis) => {
      const k = axis === 'h' ? 'flipH' : 'flipV';
      edit.commit({ ...recipe, crop: { ...(recipe.crop ?? {}), [k]: !recipe.crop?.[k] } });
    },
  };

  // Recipes
  useEffect(() => {
    if (tool !== 'recipes' || saved) return;
    listRecipes()
      .then(setSaved)
      .catch((e) => setSavedError(errorMessage(e)));
  }, [tool, saved]);
  const recipeActions: RecipeActions = {
    saved,
    error: savedError,
    hover: setHover,
    apply: (r, n) => {
      setHover(null);
      edit.commit(mergeRecipe(recipe, r, RECIPE_SECTIONS));
      toast.show(`Applied “${n}”`, 'good');
    },
    save: () => setDialog('save'),
    rename: (s) => {
      setRenaming(s);
      setDialog('rename');
    },
    remove: async (s) => {
      try {
        await deleteRecipe(s.id);
        setSaved((l) => l?.filter((x) => x.id !== s.id) ?? null);
        toast.show(`Deleted “${s.name}”`, 'good');
      } catch (e) {
        toast.show(errorMessage(e), 'bad');
      }
    },
    thumb: photo?.hasThumb ? originalThumbUrl(photo.id) : null,
  };

  // Copy / paste
  const copy = useCallback(() => {
    copyEdits(recipe, photoId, name);
    toast.show('Edits copied. Paste them on other photos from the library or the editor.', 'good');
  }, [recipe, photoId, name, toast]);
  const pasteSections = useCallback(
    (sections: EditSection[]) => {
      if (!copied) return;
      edit.commit(mergeRecipe(recipe, copied.recipe, sections));
    },
    [copied, recipe, edit],
  );

  // ---------------------------------------------------------- navigation + keys
  const close = useCallback(() => {
    const st = loc.state as { bg?: string; fromViewer?: boolean } | null;
    if (st?.fromViewer) nav(-1);
    else nav(st?.bg ?? '/', { replace: true });
  }, [nav, loc.state]);
  const go = (to: number) => {
    const next = items[to];
    if (!next) return;
    nav(`/edit/${encodeURIComponent(next.id)}`, { replace: true, state: loc.state });
    if (list?.hasMore && to >= items.length - 5) list.loadMore();
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest('input:not([type=range]), textarea, select, [contenteditable]');
      if (document.querySelector('dialog[open]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) session?.redo();
        else session?.undo();
      } else if (mod && e.key.toLowerCase() === 'c' && !typing && !window.getSelection()?.toString()) {
        e.preventDefault();
        copy();
      } else if (mod && e.key.toLowerCase() === 'v' && !typing && copied) {
        e.preventDefault();
        pasteSections([...DEFAULT_PASTE_SECTIONS]);
        toast.show('Pasted edits. Undo with ⌘Z.', 'good');
      } else if (!mod && !typing && e.key === '\\') {
        e.preventDefault();
        setHeld(true);
      } else if (!mod && !typing && (e.key === 'c' || e.key === 'C') && !e.altKey) {
        setTool('crop');
      } else if (e.key === 'Escape' && !typing) {
        if (tool === 'crop') setTool('adjust');
        else close();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === '\\') setHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [session, copy, copied, pasteSections, close, tool, toast]);

  // Split divider drag
  const splitDrag = useRef(false);
  const onSplitMove = (e: PointerEvent) => {
    if (!splitDrag.current || !canvas.current) return;
    const b = canvas.current.getBoundingClientRect();
    setSplitX(Math.min(0.98, Math.max(0.02, (e.clientX - b.left) / b.width)));
  };

  // ---------------------------------------------------------- export
  const exportDims = useMemo(() => {
    const w = photo?.width;
    const h = photo?.height;
    if (!w || !h) return null;
    const src =
      renderer.current?.hasSource && srcState.quality !== 'preview' && srcState.quality !== 'half'
        ? renderer.current.sourceSize
        : { width: w, height: h };
    return outputSize(recipe.crop, src);
  }, [photo, recipe.crop, srcState.quality]);

  const doExport = async (
    kind: 'download' | 'copy',
    c: { size: Parameters<typeof renderExport>[2]['size']; quality: number; name: string },
  ) => {
    if (!photo) return;
    // The export belongs to the member who started it: it stops if their session ends, and its result is
    // only saved or uploaded for them.
    const job = startExportJob();
    try {
      await session?.flush();
      job.check();
      const blob = await renderExport(photo, recipe, {
        size: c.size,
        quality: c.quality,
        signal: job.signal,
      });
      job.check();
      const fname = cleanExportName(c.name, photo.filename);
      if (kind === 'download') {
        await saveBlob(blob, fname, phone);
      } else {
        const res = await uploads.add(
          [new File([blob], fname, { type: 'image/jpeg', lastModified: Date.now() })],
          { expectedOwner: job.owner },
        );
        if (res !== 'queued') throw new ExportProblem('You were signed out, so the copy wasn’t saved.');
        toast.show('Saving a copy to your library. Watch the upload tray.', 'good');
      }
    } finally {
      job.finish();
    }
  };

  // ---------------------------------------------------------- render
  if (!supported) {
    return (
      <div className="editor editor--msg">
        <div className="editor__msg">
          <Mascot pose="ponder" width={180} tile={{ background: 'var(--m-mist)', height: 190 }} />
          <h1>This browser can’t run the editor</h1>
          <p>
            Editing uses WebGL 2, which this browser doesn’t offer. Try a current version of Chrome, Edge,
            Firefox or Safari. Your library and photos still work here.
          </p>
          <Button kind="primary" icon="chevL" onClick={close}>
            Back to library
          </Button>
        </div>
      </div>
    );
  }

  const raw = photo ? isRaw(photo) : false;
  const position =
    index >= 0
      ? `${index + 1} of ${(list?.total ?? items.length).toLocaleString('en')}${list?.hasMore && !list.total ? '+' : ''}`
      : null;
  const cropLabel = (() => {
    const r = recipe.crop?.rect ?? FULL;
    const src =
      photo?.width && photo.height
        ? orientedSize({ width: photo.width, height: photo.height }, recipe.crop)
        : tSize;
    const a = recipe.crop?.aspect;
    const deg = recipe.crop?.angle;
    return `${Math.round(src.width * r.w)} × ${Math.round(src.height * r.h)}${a && a !== 'free' ? ` · ${a}` : ''}${deg ? ` · ${deg > 0 ? '' : '−'}${Math.abs(deg)}°` : ''}`;
  })();
  const md = photo?.metadata ?? {};
  const info = [
    photo?.width && photo.height ? `${photo.width} × ${photo.height}` : null,
    [md.cameraMake && !md.cameraModel?.startsWith(md.cameraMake) ? md.cameraMake : null, md.cameraModel]
      .filter(Boolean)
      .join(' ') || null,
    photo ? (FILE_TYPES[photo.fileType]?.raw ? 'RAW' : FILE_TYPES[photo.fileType]?.label) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const histCaption = [
    md.iso ? `ISO ${md.iso}` : null,
    md.focalLengthMm ? `${md.focalLengthMm} mm` : null,
    md.aperture ? `f/${md.aperture}` : null,
    md.exposureSeconds
      ? md.exposureSeconds >= 1
        ? `${md.exposureSeconds} s`
        : `1/${Math.round(1 / md.exposureSeconds)} s`
      : null,
  ].filter(Boolean);

  const stageStyle = { '--cw': `${cssSize.w}px`, '--ch': `${cssSize.h}px` } as CSSProperties;
  const thumb = photo?.hasThumb ? originalThumbUrl(photo.id) : null;

  return (
    <section className={`editor${phone ? ' editor--phone' : ''}`} aria-label={`Editing ${name}`}>
      <header className="editor__top">
        {phone ? (
          <IconButton icon="chevL" label="Back" onClick={close} />
        ) : (
          <>
            <Button kind="ghost" size="sm" icon="chevL" onClick={close}>
              {list?.backLabel ?? 'Library'}
            </Button>
            <span className="editor__divider" aria-hidden="true" />
            <div className="editor__title">
              <span className="editor__name">
                {name}
                {raw && (
                  <Chip tone="outline" size="sm">
                    RAW
                  </Chip>
                )}
              </span>
              {position && <span className="editor__sub">{position}</span>}
            </div>
          </>
        )}
        <span className="editor__spacer" />
        {!phone && session && (
          <SaveState status={snap.status} error={snap.error} onRetry={() => session.retry()} />
        )}
        <div className="editor__group">
          <IconButton
            icon="undo"
            size="sm"
            label="Undo (⌘Z)"
            disabled={!snap.canUndo}
            onClick={() => session?.undo()}
          />
          <IconButton
            icon="redo"
            size="sm"
            label="Redo (⇧⌘Z)"
            disabled={!snap.canRedo}
            onClick={() => session?.redo()}
          />
          {phone && (
            <IconButton
              icon="compare"
              size="sm"
              label="Hold to compare with the original"
              onPointerDown={() => setHeld(true)}
              onPointerUp={() => setHeld(false)}
              onPointerLeave={() => setHeld(false)}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          {phone && (
            <div className="editor__menuwrap">
              <IconButton
                icon="more"
                size="sm"
                label="Copy, paste, revert"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              />
              {menu && (
                <div className="emenu emenu--top" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      copy();
                    }}
                  >
                    Copy edits
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!copied}
                    onClick={() => {
                      setMenu(false);
                      setDialog('paste');
                    }}
                  >
                    Paste edits
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      session?.revert();
                    }}
                  >
                    Revert to original
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {!phone && (
          <fieldset className="seg editor__compare">
            <legend className="z-sr">Compare with the original (hold \)</legend>
            {(['before', 'split', 'after'] as const).map((c) => (
              <label key={c} className="seg__btn">
                <input
                  type="radio"
                  className="z-sr"
                  name="compare"
                  checked={compare === c}
                  onChange={() => setCompare(c)}
                />
                {c === 'before' ? 'Before' : c === 'split' ? 'Split' : 'After'}
              </label>
            ))}
          </fieldset>
        )}
        {!phone && (
          <>
            <Button size="sm" icon="copy" onClick={copy} disabled={!session}>
              Copy edits
            </Button>
            <Button
              size="sm"
              icon="paste"
              onClick={() => setDialog('paste')}
              disabled={!copied || !session}
              title={copied ? `Paste edits from ${copied.fromName}` : 'Copy edits from a photo first'}
            >
              Paste
            </Button>
          </>
        )}
        <Button
          kind="primary"
          size="sm"
          icon="download"
          onClick={() => setDialog('export')}
          disabled={!photo}
          className={phone ? 'editor__export' : undefined}
        >
          Export
        </Button>
      </header>

      <div className="editor__body">
        <div className="editor__canvaswrap">
          <div
            className={`editor__stage editor__stage--${zoom}`}
            ref={stage}
            style={stageStyle}
            onPointerMove={onSplitMove}
            onPointerUp={() => {
              splitDrag.current = false;
            }}
          >
            {loadError ? (
              <div className="editor__err" role="alert">
                <p>{loadError}</p>
                <Button onClick={close}>Back</Button>
              </div>
            ) : (
              <div className="editor__frame" ref={frameEl}>
                {tool === 'crop' && srcState.quality !== 'none' && (
                  <CropOverlayBound edit={edit} t={tSize} label={cropLabel} />
                )}
                {compare === 'split' && !held && tool !== 'crop' && (
                  <>
                    <span className="esplit" style={{ left: `${splitX * 100}%` }} aria-hidden="true" />
                    <button
                      type="button"
                      className="esplit__handle"
                      style={{ left: `${splitX * 100}%` }}
                      aria-label="Move the split between original and edited"
                      onPointerDown={(e) => {
                        splitDrag.current = true;
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={onSplitMove}
                      onPointerUp={() => {
                        splitDrag.current = false;
                      }}
                      onKeyDown={(e) => {
                        const d = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0;
                        if (d) setSplitX((x) => Math.min(0.98, Math.max(0.02, x + d)));
                      }}
                    >
                      <Icon name="compare" size={18} />
                    </button>
                    <span className="esplit__tag esplit__tag--l">
                      <Chip tone="ink" size="sm">
                        Original
                      </Chip>
                    </span>
                    <span className="esplit__tag esplit__tag--r">
                      <Chip tone="acc" size="sm">
                        Edited
                      </Chip>
                    </span>
                  </>
                )}
                {held && (
                  <span className="esplit__tag esplit__tag--l">
                    <Chip tone="ink" size="sm">
                      Original
                    </Chip>
                  </span>
                )}
              </div>
            )}
            {(srcState.quality === 'none' || !session) && !loadError && (
              <div className="editor__loading">
                <Spinner size={22} label="Opening photo" />
              </div>
            )}
            {srcState.loadingFull && srcState.quality === 'preview' && raw && (
              <div className="edev" role="status">
                <Spinner size={16} />
                <span>
                  <strong>Developing RAW at full quality</strong>
                  <span className="edev__sub">You can start adjusting now.</span>
                </span>
              </div>
            )}
            {aiToast && (
              <div className="ai-toast" role="status" aria-live="polite">
                <Icon name="breeze" size={16} className="ai-toast__icon" />
                <span>{aiToast.text}</span>
                {aiToast.undo && (
                  <Button
                    kind="ghost"
                    size="sm"
                    onClick={() => {
                      aiToast.undo?.();
                      setAiToast(null);
                    }}
                  >
                    Undo
                  </Button>
                )}
              </div>
            )}
            {srcState.note && (
              <div className="edev edev--note" role="status">
                <Icon name="info" size={16} />
                <span>{srcState.note}</span>
              </div>
            )}
          </div>
          {!phone && (
            <div className="editor__meta">
              <span className="mono">{info}</span>
              <fieldset className="seg seg--sm">
                <legend className="z-sr">Zoom</legend>
                {(['fit', '100', '200'] as const).map((z) => (
                  <label key={z} className="seg__btn">
                    <input
                      type="radio"
                      className="z-sr"
                      name="zoom"
                      checked={zoom === z}
                      onChange={() => setZoom(z)}
                    />
                    {z === 'fit' ? 'Fit' : `${z}%`}
                  </label>
                ))}
              </fieldset>
            </div>
          )}
          {!phone && items.length > 1 && (
            <nav className="efilm" aria-label="Filmstrip">
              {items.slice(Math.max(0, index - 8), index + 12).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`efilm__item${p.id === photoId ? ' is-current' : ''}`}
                  aria-label={`${p.filename}${p.edit ? ', edited' : ''}`}
                  aria-current={p.id === photoId || undefined}
                  onClick={() => go(items.indexOf(p))}
                >
                  {p.hasThumb ? (
                    <img
                      src={`/api/v1/photos/${encodeURIComponent(p.id)}/thumb${p.edit?.rendered ? `?e=${p.edit.version}` : ''}`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <Icon name="image" size={14} />
                  )}
                  {p.edit && (
                    <span className="efilm__badge" aria-hidden="true">
                      <Icon name="sliders" size={11} />
                    </span>
                  )}
                </button>
              ))}
            </nav>
          )}
        </div>

        {phone ? (
          <section className="ephone" aria-label="Editing tools">
            {session && tool === 'adjust' && <PhoneAdjust edit={edit} />}
            {session && tool === 'crop' && <PhoneCrop edit={edit} actions={cropActions} />}
            {session && tool === 'recipes' && <PhoneRecipes edit={edit} actions={recipeActions} />}
            {session && photo && tool === 'ai' && (
              <div className="ephone__ai">
                <EditorAiPanel photo={photo} session={session} edit={edit} phone onToast={setAiToast} />
              </div>
            )}
            <ToolTabs tool={tool} onChange={setTool} ai={showAi} />
            {session && (
              <span className="ephone__saved">
                <SaveState status={snap.status} error={snap.error} onRetry={() => session.retry()} />
              </span>
            )}
          </section>
        ) : (
          <aside className="epanel" aria-label="Edit panel">
            <div className="epanel__scroll" id="epanel" role="tabpanel" aria-labelledby={`etab-${tool}`}>
              {tool === 'adjust' && (
                <Histogram data={hist} caption={histCaption.map((c) => <span key={c}>{c}</span>)} />
              )}
              <ToolTabs tool={tool} onChange={setTool} ai={showAi} />
              {!session ? (
                <Spinner size={18} label="Loading edit" />
              ) : tool === 'adjust' ? (
                <AdjustPanel edit={edit} />
              ) : tool === 'crop' ? (
                <CropPanel edit={edit} actions={cropActions} />
              ) : tool === 'ai' && photo ? (
                <EditorAiPanel photo={photo} session={session} edit={edit} onToast={setAiToast} />
              ) : (
                <RecipesPanel edit={edit} actions={recipeActions} />
              )}
            </div>
            <div className="epanel__foot">
              {tool === 'crop' ? (
                <>
                  <Button
                    kind="ghost"
                    size="sm"
                    icon="rotate"
                    onClick={() => edit.commit({ ...recipe, crop: undefined })}
                    disabled={!recipe.crop}
                  >
                    Reset crop
                  </Button>
                  <span className="editor__spacer" />
                  <Button kind="primary" size="sm" onClick={() => setTool('adjust')}>
                    Done
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    kind="ghost"
                    size="sm"
                    icon="rotate"
                    onClick={() => session?.revert()}
                    disabled={!session || Object.keys(recipe).length === 1}
                  >
                    Revert to original
                  </Button>
                  <span className="editor__spacer" />
                  <span className="epanel__note">Edits save as you go</span>
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      <PasteDialog
        open={dialog === 'paste'}
        count={1}
        fromName={copied?.fromName ?? ''}
        thumb={copied ? originalThumbUrl(copied.fromId) : null}
        onClose={() => setDialog(null)}
        onPaste={(sections) => pasteSections(sections)}
      />
      <SaveRecipeDialog
        open={dialog === 'save'}
        onClose={() => setDialog(null)}
        onSave={async (n) => {
          const r = await createRecipe({ name: n, recipe: pickSections(recipe, RECIPE_SECTIONS) });
          setSaved((l) => [r, ...(l ?? [])]);
          toast.show(`Saved “${r.name}”`, 'good');
        }}
      />
      <SaveRecipeDialog
        open={dialog === 'rename'}
        title="Rename recipe"
        action="Rename"
        initial={renaming?.name ?? ''}
        onClose={() => setDialog(null)}
        onSave={async (n) => {
          if (!renaming) return;
          const r = await patchRecipe(renaming.id, { name: n });
          setSaved((l) => l?.map((x) => (x.id === r.id ? r : x)) ?? null);
        }}
      />
      <ConflictDialog
        open={snap.status === 'conflict'}
        onTheirs={() => session?.takeTheirs()}
        onMine={() => session?.keepMine()}
      />
      {photo && (
        <ExportDialog
          open={dialog === 'export'}
          photos={[photo]}
          dims={exportDims}
          thumb={thumb}
          subtitle={raw ? 'Rendered on this device from the full-quality RAW.' : undefined}
          onClose={() => setDialog(null)}
          onDownload={(c) => doExport('download', c)}
          onSaveCopy={(c) => doExport('copy', c)}
        />
      )}
    </section>
  );
}

/** The crop overlay, wired to the edit. */
function CropOverlayBound({
  edit,
  t,
  label,
}: {
  edit: Edit;
  t: { width: number; height: number };
  label: string;
}) {
  const crop = edit.recipe.crop;
  const aspect = crop?.aspect === 'free' ? null : aspectFor(crop?.aspect ?? 'original', t);
  return (
    <CropOverlay
      rect={crop?.rect ?? FULL}
      aspect={aspect}
      t={t}
      label={label}
      onChange={(rect) => edit.preview({ ...edit.recipe, crop: { ...(crop ?? {}), rect } })}
      onCommit={() => edit.commit()}
    />
  );
}

const noopSub = () => () => {};
const EMPTY_SNAP = {
  recipe: EMPTY_RECIPE,
  canUndo: false,
  canRedo: false,
  status: 'saved' as const,
  error: null,
  conflict: null,
  version: null,
};
const emptySnap = () => EMPTY_SNAP;
