import type { GuestGalleryInfo, GuestPhoto, GuestPhotoPage } from '@zephyr/shared/client';
import { Button, Chip, Icon, Spinner } from '@zephyr/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pickZipSink } from '../lib/editor/zipSink';
import { GuestApiError, sendFavourites, setFavourite } from './api';
import { accentStyle, formatDate, GuestFooter, StudioBadge } from './Chrome';
import { GuestImage } from './GuestImage';
import { useGuestPhotos } from './photos';
import { SendDialog } from './SendDialog';
import { Viewer } from './Viewer';
import { buildZip, saveBlob, ZipProblem, type ZipSize, zipPlan } from './zip';

export interface GalleryProps {
  info: GuestGalleryInfo;
  /** null in the owner's preview: favourites can't be changed there. */
  token: string | null;
  fetchPage: (cursor: string | null) => Promise<GuestPhotoPage>;
  /** The unlock expired or the passcode changed. */
  onLocked: () => void;
  preview?: boolean;
}

const SENT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const DAY = 86_400_000;

export function Gallery({ info, token, fetchPage, onLocked, preview }: GalleryProps) {
  const ph = useGuestPhotos(fetchPage, onLocked);
  const [viewing, setViewing] = useState<number | null>(null);
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState('');
  const [zip, setZip] = useState<{ done: number; total: number; ctrl: AbortController } | null>(null);
  const [allMenu, setAllMenu] = useState(false);
  const latest = useRef(ph.items);
  latest.current = ph.items;
  const sentinel = useRef<HTMLDivElement>(null);

  const favs = info.favourites && !preview && token !== null;
  const shown = useMemo(
    () => (onlyFavs ? ph.items.filter((p) => p.favourite) : ph.items),
    [onlyFavs, ph.items],
  );
  const { loadMore, hasMore, loading } = ph;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), {
      rootMargin: '800px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const toggleFavourite = useCallback(
    async (p: GuestPhoto) => {
      if (!favs || !token) return;
      const on = !p.favourite;
      ph.markFavourite(p.id, on);
      try {
        await setFavourite(token, p.id, on);
        setLive(on ? 'Added to your favourites' : 'Removed from your favourites');
      } catch (e) {
        ph.markFavourite(p.id, !on);
        if (e instanceof GuestApiError && e.status === 401) onLocked();
        else setLive('That didn’t save. Check your connection and try again.');
      }
    },
    [favs, token, ph, onLocked],
  );

  const downloadAll = async (size: ZipSize) => {
    setAllMenu(false);
    const name = `${info.name}.zip`;
    // Ask where to save first: the save picker needs this click.
    let sink: Awaited<ReturnType<typeof pickZipSink>> = null;
    try {
      sink = await pickZipSink(name);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    // Every photo, not just the pages on screen.
    let everything: GuestPhoto[];
    try {
      everything = await ph.loadAll();
    } catch (e) {
      await sink?.abort().catch(() => undefined);
      if (e instanceof GuestApiError && e.status === 401) onLocked();
      else setLive('The download didn’t start. Check your connection and try again.');
      return;
    }
    const plan = zipPlan(everything, size);
    if (!plan.included.length) {
      await sink?.abort().catch(() => undefined);
      setLive(
        plan.preparing
          ? 'The full-size photos are still being prepared. Try again in a few minutes.'
          : 'Nothing to download yet.',
      );
      return;
    }
    const ctrl = new AbortController();
    setZip({ done: 0, total: plan.included.length, ctrl });
    try {
      const blob = await buildZip(
        plan.included,
        {
          size,
          galleryName: info.name,
          signal: ctrl.signal,
          onProgress: (done, total) => setZip((z) => (z ? { ...z, done, total } : z)),
          fresh: async (id) => {
            await ph.refreshUrls();
            return latest.current.find((q) => q.id === id) ?? null;
          },
        },
        sink,
      );
      if (blob) saveBlob(blob, name);
      setLive(
        plan.preparing
          ? `Downloaded. ${plan.preparing} full-size ${plan.preparing === 1 ? 'photo is' : 'photos are'} still being prepared and weren’t included.`
          : 'Download ready.',
      );
    } catch (e) {
      if ((e as Error).name === 'AbortError') setLive('Download cancelled.');
      else setLive(e instanceof ZipProblem ? e.message : 'The download didn’t finish. Try again.');
    } finally {
      setZip(null);
    }
  };

  const expires = Date.parse(info.expiresAt);
  const soon = Number.isFinite(expires) && expires - Date.now() < 3 * DAY;
  const downloadChip =
    info.downloads === 'full'
      ? 'Full-size downloads'
      : info.downloads === 'web'
        ? 'Web-size downloads'
        : 'View only';
  const favPhotos = ph.items.filter((p) => p.favourite);

  return (
    <div className="g-page" style={accentStyle(info.brand)}>
      <a className="z-skip" href="#gallery">
        Skip to photos
      </a>
      {preview && (
        <div className="g-preview" role="status">
          <Icon name="eye" size={16} />
          Preview · this is what guests see. Favourites and downloads are off here.
        </div>
      )}
      <header className="g-head">
        <StudioBadge brand={info.brand} size={40} />
        <strong className="g-head__name">{info.brand.studioName}</strong>
        <span className="g-grow" />
        {favs && (
          <Button
            size="sm"
            icon="heart"
            aria-pressed={onlyFavs}
            aria-label={`Show only your favourites (${ph.selection.count})`}
            onClick={() => setOnlyFavs((v) => !v)}
            className="g-head__btn"
          >
            <span className="g-hide-sm">Your favourites · </span>
            {ph.selection.count}
          </Button>
        )}
        {info.downloads !== 'none' && !preview && (
          <div className="g-menu-wrap">
            <Button
              size="sm"
              icon="download"
              aria-label="Download all"
              aria-haspopup={info.downloads === 'full' ? 'menu' : undefined}
              aria-expanded={info.downloads === 'full' ? allMenu : undefined}
              disabled={zip !== null}
              onClick={() => (info.downloads === 'full' ? setAllMenu((m) => !m) : void downloadAll('web'))}
              className="g-head__btn"
            >
              <span className="g-hide-sm">Download all</span>
            </Button>
            {allMenu && (
              <div className="g-menu g-menu--light" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="g-menu__item"
                  onClick={() => void downloadAll('full')}
                >
                  <span>Full size</span>
                  <span className="g-muted">Original resolution · .zip</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="g-menu__item"
                  onClick={() => void downloadAll('web')}
                >
                  <span>Web size</span>
                  <span className="g-muted">Up to 2048 px · .zip</span>
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <main id="gallery" className="g-main">
        <section className="g-intro">
          <h1 className="g-title">{info.name}</h1>
          <div className="g-chips">
            <Chip>
              {info.photoCount.toLocaleString('en')} {info.photoCount === 1 ? 'photo' : 'photos'}
            </Chip>
            <Chip tone="outline" icon={info.downloads === 'none' ? 'eye' : 'download'}>
              {downloadChip}
            </Chip>
            <Chip tone={soon ? 'warn' : 'neutral'} icon="clock">
              Available until {formatDate(info.expiresAt)}
            </Chip>
          </div>
          {info.message ? (
            <p className="g-message">{info.message}</p>
          ) : favs ? (
            <p className="g-message">
              Tap the heart on the shots you love, then send your selection to {info.brand.studioName}.
            </p>
          ) : null}
        </section>

        {onlyFavs && shown.length === 0 && (
          <p className="g-empty">No favourites yet. Tap the heart on a photo to add it.</p>
        )}
        <div className="g-grid">
          {shown.map((p) => {
            const i = ph.items.indexOf(p);
            return (
              <div
                key={p.id}
                className="g-tile"
                style={{ aspectRatio: `${p.width || 4} / ${p.height || 3}` }}
              >
                <button
                  type="button"
                  className="g-tile__open"
                  onClick={() => setViewing(i)}
                  aria-label={`Open photo ${i + 1}`}
                >
                  <GuestImage
                    variant="tile"
                    src={p.grid}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onExpired={() => ph.refreshUrls()}
                  />
                </button>
                {favs && (
                  <button
                    type="button"
                    className={`g-heart${p.favourite ? ' g-heart--on' : ''}`}
                    aria-label={`Favourite photo ${i + 1}`}
                    aria-pressed={Boolean(p.favourite)}
                    onClick={() => void toggleFavourite(p)}
                  >
                    <Icon name="heart" size={17} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div ref={sentinel} className="g-more">
          {loading && <Spinner size={20} label="Loading photos" />}
          {!loading && hasMore && !onlyFavs && (
            <Button size="sm" onClick={loadMore}>
              Show more photos
            </Button>
          )}
          {ph.error && (
            <p role="alert" className="g-muted">
              Some photos didn’t load.{' '}
              <button type="button" className="text-link" onClick={loadMore}>
                Try again
              </button>
            </p>
          )}
        </div>
      </main>
      <GuestFooter />

      {favs && ph.selection.count > 0 && (
        <section className="g-selbar" aria-label="Your selection">
          <span className="g-selbar__count">
            <Icon name="heart" size={16} />
            {ph.selection.count} {ph.selection.count === 1 ? 'favourite' : 'favourites'}
          </span>
          <span className="g-selbar__state g-hide-sm">
            {ph.selection.sentAt ? `Sent ${SENT.format(new Date(ph.selection.sentAt))}` : 'Not sent yet'}
          </span>
          <button
            type="button"
            className="g-selbar__send"
            aria-label={
              ph.selection.sentAt
                ? 'Send your favourites again'
                : `Send your favourites to ${info.brand.studioName}`
            }
            onClick={() => setSending(true)}
          >
            <span className="g-hide-sm">
              {ph.selection.sentAt ? 'Send again' : `Send to ${info.brand.studioName}`}
            </span>
            <span className="g-show-sm">Send</span>
          </button>
        </section>
      )}

      {zip && (
        <div className="g-zip" role="status">
          <Spinner size={16} />
          <span>
            Preparing your download · {zip.done} of {zip.total}
          </span>
          <button type="button" className="text-link" onClick={() => zip.ctrl.abort()}>
            Cancel
          </button>
        </div>
      )}
      <p className="z-sr" aria-live="polite">
        {live}
      </p>

      {viewing !== null && (
        <Viewer
          photos={ph.items}
          total={info.photoCount}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          downloads={preview ? 'none' : info.downloads}
          favourites={favs}
          onFavourite={(p) => void toggleFavourite(p)}
          onImageError={() => void ph.refreshUrls()}
          onNearEnd={loadMore}
        />
      )}
      {favs && token && (
        <SendDialog
          open={sending}
          onClose={() => setSending(false)}
          studioName={info.brand.studioName}
          favourites={favPhotos}
          count={ph.selection.count}
          initialName={ph.selection.name ?? ''}
          onSend={async (name, note) => {
            await sendFavourites(token, note ? { name, note } : { name });
            ph.markSent(name);
            setSending(false);
            setLive(`Sent to ${info.brand.studioName}.`);
          }}
        />
      )}
    </div>
  );
}
