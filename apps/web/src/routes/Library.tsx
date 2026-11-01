import type { PhotoItem, PhotoListQuery } from '@zephyr/shared/client';
import { Button, Mascot, Note, useToast } from '@zephyr/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AlbumPicker } from '../components/AlbumPicker';
import { useAiBatch } from '../components/ai/useAiBatch';
import { useEditActions } from '../components/editor/LibraryEdit';
import {
  type BarAction,
  SearchBox,
  Segmented,
  SelectionBar,
  SortSelect,
  useDebounced,
  useShareWithViewer,
  useViewerHost,
} from '../components/LibraryBits';
import { PhotoGrid } from '../components/PhotoGrid';
import { Shell } from '../components/Shell';
import { useShareGallery } from '../components/share/ShareDialogs';
import { useUploadPicker } from '../components/Uploads';
import { errorMessage } from '../lib/api';
import { emitLibrary } from '../lib/bus';
import { renderQueue } from '../lib/editor/queue';
import { bulk } from '../lib/library';
import { type PhotoList, usePhotoList } from '../lib/photos';
import { type Selection, useSelection } from '../lib/selection';
import { useSession } from '../lib/session';
import { refreshUsage, uploadRulesLine, useUsage } from '../lib/usage';

type Filter = 'library' | 'favourites' | 'raw' | 'edited';
type Sort = NonNullable<PhotoListQuery['sort']>;
const SORTS: { value: Sort; label: string }[] = [
  { value: 'taken', label: 'Date taken' },
  { value: 'added', label: 'Date added' },
];
export const SOON = 'Coming soon';

/** Edit, Zephyr AI, Share, Favourite, Add to album, Move to Trash. */
export function useLibraryActions(list: PhotoList, sel: Selection, extra: BarAction[] = []) {
  const toast = useToast();
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const byId = useMemo(() => new Map(list.items.map((p) => [p.id, p])), [list.items]);
  const ids = [...sel.selected];
  const allFav = ids.length > 0 && ids.every((id) => byId.get(id)?.favourite);
  const n = (k: number) => `${k} photo${k === 1 ? '' : 's'}`;

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
  const favourite = () =>
    run('fav', async () => {
      await bulk(ids, allFav ? 'unfavourite' : 'favourite');
      emitLibrary({ type: 'updated', photos: ids.map((id) => ({ id, favourite: !allFav })) });
      toast.show(
        allFav ? `Removed ${n(ids.length)} from Favourites` : `Added ${n(ids.length)} to Favourites`,
        'good',
      );
    });
  const trash = () =>
    run('trash', async () => {
      await bulk(ids, 'trash');
      emitLibrary({ type: 'removed', ids });
      sel.clear();
      void refreshUsage();
      toast.show(`Moved ${n(ids.length)} to Trash. You can restore them for 30 days.`, 'good');
    });

  const editing = useEditActions(list, sel);
  const sharing = useShareGallery();
  const ai = useAiBatch();
  const actions: BarAction[] = [
    ...editing.actions,
    ...(ai.available ? [{ icon: 'breeze' as const, label: 'Zephyr AI', onClick: () => ai.open(ids) }] : []),
    { icon: 'folder', label: 'Add to album', onClick: () => setPicker(true) },
    { icon: 'heart', label: allFav ? 'Unfavourite' : 'Favourite', onClick: favourite, busy: busy === 'fav' },
    { icon: 'share', label: 'Share', onClick: () => sharing.open(ids) },
    ...extra,
    { icon: 'trash', label: 'Move to Trash', onClick: trash, busy: busy === 'trash', danger: true },
  ];
  const pickerEl = (
    <>
      <AlbumPicker open={picker} photoIds={ids} onClose={() => setPicker(false)} onDone={() => sel.clear()} />
      {editing.dialogs}
      {sharing.dialogs}
      {ai.dialog}
    </>
  );
  return { actions, pickerEl };
}

/** Skeleton tiles while the first page loads. */
export function GridSkeleton() {
  return (
    <div className="pgrid-skel" aria-hidden="true">
      <span className="pgrid-skel__head" />
      <div className="pgrid-skel__tiles">
        {Array.from({ length: 12 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

export function EmptyHint({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="hint-empty">
      {icon}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

function Welcome() {
  const { user } = useSession();
  const usage = useUsage();
  const pick = useUploadPicker();
  const first = user?.displayName?.split(' ')[0];
  return (
    <section className="empty" aria-labelledby="empty-title">
      <Mascot
        pose="nap"
        width={230}
        tile={{ background: 'var(--m-dusk)', height: 250 }}
        className="empty__art"
      />
      {first && <p className="z-eyebrow">Welcome, {first}</p>}
      <h2 id="empty-title" className="empty__title">
        Your library is ready for its first shoot
      </h2>
      <p className="empty__text">
        Drop photos anywhere on this page or choose them from your device. Every edit will be a recipe on top,
        so your originals stay exactly as they were.
      </p>
      <div className="empty__actions">
        <Button kind="primary" size="lg" icon="upload" onClick={pick}>
          Upload photos
        </Button>
      </div>
      <span className="z-hint">{uploadRulesLine(usage)}</span>
    </section>
  );
}

/** The library grid ("/") and the Favourites view ("/favourites"). */
export function LibraryPage({ view }: { view: 'library' | 'favourites' }) {
  const nav = useNavigate();
  const loc = useLocation();
  const usage = useUsage();
  const { returnId } = useViewerHost();
  const [filter, setFilter] = useState<Filter>(view);
  const [sort, setSort] = useState<Sort>('taken');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const query = useMemo<PhotoListQuery>(
    () => ({ view: view === 'favourites' ? 'favourites' : filter, sort, q: q || undefined }),
    [view, filter, sort, q],
  );
  const list = usePhotoList(query);
  const sel = useSelection();
  const { actions, pickerEl } = useLibraryActions(list, sel);
  const title = view === 'favourites' ? 'Favourites' : 'Library';
  const plain = view === 'library' && filter === 'library' && !q;

  useShareWithViewer({
    items: list.items,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    backLabel: title,
    total: plain && usage ? usage.photoCount : undefined,
  });
  const { prune } = sel;
  // Edits whose thumbnails were never rendered (a tab closed mid-batch): render them now.
  useEffect(() => {
    renderQueue.resume(list.items);
  }, [list.items]);
  useEffect(() => {
    const have = new Set(list.items.map((p: PhotoItem) => p.id));
    prune((id) => have.has(id));
  }, [list.items, prune]);

  const open = useCallback(
    (i: number) => {
      const p = list.items[i];
      if (p) nav(`/photo/${encodeURIComponent(p.id)}`, { state: { bg: loc.pathname } });
    },
    [list.items, nav, loc.pathname],
  );

  const empty = !list.initial && !list.error && list.items.length === 0;
  let body: ReactNode;
  if (list.initial) body = <GridSkeleton />;
  else if (empty && plain) body = <Welcome />;
  else if (empty)
    body = q ? (
      <EmptyHint title={`Nothing matches “${q}”`}>Search looks at file names and camera models.</EmptyHint>
    ) : query.view === 'edited' ? (
      <EmptyHint title="No edited photos yet">
        Photos you edit appear here. Originals always stay as they were.
      </EmptyHint>
    ) : query.view === 'favourites' ? (
      <EmptyHint title="No favourites yet">Tap the heart on a photo to keep it here.</EmptyHint>
    ) : (
      <EmptyHint title="No RAW photos yet">RAW files (CR2, NEF, ARW) you upload appear here.</EmptyHint>
    );
  else
    body = (
      <PhotoGrid
        items={list.items}
        sort={sort}
        hasMore={list.hasMore}
        loading={list.loading}
        loadMore={list.loadMore}
        selection={sel}
        onOpen={open}
        focusId={returnId}
        label={`${title} photos`}
      />
    );

  return (
    <Shell title={title} search={<SearchBox value={search} onChange={setSearch} />}>
      <div className="lib-toolbar">
        {view === 'library' && (
          <Segmented
            label="Filter library"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'library', label: 'All photos' },
              { value: 'favourites', label: 'Favourites' },
              { value: 'edited', label: 'Edited' },
              { value: 'raw', label: 'RAW' },
            ]}
          />
        )}
        <span className="lib-toolbar__spacer" />
        <SortSelect value={sort} onChange={setSort} options={SORTS} />
        {list.items.length > 0 && (
          <Button
            size="sm"
            kind={sel.selecting ? 'primary' : 'secondary'}
            icon={sel.selecting ? undefined : 'check'}
            onClick={() => sel.setSelecting(!sel.selecting)}
          >
            {sel.selecting ? 'Done' : 'Select'}
          </Button>
        )}
      </div>
      {sel.selecting && <SelectionBar count={sel.count} actions={actions} onClear={sel.clear} />}
      {list.error && (
        <Note tone="bad" icon="alert" role="alert">
          {list.error}{' '}
          <button type="button" className="text-link" onClick={list.reload}>
            Try again
          </button>
        </Note>
      )}
      {body}
      {pickerEl}
    </Shell>
  );
}
