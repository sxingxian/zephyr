import { type EditSection, EMPTY_RECIPE, type PhotoItem, RECIPE_SECTIONS } from '@zephyr/shared/client';
import { useToast } from '@zephyr/ui';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { applyToPhotos } from '../../lib/editor/batch';
import { copyEdits, useCopied } from '../../lib/editor/clipboard';
import { getEdit, originalThumbUrl } from '../../lib/edits';
import type { PhotoList } from '../../lib/photos';
import type { Selection } from '../../lib/selection';
import { uploads } from '../../lib/uploads';
import { useUsage } from '../../lib/usage';
import type { BarAction } from '../LibraryBits';
import { ApplyRecipeDialog, type ExportChoice, ExportDialog, PasteDialog } from './Dialogs';

const PLAN = { free: 'Free', pro: 'Pro', studio: 'Studio' } as const;
const n = (k: number) => `${k} photo${k === 1 ? '' : 's'}`;

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
      toast.show(`Reverted ${n(k)} to their originals`, 'good');
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
    const { exportZip, renderExport, saveBlob, exportName } = await import('../../lib/editor/exporter');
    if (kind === 'download') {
      if (photos.length === 1) {
        const p = photos[0] as PhotoItem;
        await saveBlob(
          await renderExport(p, null, { size: c.size, quality: c.quality }),
          c.name || exportName(p.filename),
        );
      } else {
        const zip = await exportZip(photos, { size: c.size, quality: c.quality, onProgress: progress });
        await saveBlob(zip, `zephyr-export-${photos.length}.zip`);
      }
    } else {
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i] as PhotoItem;
        const blob = await renderExport(p, null, { size: c.size, quality: c.quality });
        const name = photos.length === 1 ? c.name || exportName(p.filename) : exportName(p.filename);
        await uploads.add([new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })]);
        progress(i + 1, photos.length);
      }
      toast.show(
        `Saving ${photos.length === 1 ? 'a copy' : `${photos.length} copies`} to your library`,
        'good',
      );
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
          toast.show(`Pasted edits to ${n(k)}`, 'good');
        }}
      />
      <ApplyRecipeDialog
        open={dialog === 'apply'}
        count={photos.length}
        onClose={() => setDialog(null)}
        onApply={async (r, name) => {
          const k = await applyToPhotos(photos, r, [...RECIPE_SECTIONS], `Applying “${name}”`);
          toast.show(`Applied “${name}” to ${n(k)}`, 'good');
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
