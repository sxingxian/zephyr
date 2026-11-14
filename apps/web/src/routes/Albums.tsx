import type { AlbumItem, PhotoListQuery } from '@zephyr/shared/client';
import { Button, buttonClass, Dialog, Field, Icon, IconButton, Mascot, Note, useToast } from '@zephyr/ui';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  type BarAction,
  Segmented,
  SelectionBar,
  SortSelect,
  useShareWithViewer,
  useViewerHost,
} from '../components/LibraryBits';
import { PhotoGrid } from '../components/PhotoGrid';
import { Shell } from '../components/Shell';
import { useShareGallery } from '../components/share/ShareDialogs';
import { errorMessage } from '../lib/api';
import { emitLibrary, onLibrary } from '../lib/bus';
import {
  allPhotoIds,
  bulk,
  createAlbum,
  deleteAlbum,
  getAlbum,
  listAlbums,
  patchAlbum,
  thumbUrl,
} from '../lib/library';
import { useCan } from '../lib/libraryContext';
import { usePhotoList } from '../lib/photos';
import { useSelection } from '../lib/selection';
import { EmptyHint, GridSkeleton, useLibraryActions } from './Library';

type AlbumSort = 'updated' | 'name' | 'created';

function Mosaic({ ids }: { ids: string[] }) {
  return (
    <span className="mosaic" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="mosaic__cell">
          {ids[i] ? (
            <img src={thumbUrl(ids[i])} alt="" loading="lazy" decoding="async" />
          ) : (
            i === 0 && <Icon name="image" size={22} />
          )}
        </span>
      ))}
    </span>
  );
}

function NewAlbumDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const a = await createAlbum({ name: name.trim() });
      emitLibrary({ type: 'albums' });
      onClose();
      nav(`/albums/${encodeURIComponent(a.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New album"
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" form="new-album" busy={busy} disabled={!name.trim()}>
            Create album
          </Button>
        </>
      }
    >
      <form id="new-album" onSubmit={submit}>
        <Field
          label="Name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bintan weekend"
          error={error}
          autoFocus
        />
      </form>
      <p className="z-hint">Add photos by selecting them in your library and choosing Add to album.</p>
    </Dialog>
  );
}

/** Albums: mosaic cards, plus Favourites and Trash on phones (they live in the sidebar on wide screens). */
export function AlbumsPage() {
  const canEdit = useCan('edit');
  const [albums, setAlbums] = useState<AlbumItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<AlbumSort>('updated');
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    setError(null);
    listAlbums()
      .then(setAlbums)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => onLibrary((e) => e.type === 'albums' && load()), [load]);

  const sorted = useMemo(() => {
    const a = [...(albums ?? [])];
    if (sort === 'name') a.sort((x, y) => x.name.localeCompare(y.name));
    else if (sort === 'created') a.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    else a.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
    return a;
  }, [albums, sort]);

  return (
    <Shell
      title="Albums"
      actions={
        <IconButton icon="plus" label="New album" className="phone-only" onClick={() => setCreating(true)} />
      }
    >
      <div className="lib-toolbar">
        <span className="desk-only">
          <Segmented
            label="Filter albums"
            value="all"
            onChange={() => {}}
            options={[{ value: 'all', label: 'All albums' }]}
          />
        </span>
        <span className="chip-soon desk-only" title="Coming soon">
          Shared · Soon
        </span>
        <span className="lib-toolbar__spacer" />
        <SortSelect
          value={sort}
          onChange={setSort}
          options={[
            { value: 'updated', label: 'Recently added to' },
            { value: 'name', label: 'Name' },
            { value: 'created', label: 'Date created' },
          ]}
        />
        {canEdit && (
          <Button
            kind="primary"
            size="sm"
            icon="plus"
            className="desk-only"
            onClick={() => setCreating(true)}
          >
            New album
          </Button>
        )}
      </div>
      {error && (
        <Note tone="bad" icon="alert" role="alert">
          {error}
        </Note>
      )}
      {albums === null && !error ? (
        <div className="albums">
          {[0, 1, 2].map((i) => (
            <span key={i} className="album-card album-card--skel" aria-hidden="true" />
          ))}
        </div>
      ) : albums && albums.length === 0 ? (
        <section className="empty" aria-labelledby="albums-empty">
          <Mascot
            pose="peek"
            width={200}
            tile={{ background: 'var(--m-sky)', height: 210 }}
            className="empty__art"
          />
          <h2 id="albums-empty" className="empty__title">
            Make your first album
          </h2>
          <p className="empty__text">
            Group a shoot, a trip or a client’s picks. Photos stay in your library too.
          </p>
          {canEdit && (
            <div className="empty__actions">
              <Button kind="primary" size="lg" icon="plus" onClick={() => setCreating(true)}>
                New album
              </Button>
            </div>
          )}
        </section>
      ) : (
        <ul className="albums" aria-label="Albums">
          {sorted.map((a) => (
            <li key={a.id}>
              <Link to={`/albums/${encodeURIComponent(a.id)}`} className="album-card">
                <Mosaic ids={a.coverPhotoIds} />
                <span className="album-card__text">
                  <strong>{a.name}</strong>
                  <span>
                    {a.photoCount.toLocaleString('en')} photo{a.photoCount === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <section className="you-group phone-only">
        <h2 className="z-eyebrow">More</h2>
        <div className="you-group__box">
          <Link to="/favourites" className="you-row">
            <span className="you-row__icon">
              <Icon name="heart" size={17} />
            </span>
            <span className="you-row__label">Favourites</span>
            <Icon name="chevR" size={16} />
          </Link>
          <Link to="/trash" className="you-row">
            <span className="you-row__icon">
              <Icon name="trash" size={17} />
            </span>
            <span className="you-row__label">Trash</span>
            <Icon name="chevR" size={16} />
          </Link>
        </div>
      </section>
      <NewAlbumDialog open={creating} onClose={() => setCreating(false)} />
    </Shell>
  );
}

/** One album: the library grid filtered to it, with rename, delete, remove and set cover. */
export function AlbumPage({ albumId }: { albumId: string }) {
  const canEdit = useCan('edit');
  const canShare = useCan('galleries');
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const { returnId } = useViewerHost();
  const [album, setAlbum] = useState<AlbumItem | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [sort, setSort] = useState<NonNullable<PhotoListQuery['sort']>>('taken');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const loadAlbum = useCallback(() => {
    getAlbum(albumId)
      .then(setAlbum)
      .catch((e) => setMissing(errorMessage(e)));
  }, [albumId]);
  useEffect(() => loadAlbum(), [loadAlbum]);
  useEffect(() => onLibrary((e) => e.type === 'albums' && loadAlbum()), [loadAlbum]);

  const query = useMemo<PhotoListQuery>(() => ({ view: 'library', albumId, sort }), [albumId, sort]);
  const list = usePhotoList(query);
  const sel = useSelection();
  const ids = [...sel.selected];
  const sharing = useShareGallery();
  const shareAlbum = async () => {
    setBusy('share');
    try {
      const all = await allPhotoIds({ view: 'library', albumId });
      if (all.length) sharing.open(all, album?.name ?? '');
      else toast.show('Add photos to this album first.', 'bad');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };

  const removeFromAlbum = async () => {
    setBusy('remove');
    try {
      await bulk(ids, 'remove_from_album', albumId);
      list.remove(ids);
      sel.clear();
      emitLibrary({ type: 'albums' });
      toast.show(
        `Removed ${ids.length} from ${album?.name ?? 'the album'}. They’re still in your library.`,
        'good',
      );
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const setCover = async () => {
    setBusy('cover');
    try {
      const a = await patchAlbum(albumId, { coverPhotoId: ids[0] });
      setAlbum(a);
      sel.clear();
      toast.show('Cover updated', 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const extra: BarAction[] = [
    {
      icon: 'image',
      label: 'Set as cover',
      onClick: setCover,
      busy: busy === 'cover',
      disabled: ids.length !== 1,
      hint: 'Select one photo to use as the cover',
    },
    { icon: 'x', label: 'Remove from album', onClick: removeFromAlbum, busy: busy === 'remove' },
  ];
  const { actions, pickerEl } = useLibraryActions(list, sel, extra);

  useShareWithViewer({
    items: list.items,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    backLabel: album?.name ?? 'Album',
    total: album?.photoCount,
  });
  const { prune } = sel;
  useEffect(() => {
    const have = new Set(list.items.map((p) => p.id));
    prune((id) => have.has(id));
  }, [list.items, prune]);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy('rename');
    try {
      const a = await patchAlbum(albumId, { name: name.trim() });
      setAlbum(a);
      setRenaming(false);
      emitLibrary({ type: 'albums' });
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await deleteAlbum(albumId);
      emitLibrary({ type: 'albums' });
      toast.show(`Deleted “${album?.name}”. Its photos are still in your library.`, 'good');
      nav('/albums', { replace: true });
    } catch (err) {
      toast.show(errorMessage(err), 'bad');
      setBusy(null);
    }
  };

  if (missing) {
    return (
      <Shell title="Album">
        <EmptyHint title="This album isn’t here">{missing}</EmptyHint>
        <Link to="/albums" className={buttonClass({ kind: 'secondary' }, 'self-start')}>
          Back to albums
        </Link>
      </Shell>
    );
  }

  return (
    <Shell
      title={album?.name ?? 'Album'}
      actions={
        <>
          {canShare && (
            <Button
              size="sm"
              icon="share"
              onClick={shareAlbum}
              busy={busy === 'share'}
              disabled={!album?.photoCount}
            >
              Share album
            </Button>
          )}
          {canEdit && (
            <>
              <Button
                size="sm"
                kind="ghost"
                onClick={() => {
                  setName(album?.name ?? '');
                  setRenaming(true);
                }}
                disabled={!album}
              >
                Rename
              </Button>
              <IconButton
                icon="trash"
                size="sm"
                label="Delete album"
                onClick={() => setDeleting(true)}
                disabled={!album}
              />
            </>
          )}
        </>
      }
    >
      <div className="lib-toolbar">
        <Link to="/albums" className="crumb">
          <Icon name="chevL" size={16} />
          Albums
        </Link>
        <span className="z-muted">
          {album ? `${album.photoCount.toLocaleString('en')} photo${album.photoCount === 1 ? '' : 's'}` : ''}
        </span>
        <span className="lib-toolbar__spacer" />
        <SortSelect
          value={sort}
          onChange={setSort}
          options={[
            { value: 'taken', label: 'Date taken' },
            { value: 'added', label: 'Date added' },
          ]}
        />
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
          {list.error}
        </Note>
      )}
      {list.initial ? (
        <GridSkeleton />
      ) : list.items.length === 0 ? (
        <EmptyHint title="This album is empty">
          Select photos in your <Link to="/">library</Link> and choose Add to album.
        </EmptyHint>
      ) : (
        <PhotoGrid
          items={list.items}
          sort={sort}
          hasMore={list.hasMore}
          loading={list.loading}
          loadMore={list.loadMore}
          selection={sel}
          focusId={returnId}
          onOpen={(i) => {
            const p = list.items[i];
            if (p) nav(`/photo/${encodeURIComponent(p.id)}`, { state: { bg: loc.pathname } });
          }}
          label={`Photos in ${album?.name ?? 'this album'}`}
        />
      )}
      {pickerEl}
      {sharing.dialogs}
      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename album"
        footer={
          <>
            <Button kind="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              kind="primary"
              type="submit"
              form="rename-album"
              busy={busy === 'rename'}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <form id="rename-album" onSubmit={rename}>
          <Field
            label="Name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </form>
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this album?"
        footer={
          <>
            <Button kind="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button kind="danger" icon="trash" busy={busy === 'delete'} onClick={remove}>
              Delete album
            </Button>
          </>
        }
      >
        <p>
          “{album?.name}” is removed. Its {album?.photoCount ?? 0} photo{album?.photoCount === 1 ? '' : 's'}{' '}
          stay in your library.
        </p>
      </Dialog>
    </Shell>
  );
}
