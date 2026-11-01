import {
  GALLERY_MESSAGE_MAX,
  GALLERY_NAME_MAX,
  type GalleryDetail,
  type GalleryDownloads,
  type GalleryEvent,
  type GalleryEventKind,
  type GalleryExtras,
  type GalleryPatchBody,
  type GalleryPhotoItem,
  type GuestSelection,
  type PhotoListQuery,
} from '@zephyr/shared/client';
import { Button, Card, Chip, Dialog, Field, Icon, type IconName, Note, useToast } from '@zephyr/ui';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { Shell } from '../components/Shell';
import { copyText, PasscodeReveal, photosLabel, ShNote, StatusChip } from '../components/share/ShareBits';
import {
  DownloadChoice,
  ExtrasSwitches,
  GalleryRenderProgress,
  useBranding,
} from '../components/share/ShareDialogs';
import { ApiFailure, errorMessage } from '../lib/api';
import { toCsv } from '../lib/csv';
import { createAlbum, getPhoto, thumbUrl } from '../lib/library';
import { usePhotoList } from '../lib/photos';
import {
  changeGalleryPhotos,
  galleryPreviewPath,
  getActivity,
  getFavourites,
  getGallery,
  getGalleryLink,
  isoDay,
  listGalleryPhotos,
  maxLinkDays,
  newPasscode,
  patchGallery,
  removePasscode,
  revokeGallery,
  sharingLimits,
} from '../lib/share';
import { shareRenders } from '../lib/shareRenders';
import { useUsage } from '../lib/usage';
import { EmptyHint, GridSkeleton } from './Library';

type Tab = 'photos' | 'favourites' | 'activity' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'photos', label: 'Photos' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

/** One shared gallery: its photos, guests' favourites, the access log and its settings. */
export function GalleryPage() {
  const { galleryId = '', tab: tabParam } = useParams();
  const tab: Tab = (TABS.find((t) => t.id === tabParam)?.id ?? 'photos') as Tab;
  const [g, setG] = useState<GalleryDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [passcode, setPasscode] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'revoke' | 'newcode' | 'nocode'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(
    (signal?: AbortSignal) =>
      getGallery(galleryId, signal)
        .then((d) => {
          setG(d);
          if (d.downloads === 'full' && d.pendingRenders > 0) void shareRenders.resume([d]);
        })
        .catch((e) => {
          if ((e as Error).name === 'AbortError') return;
          setMissing(
            e instanceof ApiFailure && e.code === 'not_found'
              ? 'It may have been deleted, or the link is wrong.'
              : errorMessage(e),
          );
        }),
    [galleryId],
  );
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

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
  const doNewCode = () =>
    run('newcode', async () => {
      const code = await newPasscode(galleryId);
      setConfirm(null);
      setPasscode(code);
      await load();
    });
  const doNoCode = () =>
    run('nocode', async () => {
      await removePasscode(galleryId);
      setConfirm(null);
      toast.show('Passcode turned off. The link alone now opens this gallery.', 'good');
      await load();
    });
  const doCopyLink = () =>
    run('link', async () => {
      const url = await getGalleryLink(galleryId);
      const ok = await copyText(url);
      if (ok) toast.show('Link copied. Send the passcode separately.', 'good');
      else toast.show('Couldn’t copy. Your browser blocked the clipboard.', 'bad');
    });
  const doRevoke = () =>
    run('revoke', async () => {
      await revokeGallery(galleryId);
      setConfirm(null);
      toast.show(`“${g?.name}” is revoked. Its link no longer works.`, 'good');
      await load();
    });

  if (missing)
    return (
      <Shell title="Shared galleries">
        <EmptyHint title="This gallery isn’t here">{missing}</EmptyHint>
      </Shell>
    );
  if (!g)
    return (
      <Shell title="Shared galleries">
        <GridSkeleton />
      </Shell>
    );

  const ended = g.status === 'expired' || g.status === 'revoked';
  const base = `/shared/${encodeURIComponent(g.id)}`;
  return (
    <Shell title="Shared galleries">
      <div className="sh-page">
        <Link to="/shared" className="sh-back">
          <Icon name="chevL" size={16} />
          Shared galleries
        </Link>
        <div className="sh-ghead">
          <span className="sh-ghead__cover">
            {g.coverPhotoId ? <img src={thumbUrl(g.coverPhotoId)} alt="" /> : <Icon name="image" size={22} />}
          </span>
          <div className="sh-ghead__text">
            <h2 className="sh-h1">{g.name}</h2>
            <div className="sh-chips">
              <StatusChip g={g} />
              <Chip tone="outline" icon={g.passcode ? 'lock' : 'link'}>
                {g.passcode ? 'Passcode' : 'Link only'}
              </Chip>
              {g.downloads !== 'none' && (
                <Chip tone="outline" icon="download">
                  {g.downloads === 'full' ? 'Full-size downloads' : 'Web-size downloads'}
                </Chip>
              )}
              {g.extras.watermark && (
                <Chip tone="outline" icon="watermark">
                  Watermark
                </Chip>
              )}
            </div>
            <span className="sh-muted mono">{g.linkHint}</span>
          </div>
          {!ended && (
            <div className="sh-ghead__actions">
              <Button size="sm" icon="copy" busy={busy === 'link'} onClick={doCopyLink}>
                Copy link
              </Button>
              {g.passcode && (
                <Button size="sm" icon="refresh" onClick={() => setConfirm('newcode')}>
                  New passcode
                </Button>
              )}
              <Button
                size="sm"
                kind="ghost"
                icon="eye"
                onClick={() => window.open(galleryPreviewPath(g.id), '_blank', 'noopener')}
              >
                Open as a guest
              </Button>
              <Button size="sm" kind="danger" icon="ban" onClick={() => setConfirm('revoke')}>
                Revoke
              </Button>
            </div>
          )}
        </div>
        {g.status === 'paused' && (
          <Note tone="warn" icon="alert">
            Paused after too many wrong passcodes from anywhere. It reopens on its own in 15 minutes.{' '}
            <button
              type="button"
              className="text-link"
              onClick={() =>
                run('unpause', async () => {
                  setG(await patchGallery(g.id, { unpause: true }));
                })
              }
            >
              Reopen now
            </button>
          </Note>
        )}
        <div role="tablist" aria-label="Gallery" className="sh-tabs">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={t.id === 'photos' ? base : `${base}/${t.id}`}
              end
              role="tab"
              aria-selected={t.id === tab}
              className={`sh-tab${t.id === tab ? ' is-on' : ''}`}
            >
              {t.label}
              {t.id === 'favourites' && g.favourites ? ` · ${g.favourites}` : ''}
            </NavLink>
          ))}
        </div>
        <div role="tabpanel" className="sh-panel">
          {tab === 'photos' && <PhotosTab g={g} onChanged={() => void load()} />}
          {tab === 'favourites' && <FavouritesTab g={g} />}
          {tab === 'activity' && <ActivityTab g={g} />}
          {tab === 'settings' && (
            <SettingsTab
              g={g}
              onSaved={setG}
              onNewCode={() => setConfirm('newcode')}
              onNoCode={() => setConfirm('nocode')}
              onRevoke={() => setConfirm('revoke')}
            />
          )}
        </div>
      </div>

      <Dialog
        open={confirm === 'revoke'}
        onClose={() => !busy && setConfirm(null)}
        title={`Revoke “${g.name}”?`}
        footer={
          <>
            <Button kind="ghost" onClick={() => setConfirm(null)} disabled={Boolean(busy)}>
              Cancel
            </Button>
            <Button kind="danger" icon="ban" busy={busy === 'revoke'} onClick={doRevoke}>
              Revoke for good
            </Button>
          </>
        }
      >
        <p className="sh-p">
          The link stops working straight away, for everyone. This can’t be undone: to share these photos
          again, make a new gallery with a new link.
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'newcode'}
        onClose={() => !busy && setConfirm(null)}
        title={g.passcode ? 'Make a new passcode?' : 'Add a passcode?'}
        footer={
          <>
            <Button kind="ghost" onClick={() => setConfirm(null)} disabled={Boolean(busy)}>
              Cancel
            </Button>
            <Button kind="primary" icon="refresh" busy={busy === 'newcode'} onClick={doNewCode}>
              {g.passcode ? 'Make a new passcode' : 'Add a passcode'}
            </Button>
          </>
        }
      >
        <p className="sh-p">
          {g.passcode
            ? 'The old passcode stops working, and guests who already opened the gallery need the new one.'
            : 'Guests will need the link and the new 6-digit passcode.'}
        </p>
      </Dialog>
      <Dialog
        open={confirm === 'nocode'}
        onClose={() => !busy && setConfirm(null)}
        title="Turn the passcode off?"
        footer={
          <>
            <Button kind="ghost" onClick={() => setConfirm(null)} disabled={Boolean(busy)}>
              Keep the passcode
            </Button>
            <Button kind="danger" busy={busy === 'nocode'} onClick={doNoCode}>
              Turn it off
            </Button>
          </>
        }
      >
        <ShNote icon="alert" tone="warn">
          Without a passcode, anyone who gets the link can see these photos. Fine for a family album; keep it
          on for client work.
        </ShNote>
      </Dialog>
      <Dialog
        open={Boolean(passcode)}
        onClose={() => setPasscode(null)}
        title="Your new passcode"
        footer={
          <Button kind="primary" onClick={() => setPasscode(null)}>
            Done
          </Button>
        }
      >
        {passcode && <PasscodeReveal code={passcode} />}
      </Dialog>
    </Shell>
  );
}

// ---------------------------------------------------------------- photos
function PhotosTab({ g, onChanged }: { g: GalleryDetail; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<GalleryPhotoItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const ended = g.status === 'expired' || g.status === 'revoked';

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on tick
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    listGalleryPhotos(g.id, undefined, c.signal)
      .then((p) => {
        setItems(p.items);
        setCursor(p.nextCursor);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && toast.show(errorMessage(e), 'bad'))
      .finally(() => setLoading(false));
    return () => c.abort();
  }, [g.id, tick]);
  const more = () => {
    if (!cursor) return;
    setLoading(true);
    listGalleryPhotos(g.id, cursor)
      .then((p) => {
        setItems((a) => [...a, ...p.items]);
        setCursor(p.nextCursor);
      })
      .catch((e) => toast.show(errorMessage(e), 'bad'))
      .finally(() => setLoading(false));
  };
  const change = async (body: { add?: string[]; remove?: string[] }, msg: string) => {
    setBusy(true);
    try {
      await changeGalleryPhotos(g.id, body);
      setSelected(new Set());
      setTick((t) => t + 1);
      onChanged();
      toast.show(msg, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="stack">
      <div className="sh-head">
        <span className="sh-muted">{photosLabel(g.photoCount)} · guests see your edited versions</span>
        <span className="sh-grow" />
        {!ended && (
          <>
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              Add photos
            </Button>
            <Button
              size="sm"
              kind="ghost"
              icon="x"
              disabled={!selected.size}
              busy={busy}
              onClick={() =>
                change(
                  { remove: [...selected] },
                  `Removed ${photosLabel(selected.size)} from the gallery. They’re still in your library.`,
                )
              }
            >
              {selected.size ? `Remove ${selected.size}` : 'Remove selected'}
            </Button>
          </>
        )}
      </div>
      {g.downloads === 'full' && <GalleryRenderProgress galleryId={g.id} />}
      {loading && !items.length ? (
        <GridSkeleton />
      ) : (
        <ul className="sh-grid" aria-label="Photos in this gallery">
          {items.map((p) => {
            const on = selected.has(p.photoId);
            return (
              <li key={p.photoId}>
                <button
                  type="button"
                  className={`sh-tile${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  aria-label={`Photo ${p.position + 1}${p.favourites ? `, ${p.favourites} favourites` : ''}`}
                  onClick={() => !ended && toggle(p.photoId)}
                >
                  <img src={thumbUrl(p.photoId)} alt="" loading="lazy" />
                  {p.full === 'pending' && (
                    <span className="sh-tile__prep">
                      <Chip size="sm">Preparing</Chip>
                    </span>
                  )}
                  {p.favourites > 0 && (
                    <span className="sh-tile__fav">
                      <Icon name="heart" size={12} />
                      {p.favourites}
                    </span>
                  )}
                  {on && (
                    <span className="sh-tile__check" aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <Button kind="ghost" onClick={more} busy={loading}>
          Show more
        </Button>
      )}
      <AddPhotosDialog
        open={adding}
        have={new Set(items.map((i) => i.photoId))}
        onClose={() => setAdding(false)}
        onAdd={async (ids) => {
          setAdding(false);
          await change({ add: ids }, `Added ${photosLabel(ids.length)} to the gallery`);
        }}
      />
    </div>
  );
}

function AddPhotosDialog({
  open,
  have,
  onClose,
  onAdd,
}: {
  open: boolean;
  have: Set<string>;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const query = useMemo<PhotoListQuery>(() => ({ view: 'library', sort: 'taken' }), []);
  const list = usePhotoList(query);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setPicked(new Set());
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add photos"
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon="plus" disabled={!picked.size} onClick={() => onAdd([...picked])}>
            {picked.size ? `Add ${photosLabel(picked.size)}` : 'Add photos'}
          </Button>
        </>
      }
    >
      <ul className="sh-grid sh-grid--pick" aria-label="Your library">
        {list.items.map((p) => {
          const inGallery = have.has(p.id);
          const on = picked.has(p.id);
          return (
            <li key={p.id}>
              <button
                type="button"
                className={`sh-tile${on ? ' is-on' : ''}`}
                aria-pressed={on}
                disabled={inGallery}
                aria-label={`${p.filename}${inGallery ? ', already in this gallery' : ''}`}
                onClick={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(p.id)) n.delete(p.id);
                    else n.add(p.id);
                    return n;
                  })
                }
              >
                <img
                  src={thumbUrl(p.id, p.edit?.rendered ? p.edit.version : undefined)}
                  alt=""
                  loading="lazy"
                />
                {inGallery && (
                  <span className="sh-tile__prep">
                    <Chip size="sm">In gallery</Chip>
                  </span>
                )}
                {on && (
                  <span className="sh-tile__check" aria-hidden="true">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {list.hasMore && (
        <Button kind="ghost" onClick={list.loadMore} busy={list.loading}>
          Show more
        </Button>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- favourites
export function favouritesCsv(gallery: string, guests: GuestSelection[], names: Map<string, string>): string {
  const rows: unknown[][] = [['Gallery', 'Guest', 'Sent', 'Note', 'File name', 'Photo id']];
  for (const s of guests)
    for (const id of s.photoIds)
      rows.push([
        gallery,
        s.name ?? 'Guest',
        s.sentAt ?? 'Not sent yet',
        s.note ?? '',
        names.get(id) ?? '',
        id,
      ]);
  return toCsv(rows);
}

function Upsell({ what }: { what: string }) {
  return (
    <ShNote icon="lock">
      {what} is part of Studio. <Link to="/settings/sharing">See what Studio adds</Link>
    </ShNote>
  );
}

function FavouritesTab({ g }: { g: GalleryDetail }) {
  const toast = useToast();
  const usage = useUsage();
  const limits = sharingLimits(usage);
  const [guests, setGuests] = useState<GuestSelection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!limits.guestFavourites) return;
    const c = new AbortController();
    getFavourites(g.id, c.signal)
      .then(setGuests)
      .catch((e) => (e as Error).name !== 'AbortError' && toast.show(errorMessage(e), 'bad'));
    return () => c.abort();
  }, [g.id, limits.guestFavourites, toast]);
  if (!limits.guestFavourites) return <Upsell what="Guest favourites" />;
  if (!guests) return <GridSkeleton />;
  if (!guests.length)
    return (
      <EmptyHint title="No favourites yet">
        {g.extras.favourites
          ? 'When guests heart photos and send their selection, it shows up here.'
          : 'Turn on “Let guests pick favourites” in Settings so guests can heart photos.'}
      </EmptyHint>
    );

  const saveAlbum = async (s: GuestSelection) => {
    setBusy(s.guestId);
    try {
      const a = await createAlbum({
        name: `${g.name} · ${s.name ?? 'Guest'}`.slice(0, 80),
        photoIds: s.photoIds,
      });
      toast.show(`Saved ${photosLabel(s.photoIds.length)} as the album “${a.name}”`, 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const exportCsv = async () => {
    setBusy('csv');
    try {
      const ids = [...new Set(guests.flatMap((s) => s.photoIds))];
      const names = new Map<string, string>();
      // File names, fetched a few at a time.
      for (let i = 0; i < ids.length; i += 6) {
        const part = await Promise.all(ids.slice(i, i + 6).map((id) => getPhoto(id).catch(() => null)));
        for (const p of part) if (p) names.set(p.id, p.filename);
      }
      const blob = new Blob([favouritesCsv(g.name, guests, names)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `favourites-${
        g.name
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || 'gallery'
      }.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="sh-head">
        <span className="sh-muted">
          Guests heart photos and send you their selection. Names are what they typed; they don’t need an
          account.
        </span>
        <span className="sh-grow" />
        <Button size="sm" kind="ghost" icon="file" busy={busy === 'csv'} onClick={exportCsv}>
          Export list (.csv)
        </Button>
      </div>
      {guests.map((s) => (
        <Card key={s.guestId} className="sh-guest">
          <div className="sh-guest__head">
            <span className="row__icon">
              <Icon name="user" size={17} />
            </span>
            <span className="row__text">
              <span className="row__title">{s.name ?? 'Guest'}</span>
              <span className="row__sub">
                {photosLabel(s.photoIds.length).replace('photo', 'favourite')} ·{' '}
                {s.sentAt
                  ? `sent ${new Date(s.sentAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                  : 'not sent yet'}
              </span>
            </span>
            <Button
              size="sm"
              kind="ghost"
              icon="folder"
              busy={busy === s.guestId}
              onClick={() => saveAlbum(s)}
            >
              Save as album
            </Button>
          </div>
          {s.note && <p className="sh-quote">“{s.note}”</p>}
          <div className="sh-strip">
            {s.photoIds.slice(0, 8).map((id) => (
              <img key={id} src={thumbUrl(id)} alt="" loading="lazy" />
            ))}
            {s.photoIds.length > 8 && <span className="sh-strip__more">+{s.photoIds.length - 8}</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- activity
const EVENT: Record<GalleryEventKind, { icon: IconName; text: (e: GalleryEvent) => string; warn?: boolean }> =
  {
    opened: { icon: 'eye', text: () => 'Opened' },
    unlocked: { icon: 'unlock', text: () => 'Unlocked with the passcode' },
    downloaded: {
      icon: 'download',
      text: (e) => (e.count && e.count > 1 ? `Downloaded ${e.count} photos` : 'Downloaded a photo'),
    },
    favourites_sent: { icon: 'heart', text: (e) => `Sent ${e.count ?? ''} favourites`.replace('  ', ' ') },
    wrong_passcode: {
      icon: 'alert',
      text: (e) => (e.count && e.count > 1 ? `${e.count} wrong passcodes` : 'Wrong passcode'),
      warn: true,
    },
    paused: { icon: 'alert', text: () => 'Paused for 15 minutes after too many wrong passcodes', warn: true },
    passcode_changed: { icon: 'refresh', text: () => 'Passcode changed · the old one stopped working' },
    created: { icon: 'link', text: () => 'Link created' },
    revoked: { icon: 'ban', text: () => 'Link revoked' },
  };

function ActivityTab({ g }: { g: GalleryDetail }) {
  const toast = useToast();
  const usage = useUsage();
  const limits = sharingLimits(usage);
  const [page, setPage] = useState<Awaited<ReturnType<typeof getActivity>> | null>(null);
  const [events, setEvents] = useState<GalleryEvent[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!limits.accessLog) return;
    const c = new AbortController();
    getActivity(g.id, undefined, c.signal)
      .then((p) => {
        setPage(p);
        setEvents(p.events);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && toast.show(errorMessage(e), 'bad'));
    return () => c.abort();
  }, [g.id, limits.accessLog, toast]);
  if (!limits.accessLog) return <Upsell what="The access log" />;
  if (!page) return <GridSkeleton />;
  const more = async () => {
    if (!page.nextCursor) return;
    setBusy(true);
    try {
      const p = await getActivity(g.id, page.nextCursor);
      setPage(p);
      setEvents((a) => [...a, ...p.events]);
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const st = page.stats;
  return (
    <div className="stack">
      {!g.extras.accessLog && (
        <ShNote>
          The access log is off for this gallery, so only passcode problems are recorded. Turn it on in
          Settings.
        </ShNote>
      )}
      <div className="sh-stats">
        {(
          [
            [st.views, 'views'],
            [st.downloads, 'downloads'],
            [st.favourites, 'favourites'],
            [st.wrongPasscodesWeek, 'wrong passcodes this week'],
          ] as const
        ).map(([n, l]) => (
          <div key={l} className="sh-stat">
            <span className="mono">{n.toLocaleString('en')}</span>
            <span>{l}</span>
          </div>
        ))}
      </div>
      {events.length ? (
        <ul className="sh-events plain-list">
          {events.map((e, i) => {
            const d = EVENT[e.kind] ?? { icon: 'info' as IconName, text: () => e.kind };
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: events have no ids
              <li key={`${e.at}-${i}`} className="row">
                <span className={`sh-events__icon${d.warn ? ' is-warn' : ''}`}>
                  <Icon name={d.icon} size={17} />
                </span>
                <span className="row__text">
                  <span className="row__title">{d.text(e)}</span>
                  <span className="row__sub">{[e.place, e.device].filter(Boolean).join(' · ') || '—'}</span>
                </span>
                <span className="sh-muted mono">
                  {new Date(e.at).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyHint title="Nothing yet">Views, downloads and passcode attempts appear here.</EmptyHint>
      )}
      {page.nextCursor && (
        <Button kind="ghost" busy={busy} onClick={more}>
          Show older
        </Button>
      )}
      <span className="sh-muted sh-small">
        Locations are approximate (country and city from the network) and kept for 90 days. Zephyr never
        stores guests’ IP addresses.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- settings
function SettingsTab({
  g,
  onSaved,
  onNewCode,
  onNoCode,
  onRevoke,
}: {
  g: GalleryDetail;
  onSaved: (g: GalleryDetail) => void;
  onNewCode: () => void;
  onNoCode: () => void;
  onRevoke: () => void;
}) {
  const toast = useToast();
  const usage = useUsage();
  const limits = sharingLimits(usage);
  const branding = useBranding(limits);
  const maxDays = maxLinkDays(limits);
  const ended = g.status === 'expired' || g.status === 'revoked';
  const [name, setName] = useState(g.name);
  const [expires, setExpires] = useState(g.expiresAt.slice(0, 10));
  const [downloads, setDownloads] = useState<GalleryDownloads>(g.downloads);
  const [extras, setExtras] = useState<GalleryExtras>(g.extras);
  const [message, setMessage] = useState(g.message ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch: GalleryPatchBody = {};
  if (name.trim() !== g.name) patch.name = name.trim();
  if (expires !== g.expiresAt.slice(0, 10)) patch.expiresOn = expires;
  if (downloads !== g.downloads) patch.downloads = downloads;
  if (JSON.stringify(extras) !== JSON.stringify(g.extras)) patch.extras = extras;
  if (message.trim() !== (g.message ?? '')) patch.message = message.trim() || null;
  const dirty = Object.keys(patch).length > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      const next = await patchGallery(g.id, patch);
      onSaved(next);
      toast.show('Gallery settings saved', 'good');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (ended)
    return (
      <ShNote>
        This gallery has {g.status === 'revoked' ? 'been revoked' : 'expired'}, so its settings can’t change.
        Its guest data is deleted 30 days after it ended.
      </ShNote>
    );

  return (
    <div className="stack sh-settings">
      <Card>
        <form className="stack" onSubmit={save}>
          <Field
            label="Gallery name"
            value={name}
            maxLength={GALLERY_NAME_MAX}
            required
            onChange={(e) => setName(e.target.value)}
            size="md"
          />
          <Field
            label="Link expires"
            type="date"
            value={expires}
            min={isoDay(0)}
            max={isoDay(maxDays)}
            required
            onChange={(e) => setExpires(e.target.value)}
            size="md"
          />
          <DownloadChoice
            value={downloads}
            onChange={setDownloads}
            limits={limits}
            name="gallery-downloads"
          />
          <ExtrasSwitches value={extras} onChange={setExtras} limits={limits} branding={branding} />
          <label className="sh-field">
            <span className="sh-label">Message for guests</span>
            <textarea
              className="z-input sh-textarea"
              rows={2}
              maxLength={GALLERY_MESSAGE_MAX}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          {error && (
            <Note tone="bad" icon="alert" role="alert">
              {error}
            </Note>
          )}
          <div className="sh-actions">
            <Button kind="primary" type="submit" busy={busy} disabled={!dirty || !name.trim()}>
              Save changes
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <SettingRow
          icon={g.passcode ? 'lock' : 'unlock'}
          title={g.passcode ? 'Passcode is on' : 'No passcode'}
          sub={
            g.passcode
              ? 'Guests need the link and the 6-digit passcode. Zephyr can’t show the current one again.'
              : 'Anyone with the link can see this gallery.'
          }
        >
          {g.passcode ? (
            <>
              <Button size="sm" icon="refresh" onClick={onNewCode}>
                New passcode
              </Button>
              <Button size="sm" kind="ghost" onClick={onNoCode}>
                Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" icon="lock" onClick={onNewCode}>
              Add a passcode
            </Button>
          )}
        </SettingRow>
        <SettingRow
          icon="ban"
          title="Revoke this gallery"
          sub="The link stops working for everyone. This can’t be undone."
        >
          <Button size="sm" kind="danger" onClick={onRevoke}>
            Revoke
          </Button>
        </SettingRow>
      </Card>
    </div>
  );
}

function SettingRow({
  icon,
  title,
  sub,
  children,
}: {
  icon: IconName;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <span className="row__icon">
        <Icon name={icon} size={17} />
      </span>
      <span className="row__text">
        <span className="row__title">{title}</span>
        <span className="row__sub">{sub}</span>
      </span>
      <span className="row__actions">{children}</span>
    </div>
  );
}
