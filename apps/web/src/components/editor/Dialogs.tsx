import {
  BUILT_IN_RECIPES,
  DEFAULT_PASTE_SECTIONS,
  EDIT_SECTIONS,
  type EditRecipe,
  type EditSection,
  type PhotoItem,
  RECIPE_NAME_MAX,
  type SavedRecipe,
} from '@zephyr/shared/client';
import { Button, Dialog, Field, Icon, Note } from '@zephyr/ui';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiFailure, errorMessage } from '../../lib/api';
import { SECTION_HINTS, SECTION_LABELS } from '../../lib/editor/controls';
import type { ExportSize } from '../../lib/editor/exporter';
import { ExportProblem, estimateJpegBytes, exportName, zipTooBig } from '../../lib/editor/names';
import { listRecipes } from '../../lib/edits';
import { formatBytes, formatOf, useUsage } from '../../lib/usage';

const PLAN = { free: 'Free', pro: 'Pro', studio: 'Studio' } as const;

/** Paste: which sections of the copied edit replace each photo's. Crop is off by default. */
export function PasteDialog({
  open,
  count,
  fromName,
  thumb,
  onClose,
  onPaste,
}: {
  open: boolean;
  count: number;
  fromName: string;
  thumb?: string | null;
  onClose: () => void;
  onPaste: (sections: EditSection[]) => Promise<void> | void;
}) {
  const usage = useUsage();
  const [sections, setSections] = useState<EditSection[]>([...DEFAULT_PASTE_SECTIONS]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setSections([...DEFAULT_PASTE_SECTIONS]);
      setError(null);
    }
  }, [open]);
  const over = usage ? count > usage.batchSize : false;
  const n = `${count} photo${count === 1 ? '' : 's'}`;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPaste(sections);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiFailure && e.code === 'too_large' && usage
          ? `Up to ${usage.batchSize} photos at a time on ${PLAN[usage.plan]}.`
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="edlg-title">
          {thumb && <img className="edlg-title__thumb" src={thumb} alt="" />}
          <span>
            Paste edits to {n}
            <span className="edlg-title__sub">Copied from {fromName}</span>
          </span>
        </span>
      }
      footer={
        <>
          {usage && (
            <span className="edlg-foot__note">
              Up to {usage.batchSize} photos at a time on {PLAN[usage.plan]}
            </span>
          )}
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon="paste" busy={busy} disabled={!sections.length || over} onClick={go}>
            Paste to {n}
          </Button>
        </>
      }
    >
      <fieldset className="echecks">
        <legend>Paste these settings</legend>
        {EDIT_SECTIONS.map((s) => (
          <label key={s} className="echecks__row">
            <input
              type="checkbox"
              checked={sections.includes(s)}
              onChange={(e) =>
                setSections(e.target.checked ? [...sections, s] : sections.filter((x) => x !== s))
              }
            />
            <span>
              <span className="echecks__name">{SECTION_LABELS[s]}</span>
              <span className="echecks__hint">{SECTION_HINTS[s]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="edlg-note">
        Ticked settings replace the same settings on each photo; everything else stays. Undo from the tray if
        you change your mind.
      </p>
      {over && usage && (
        <Note tone="warn" icon="alert">
          Select up to {usage.batchSize} photos at a time on {PLAN[usage.plan]}.
        </Note>
      )}
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
    </Dialog>
  );
}

/** Save the current light/colour/detail as a recipe. */
export function SaveRecipeDialog({
  open,
  initial = '',
  title = 'Save as a recipe',
  action = 'Save recipe',
  onClose,
  onSave,
}: {
  open: boolean;
  initial?: string;
  title?: string;
  action?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) {
      setError('Give the recipe a name.');
      return;
    }
    setBusy(true);
    try {
      await onSave(n);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiFailure && err.code === 'quota_exceeded'
          ? 'You have 200 recipes, the most you can keep. Delete one to save another.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };
  const formId = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" form={formId} busy={busy}>
            {action}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="stack">
        <Field
          label="Name"
          value={name}
          maxLength={RECIPE_NAME_MAX}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
          hint="Recipes keep light, colour, the colour mixer, detail and effects. Never the crop."
        />
      </form>
    </Dialog>
  );
}

/** Another tab saved a newer edit of this photo. */
export function ConflictDialog({
  open,
  onTheirs,
  onMine,
}: {
  open: boolean;
  onTheirs: () => void;
  onMine: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onTheirs}
      title="This photo was edited somewhere else"
      footer={
        <>
          <Button kind="ghost" onClick={onMine}>
            Keep mine
          </Button>
          <Button kind="primary" onClick={onTheirs}>
            Load the newer edit
          </Button>
        </>
      }
    >
      <p className="edlg-note">
        A newer edit was saved from another tab or device. Load it, or keep the edit on this screen and save
        over it. Either way you can undo.
      </p>
    </Dialog>
  );
}

export interface ExportChoice {
  size: ExportSize;
  quality: number;
  name: string;
}

/** Export one photo or several: size, JPEG quality, then Download or Save as copy. */
export function ExportDialog({
  open,
  photos,
  dims,
  thumb,
  subtitle,
  onClose,
  onDownload,
  onSaveCopy,
}: {
  open: boolean;
  photos: Pick<PhotoItem, 'filename' | 'fileType'>[];
  /** Output size of the single photo at full size, when known. */
  dims?: { width: number; height: number } | null;
  thumb?: string | null;
  subtitle?: string;
  onClose: () => void;
  onDownload: (c: ExportChoice, progress: (done: number, total: number) => void) => Promise<void>;
  onSaveCopy: (c: ExportChoice, progress: (done: number, total: number) => void) => Promise<void>;
}) {
  const usage = useUsage();
  const batch = photos.length > 1;
  const first = photos[0];
  const [size, setSize] = useState<'full' | '2048' | 'custom'>('full');
  const [custom, setCustom] = useState('3000');
  const [quality, setQuality] = useState(90);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<null | 'download' | 'copy'>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(first ? exportName(first.filename) : 'photo-edited.jpg');
      setError(null);
      setProgress(null);
    }
  }, [open, first]);
  const choice = (): ExportChoice => ({
    size:
      size === 'full'
        ? { kind: 'full' }
        : {
            kind: 'long',
            edge: size === '2048' ? 2048 : Math.min(16000, Math.max(256, Number(custom) || 3000)),
          },
    quality: quality / 100,
    name: name.trim() || 'photo-edited.jpg',
  });
  const pixels = (() => {
    const d = dims ?? { width: 6000, height: 4000 };
    if (size === 'full') return d.width * d.height;
    const edge = size === '2048' ? 2048 : Number(custom) || 3000;
    const k = Math.min(1, edge / Math.max(d.width, d.height));
    return d.width * d.height * k * k;
  })();
  const each = estimateJpegBytes(pixels, quality / 100);
  const total = each * photos.length;
  // A .zip that can't stream to disk is held in memory: too big a one would crash the tab.
  const streams = typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
  const zipWarn = batch && !streams ? zipTooBig(total, photos.length, size === 'full') : null;
  const run = async (kind: 'download' | 'copy') => {
    setBusy(kind);
    setError(null);
    setProgress(batch ? [0, photos.length] : null);
    try {
      const fn = kind === 'download' ? onDownload : onSaveCopy;
      await fn(choice(), (d, t) => setProgress([d, t]));
      onClose();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof ExportProblem ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const qualityLabel = quality >= 90 ? 'High' : quality >= 75 ? 'Good' : 'Small';
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={
        <span className="edlg-title">
          {thumb && <img className={`edlg-title__thumb${batch ? ' is-stack' : ''}`} src={thumb} alt="" />}
          <span>
            {batch
              ? `Export ${photos.length} photos`
              : `Export ${first?.filename.replace(/\.[^.]+$/, '') ?? ''}`}
            <span className="edlg-title__sub">
              {subtitle ??
                (batch
                  ? 'Edited versions, rendered on this device. Originals stay as they are.'
                  : 'Rendered on this device from the original.')}
            </span>
          </span>
        </span>
      }
      footer={
        <>
          <span className="edlg-foot__copy">
            <Button
              size="sm"
              icon="library"
              busy={busy === 'copy'}
              disabled={Boolean(busy)}
              onClick={() => run('copy')}
            >
              {batch ? `Save ${photos.length} copies to library` : 'Save as copy in library'}
            </Button>
            <span className="edlg-foot__note">
              Adds about {formatBytes(total)}
              {usage ? ` · ${formatOf(usage.usedBytes + usage.reservedBytes, usage.limitBytes)} used` : ''}
            </span>
          </span>
          <Button
            kind="primary"
            icon="download"
            busy={busy === 'download'}
            disabled={Boolean(busy) || Boolean(zipWarn)}
            title={zipWarn ?? undefined}
            onClick={() => run('download')}
          >
            {batch ? 'Download .zip' : 'Download'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <fieldset className="esize">
          <legend>Size</legend>
          {(
            [
              [
                'full',
                'Full size',
                batch
                  ? 'Each photo’s own size'
                  : dims
                    ? `${dims.width} × ${dims.height}`
                    : 'Original resolution',
              ],
              ['2048', 'Long edge 2048', 'For web and social'],
              ['custom', 'Custom', 'Pick the long edge'],
            ] as const
          ).map(([v, a, b]) => (
            <label key={v} className="esize__opt">
              <span className="esize__title">
                <input type="radio" name="export-size" checked={size === v} onChange={() => setSize(v)} />
                {a}
              </span>
              <span className="esize__hint">{b}</span>
            </label>
          ))}
        </fieldset>
        {size === 'custom' && (
          <Field
            label="Long edge (pixels)"
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        )}
        <div
          className="eslider is-changed esq"
          style={
            {
              '--pos': `${((quality - 50) / 50) * 100}%`,
              '--fl': '0%',
              '--fw': `${((quality - 50) / 50) * 100}%`,
            } as React.CSSProperties
          }
        >
          <div className="eslider__head">
            <label htmlFor="export-quality">JPEG quality</label>
            <output htmlFor="export-quality">
              {quality} · {qualityLabel}
            </output>
          </div>
          <div className="eslider__rail">
            <span className="eslider__track" aria-hidden="true" />
            <span className="eslider__fill" aria-hidden="true" />
            <input
              id="export-quality"
              type="range"
              min={50}
              max={100}
              step={1}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </div>
          <span className="esec__hint">
            About {formatBytes(total)}
            {batch ? ' in total' : ''} · sRGB colour, so it looks right everywhere
          </span>
        </div>
        {batch ? (
          <div className="ezipnote">
            <span>
              <Icon name="file" size={16} />
              Downloads as one .zip file
            </span>
            <span className="mono">zephyr-export-{photos.length}.zip</span>
          </div>
        ) : (
          <Field
            label="File name"
            value={name}
            maxLength={140}
            onChange={(e) => setName(e.target.value)}
            mono
          />
        )}
        {zipWarn && (
          <p className="ewarn" role="status">
            <Icon name="alert" size={16} />
            <span>{zipWarn}</span>
          </p>
        )}
        <p className="eprivacy">
          <Icon name="shieldCheck" size={16} />
          <span>Exported files carry no location, camera serial number or other hidden details.</span>
        </p>
        {progress && (
          <div
            className="eprog"
            role="progressbar"
            aria-label="Exporting"
            aria-valuenow={progress[0]}
            aria-valuemin={0}
            aria-valuemax={progress[1]}
          >
            <span style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
          </div>
        )}
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

/** Pick a recipe (yours or Zephyr's) to apply to a selection. */
export function ApplyRecipeDialog({
  open,
  count,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onApply: (recipe: EditRecipe, name: string) => Promise<void>;
}) {
  const usage = useUsage();
  const [saved, setSaved] = useState<SavedRecipe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    listRecipes()
      .then(setSaved)
      .catch((e) => setError(errorMessage(e)));
  }, [open]);
  const over = usage ? count > usage.batchSize : false;
  const apply = async (id: string, r: EditRecipe, name: string) => {
    setBusy(id);
    setError(null);
    try {
      await onApply(r, name);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiFailure && e.code === 'too_large' && usage
          ? `Up to ${usage.batchSize} photos at a time on ${PLAN[usage.plan]}.`
          : errorMessage(e),
      );
    } finally {
      setBusy(null);
    }
  };
  const all = [
    ...(saved ?? []).map((s) => ({ id: s.id, name: s.name, recipe: s.recipe, mine: true })),
    ...BUILT_IN_RECIPES.map((b) => ({ ...b, mine: false })),
  ];
  return (
    <Dialog open={open} onClose={onClose} title={`Apply a recipe to ${count} photo${count === 1 ? '' : 's'}`}>
      <ul className="eapply">
        {all.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="eapply__item"
              disabled={Boolean(busy) || over}
              onClick={() => apply(r.id, r.recipe, r.name)}
            >
              <span className="eapply__name">{r.name}</span>
              <span className="eapply__sub">{r.mine ? 'Your recipe' : 'Zephyr recipe'}</span>
              {busy === r.id ? (
                <span className="eapply__busy">Applying…</span>
              ) : (
                <Icon name="chevR" size={16} />
              )}
            </button>
          </li>
        ))}
      </ul>
      <p className="edlg-note">
        A recipe sets light, colour and detail on each photo. It never changes the crop. You can undo from the
        tray.
      </p>
      {over && usage && (
        <Note tone="warn" icon="alert">
          Select up to {usage.batchSize} photos at a time on {PLAN[usage.plan]}.
        </Note>
      )}
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
    </Dialog>
  );
}
