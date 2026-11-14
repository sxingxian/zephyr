import { type PhotoListQuery, TRASH_DAYS } from '@zephyr/shared/client';
import { Button, Dialog, Icon, Note, useToast } from '@zephyr/ui';
import { useEffect, useMemo, useState } from 'react';
import { type BarAction, SelectionBar } from '../components/LibraryBits';
import { PhotoGrid } from '../components/PhotoGrid';
import { Shell } from '../components/Shell';
import { errorMessage } from '../lib/api';
import { emitLibrary } from '../lib/bus';
import { allPhotoIds, bulk, emptyTrash } from '../lib/library';
import { useCan } from '../lib/libraryContext';
import { usePhotoList } from '../lib/photos';
import { useSelection } from '../lib/selection';
import { formatBytes, refreshUsage, useUsage } from '../lib/usage';
import { EmptyHint, GridSkeleton } from './Library';

type Confirm = { kind: 'forever'; ids: string[] } | { kind: 'empty' } | null;

/** Trash: photos stay for 30 days and still count towards storage. */
export function TrashPage() {
  const toast = useToast();
  const usage = useUsage();
  const query = useMemo<PhotoListQuery>(() => ({ view: 'trash', sort: 'added' }), []);
  const list = usePhotoList(query);
  const sel = useSelection(true);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = [...sel.selected];
  const n = (k: number) => `${k.toLocaleString('en')} photo${k === 1 ? '' : 's'}`;

  const { prune } = sel;
  useEffect(() => {
    const have = new Set(list.items.map((p) => p.id));
    prune((id) => have.has(id));
  }, [list.items, prune]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const restore = (which: string[]) =>
    run('restore', async () => {
      await bulk(which, 'restore');
      list.remove(which);
      sel.clear();
      toast.show(`Restored ${n(which.length)} to your library`, 'good');
      void refreshUsage();
    });
  const restoreAll = () =>
    run('restoreAll', async () => {
      const all = await allPhotoIds({ view: 'trash' });
      if (!all.length) return;
      await bulk(all, 'restore');
      list.remove(all);
      sel.clear();
      toast.show(`Restored ${n(all.length)} to your library`, 'good');
      void refreshUsage();
    });
  const deleteForever = () => {
    if (confirm?.kind !== 'forever') return;
    const which = confirm.ids;
    return run('forever', async () => {
      await bulk(which, 'delete_forever');
      list.remove(which);
      emitLibrary({ type: 'removed', ids: which });
      sel.clear();
      setConfirm(null);
      toast.show(`Deleted ${n(which.length)} for good`, 'good');
      void refreshUsage();
    });
  };
  const empty = () =>
    run('empty', async () => {
      const deleted = await emptyTrash();
      list.reload();
      sel.clear();
      setConfirm(null);
      toast.show(`Trash emptied · ${n(deleted)} deleted for good`, 'good');
      void refreshUsage();
    });

  // Phase 7: editors restore; only the library's owner deletes for good.
  const canRestore = useCan('trash');
  const canPurge = useCan('purge');
  const actions: BarAction[] = [
    ...(canRestore
      ? [{ icon: 'undo' as const, label: 'Restore', onClick: () => restore(ids), busy: busy === 'restore' }]
      : []),
    ...(canPurge
      ? [
          {
            icon: 'trash' as const,
            label: 'Delete forever',
            onClick: () => setConfirm({ kind: 'forever', ids }),
            danger: true,
          },
        ]
      : []),
  ];
  const count = list.hasMore ? null : list.items.length;
  const stats = [
    count !== null ? n(count) : null,
    usage && usage.trashBytes > 0 ? formatBytes(usage.trashBytes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const hasItems = list.items.length > 0;

  return (
    <Shell title="Trash">
      <div className="trash-banner">
        <span className="trash-banner__icon">
          <Icon name="trash" size={19} />
        </span>
        <div className="trash-banner__text">
          <strong>Photos in Trash are deleted for good after {TRASH_DAYS} days</strong>
          <span>They still count towards your storage until then.{stats ? ` ${stats}` : ''}</span>
        </div>
        <div className="trash-banner__actions">
          {canRestore && (
            <Button
              size="sm"
              icon="undo"
              onClick={restoreAll}
              busy={busy === 'restoreAll'}
              disabled={!hasItems || busy !== null}
            >
              Restore all
            </Button>
          )}
          {canPurge && (
            <Button
              size="sm"
              kind="danger"
              icon="trash"
              onClick={() => setConfirm({ kind: 'empty' })}
              disabled={!hasItems || busy !== null}
            >
              Empty Trash
            </Button>
          )}
        </div>
      </div>
      {sel.count > 0 && actions.length > 0 && (
        <SelectionBar count={sel.count} actions={actions} onClear={sel.clear} />
      )}
      {list.error && (
        <Note tone="bad" icon="alert" role="alert">
          {list.error}
        </Note>
      )}
      {list.initial ? (
        <GridSkeleton />
      ) : !hasItems ? (
        <EmptyHint title="Trash is empty">
          Photos you move to Trash stay here for {TRASH_DAYS} days.
        </EmptyHint>
      ) : (
        <PhotoGrid
          items={list.items}
          sort="added"
          grouped={false}
          trash
          hasMore={list.hasMore}
          loading={list.loading}
          loadMore={list.loadMore}
          selection={sel}
          label="Photos in Trash"
        />
      )}
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === 'empty'
            ? 'Empty Trash?'
            : `Delete ${n(confirm?.kind === 'forever' ? confirm.ids.length : 0)} for good?`
        }
        footer={
          <>
            <Button kind="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              kind="danger"
              icon="trash"
              busy={busy === 'forever' || busy === 'empty'}
              onClick={confirm?.kind === 'empty' ? empty : deleteForever}
            >
              {confirm?.kind === 'empty' ? 'Empty Trash' : 'Delete forever'}
            </Button>
          </>
        }
      >
        <p>
          {confirm?.kind === 'empty'
            ? 'Everything in Trash is deleted for good, including the originals. This can’t be undone.'
            : 'The originals and their previews are deleted for good. This can’t be undone.'}
        </p>
      </Dialog>
    </Shell>
  );
}
