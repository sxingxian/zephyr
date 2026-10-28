import { type EditSection, EMPTY_RECIPE, type PhotoItem, RECIPE_SECTIONS } from '@zephyr/shared/client';
import { useToast } from '@zephyr/ui';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { applyToPhotos, skippedNote } from '../../lib/editor/batch';
import { copyEdits, useCopied } from '../../lib/editor/clipboard';
import { startExportJob } from '../../lib/editor/exportJob';
import { cleanExportName, ExportProblem, exportName } from '../../lib/editor/names';
import { pickZipSink } from '../../lib/editor/zipSink';
import { getEdit, originalThumbUrl } from '../../lib/edits';
import type { PhotoList } from '../../lib/photos';
import type { Selection } from '../../lib/selection';
import { uploads } from '../../lib/uploads';
import { useUsage } from '../../lib/usage';
import type { BarAction } from '../LibraryBits';
import { ApplyRecipeDialog, type ExportChoice, ExportDialog, PasteDialog } from './Dialogs';

const PLAN = { free: 'Free', pro: 'Pro', studio: 'Studio' } as const;
const n = (k: number) => `${k} photo${k === 1 ? '' : 's'}`;
const withSkipped = (msg: string, skipped: number) => {
  const note = skippedNote(skipped);
  return note ? `${msg} · ${note}` : msg;
};

/** Selection-bar actions for editing: copy, paste, apply a recipe, revert, export. */
export function useEditActions(list: PhotoList, sel: Selection) {
  const toast = useToast();
  const usage = useUsage();
  const copied = useCopied();
  const [dialog, setDialog] = useState<null | 'paste' | 'apply' | 'export'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const byId = useMemo(() => new Map(list.items.map((p) => [p.id, p])), [list.items]);
  const photos = [...sel.selected].map((id) => byId.get(id)).filter(Boolean) as PhotoItem[];
  const edited = photos.filter((p) => p.edit);
  const tooMany = usage ? photos.length > usage.batchSize : false;
  const capHint = usage ? `Up to ${usage.batchSize} photos at a time on ${PLAN[usage.plan]}` : undefined;

  const copy = async () => {
    const p = photos[0];
    if (!p) return;
    setBusy('copy');
    try {
      const e = p.edit ? await getEdit(p.id) : null;
      copyEdits(e?.recipe ?? EMPTY_RECIPE, p.id, p.filename);
      toast.show(
        e ? `Copied edits from ${p.filename}` : `${p.filename} has no edits to copy`,
        e ? 'good' : 'bad',
      );
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const revert = async () => {
    setBusy('revert');
    try {
      const k = await applyToPhotos(edited, null, [], `Reverting ${n(edited.length)}`);
      toast.show(withSkipped(`Reverted ${n(k.affected)} to their originals`, k.skipped), 'good');
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  };

  const actions: BarAction[] = [
    {
      icon: 'copy',
      label: 'Copy edits',
      onClick: copy,
      busy: busy === 'copy',
      disabled: photos.length !== 1,
      hint: 'Select one photo to copy its edits',
    },
    {
      icon: 'paste',
      label: 'Paste edits',
      onClick: () => setDialog('paste'),
      disabled: !copied || tooMany,
      hint: !copied ? 'Copy edits from a photo first' : capHint,
    },
    {
      icon: 'layers',
      label: 'Apply recipe',
      onClick: () => setDialog('apply'),
      disabled: tooMany,
      hint: capHint,
    },
    {
      icon: 'download',
      label: 'Export',
      onClick: () => setDialog('export'),
      disabled: tooMany,
      hint: capHint,
    },
    {
      icon: 'rotate',
      label: 'Revert',
      onClick: revert,
      busy: busy === 'revert',
      disabled: !edited.length || tooMany,
      hint: !edited.length ? 'None of these photos are edited' : capHint,
    },
  ];

  const exportRun = async (
    kind: 'download' | 'copy',
    c: ExportChoice,
    progress: (d: number, t: number) => void,
  ) => {
    // Several photos download as one .zip. Where the browser can, ask where to save it first (the picker
    // needs this click), so the zip streams to disk instead of being held in memory.
    const zipName = `zephyr-export-${photos.length}.zip`;
    const sink = kind === 'download' && photos.length > 1 ? await pickZipSink(zipName) : null;
    // Belongs to the member who started it: stops if their session ends; results only go to them.
    let job: ReturnType<typeof startExportJob>;
    try {
      job = startExportJob();
    } catch (err) {
      // Nobody is signed in any more: don't leave an empty file behind in the folder they picked.
      await sink?.abort().catch(() => {});
      throw err;
    }
    try {
      const { exportZip, renderExport, saveBlob } = await import('../../lib/editor/exporter');
      const o = { size: c.size, quality: c.quality, signal: job.signal };
      if (kind === 'download') {
        if (photos.length === 1) {
          const p = photos[0] as PhotoItem;
          const blob = await renderExport(p, null, o);
          job.check();
          await saveBlob(blob, cleanExportName(c.name, p.filename));
        } else {
          const zip = await exportZip(photos, { ...o, onProgress: progress }, sink);
          job.check();
          if (zip) await saveBlob(zip, zipName);
        }
      } else {
        for (let i = 0; i < photos.length; i++) {
          const p = photos[i] as PhotoItem;
          const blob = await renderExport(p, null, o);
          job.check();
          const name = photos.length === 1 ? cleanExportName(c.name, p.filename) : exportName(p.filename);
          const res = await uploads.add(
            [new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })],
            {
              expectedOwner: job.owner,
            },
          );
          if (res !== 'queued') throw new ExportProblem('You were signed out, so the copies weren’t saved.');
          progress(i + 1, photos.length);
        }
        toast.show(
          `Saving ${photos.length === 1 ? 'a copy' : `${photos.length} copies`} to your library`,
          'good',
        );
      }
    } catch (e) {
      if (sink && (e as Error).name !== 'AbortError') await sink.abort().catch(() => undefined);
      throw e;
    } finally {
      job.finish();
    }
  };

  const first = photos[0];
  const dialogs = (
    <>
      <PasteDialog
        open={dialog === 'paste'}
        count={photos.length}
        fromName={copied?.fromName ?? ''}
        thumb={copied ? originalThumbUrl(copied.fromId) : null}
        onClose={() => setDialog(null)}
        onPaste={async (sections: EditSection[]) => {
          if (!copied) return;
          const k = await applyToPhotos(
            photos,
            copied.recipe,
            sections,
            `Pasting edits to ${n(photos.length)}`,
          );
          toast.show(withSkipped(`Pasted edits to ${n(k.affected)}`, k.skipped), 'good');
        }}
      />
      <ApplyRecipeDialog
        open={dialog === 'apply'}
        count={photos.length}
        onClose={() => setDialog(null)}
        onApply={async (r, name) => {
          const k = await applyToPhotos(photos, r, [...RECIPE_SECTIONS], `Applying “${name}”`);
          toast.show(withSkipped(`Applied “${name}” to ${n(k.affected)}`, k.skipped), 'good');
        }}
      />
      <ExportDialog
        open={dialog === 'export'}
        photos={photos}
        dims={
          first?.width && first.height && photos.length === 1
            ? { width: first.width, height: first.height }
            : null
        }
        thumb={first?.hasThumb ? originalThumbUrl(first.id) : null}
        onClose={() => setDialog(null)}
        onDownload={(c, p) => exportRun('download', c, p)}
        onSaveCopy={(c, p) => exportRun('copy', c, p)}
      />
    </>
  );
  return { actions, dialogs };
}
