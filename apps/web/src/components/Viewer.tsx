import { FILE_TYPES, type PhotoDetail, type PhotoItem } from '@zephyr/shared/client';
import { Icon, Spinner } from '@zephyr/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { errorMessage } from '../lib/api';
import { emitLibrary } from '../lib/bus';
import { cameraName, exposure, longDateTime, relativeDateTime, shortDateTime } from '../lib/format';
import { bulk, getPhoto, originalUrl, patchPhoto, previewUrl, thumbUrl } from '../lib/library';
import { formatBytes, refreshUsage } from '../lib/usage';
import { AlbumPicker } from './AlbumPicker';
import { useViewerHost } from './LibraryBits';

/** Keys the viewer handles. Exported for tests. */
export function viewerKey(
  key: string,
  index: number,
  count: number,
): { type: 'go'; to: number } | { type: 'info' } | { type: 'close' } | null {
  if (key === 'ArrowRight') return index >= 0 && index < count - 1 ? { type: 'go', to: index + 1 } : null;
  if (key === 'ArrowLeft') return index > 0 ? { type: 'go', to: index - 1 } : null;
  if (key === 'i' || key === 'I') return { type: 'info' };
  if (key === 'Escape') return { type: 'close' };
  return null;
}

let infoOpen = typeof matchMedia === 'function' ? !matchMedia('(max-width: 860px)').matches : true;

function settings(p: PhotoDetail | null): string | null {
  if (!p) return null;
  const m = p.metadata ?? {};
  const parts = [
    m.aperture ? `ƒ/${m.aperture}` : null,
    exposure(m.exposureSeconds),
    m.iso ? `ISO ${m.iso}` : null,
    m.focalLengthMm ? `${m.focalLengthMm} mm` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Full-screen photo viewer at /photo/:id, over the page it was opened from. */
export function Viewer({ photoId, fromGrid }: { photoId: string; fromGrid: boolean }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { list, setReturnId } = useViewerHost();
  const dialog = useRef<HTMLDialogElement>(null);
  const items = list?.items ?? [];
  const index = items.findIndex((p) => p.id === photoId);
  const item: PhotoItem | null = items[index] ?? null;
  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState(infoOpen);
  const [picker, setPicker] = useState(false);
  const [status, setStatusText] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Toasts sit behind the modal viewer, so it shows its own short confirmations.
  const setStatus = useCallback((msg: string) => {
    setStatusText(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setStatusText(''), 2600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);

  const photo: PhotoItem | null = detail?.id === photoId ? detail : item;
  const d = detail?.id === photoId ? detail : null;

  useEffect(() => {
    const c = new AbortController();
    setError(null);
    setPreviewReady(false);
    getPhoto(photoId, c.signal)
      .then((p) => {
        if (!c.signal.aborted) setDetail(p);
      })
      .catch((e) => {
        if (!c.signal.aborted && (e as Error).name !== 'AbortError') setError(errorMessage(e));
      });
    return () => c.abort();
  }, [photoId]);

  // Open as a modal (focus stays inside, the page behind is inert) and stop the page scrolling behind it.
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
      if (el?.open) el.close();
    };
  }, []);

  const close = useCallback(() => {
    setReturnId(photoId);
    if (fromGrid) nav(-1);
    else nav('/', { replace: true });
  }, [fromGrid, nav, photoId, setReturnId]);

  const go = useCallback(
    (to: number) => {
      const next = items[to];
      if (!next) return;
      nav(`/photo/${encodeURIComponent(next.id)}`, { replace: true, state: loc.state });
      if (list?.hasMore && to >= items.length - 5) list.loadMore();
    },
    [items, nav, loc.state, list],
  );

  const toggleInfo = () => {
    infoOpen = !info;
    setInfo(!info);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const a = viewerKey(e.key, index, items.length);
    if (!a) return;
    if (a.type === 'close') return; // the dialog's cancel event handles Escape
    e.preventDefault();
    if (a.type === 'go') go(a.to);
    else toggleInfo();
  };

  // Swipe left/right on touch screens.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? index + 1 : index - 1);
  };

  const favourite = async () => {
    if (!photo) return;
    setBusy('fav');
    const next = !photo.favourite;
    try {
      await patchPhoto(photo.id, { favourite: next });
      setDetail((p) => (p && p.id === photo.id ? { ...p, favourite: next } : p));
      emitLibrary({ type: 'updated', photos: [{ id: photo.id, favourite: next }] });
      setStatus(next ? 'Added to Favourites' : 'Removed from Favourites');
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const trash = async () => {
    if (!photo) return;
    setBusy('trash');
    try {
      await bulk([photo.id], 'trash');
      const neighbour = items[index + 1] ?? items[index - 1];
      emitLibrary({ type: 'removed', ids: [photo.id] });
      void refreshUsage();
      setStatus('Moved to Trash');
      if (neighbour) nav(`/photo/${encodeURIComponent(neighbour.id)}`, { replace: true, state: loc.state });
      else close();
    } catch (e) {
      setStatus(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const total = list?.total ?? (list ? `${items.length}${list.hasMore ? '+' : ''}` : null);
  const when = photo ? shortDateTime(photo.takenAt ?? photo.createdAt) : null;
  const position =
    index >= 0 && total !== null
      ? `${index + 1} of ${typeof total === 'number' ? total.toLocaleString('en') : total}`
      : null;
  const ratio = photo?.width && photo.height ? photo.width / photo.height : 3 / 2;
  const strip = index >= 0 ? items.slice(Math.max(0, index - 4), index + 5) : [];
  const md = d?.metadata ?? {};
  const camera = cameraName(md.cameraMake, md.cameraModel);
  const exif = settings(d);

  const infoRows: [string, string | null][] = [
    ['Taken', longDateTime(photo?.takenAt) ?? 'Unknown'],
    ['Camera', camera],
    ['Lens', md.lens ?? null],
    ['Settings', exif],
    [
      'Size',
      photo
        ? `${photo.width && photo.height ? `${photo.width} × ${photo.height} · ` : ''}${formatBytes(photo.sizeBytes)}`
        : null,
    ],
    ['Type', photo ? (FILE_TYPES[photo.fileType]?.label ?? photo.fileType.toUpperCase()) : null],
    ['Uploaded', photo ? relativeDateTime(photo.createdAt) : null],
  ];

  return (
    <dialog
      ref={dialog}
      className={`viewer${info ? ' viewer--info' : ''}`}
      aria-label={photo ? `Photo ${photo.filename}` : 'Photo'}
      onCancel={(e) => {
        e.preventDefault();
        if (!picker) close();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="viewer__main">
        <header className="viewer__bar">
          <button type="button" className="viewer__back" onClick={close}>
            <Icon name="chevL" size={20} />
            <span className="viewer__back-label">{list?.backLabel ?? 'Library'}</span>
          </button>
          <div className="viewer__title">
            <span className="viewer__name">{photo?.filename ?? ' '}</span>
            <span className="viewer__sub">{[position, when].filter(Boolean).join(' · ')}</span>
          </div>
          <span className="viewer__spacer" />
          <div className="viewer__actions">
            <button
              type="button"
              className="vbtn"
              aria-label={photo?.favourite ? 'Remove from Favourites' : 'Favourite'}
              aria-pressed={photo?.favourite ?? false}
              onClick={favourite}
              disabled={!photo || busy === 'fav'}
            >
              <Icon name="heart" size={19} className={photo?.favourite ? 'is-filled' : undefined} />
            </button>
            <button
              type="button"
              className="vbtn"
              aria-label="Add to album"
              onClick={() => setPicker(true)}
              disabled={!photo}
            >
              <Icon name="folder" size={19} />
            </button>
            {photo ? (
              <a
                className="vbtn"
                aria-label="Download original"
                href={originalUrl(photo.id)}
                download={photo.filename}
              >
                <Icon name="download" size={19} />
              </a>
            ) : (
              <span className="vbtn" aria-hidden="true" />
            )}
            <button
              type="button"
              className={`vbtn${info ? ' vbtn--on' : ''}`}
              aria-label={info ? 'Hide info' : 'Show info'}
              aria-pressed={info}
              aria-keyshortcuts="i"
              onClick={toggleInfo}
            >
              <Icon name="info" size={19} />
            </button>
            <button
              type="button"
              className="vbtn"
              aria-label="Move to Trash"
              onClick={trash}
              disabled={!photo || busy === 'trash'}
            >
              <Icon name="trash" size={19} />
            </button>
          </div>
          <button type="button" className="viewer__edit" disabled title="The editor arrives in phase 4">
            <Icon name="sliders" size={16} />
            Edit
            <span className="viewer__soon">Phase 4</span>
          </button>
        </header>
        <div className="viewer__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          {index > 0 && (
            <button
              type="button"
              className="viewer__nav viewer__nav--prev"
              aria-label="Previous photo"
              onClick={() => go(index - 1)}
            >
              <Icon name="chevL" size={20} />
            </button>
          )}
          {error && !photo ? (
            <div className="viewer__error" role="alert">
              <p>{error}</p>
              <button type="button" className="viewer__edit" onClick={close}>
                Back
              </button>
            </div>
          ) : photo ? (
            <div className="viewer__frame" style={{ '--r': String(ratio) } as CSSProperties}>
              {photo.hasThumb && (
                <img className="viewer__img viewer__img--thumb" src={thumbUrl(photo.id)} alt="" />
              )}
              {photo.hasPreview && (
                <img
                  key={photo.id}
                  className={`viewer__img${previewReady ? ' is-loaded' : ''}`}
                  src={previewUrl(photo.id)}
                  alt={photo.filename}
                  onLoad={() => setPreviewReady(true)}
                />
              )}
              {!photo.hasThumb && !photo.hasPreview && (
                <span className="viewer__noimg">
                  <Icon name="image" size={28} />
                  No preview for this file
                </span>
              )}
            </div>
          ) : (
            <Spinner size={22} label="Loading photo" />
          )}
          {index >= 0 && index < items.length - 1 && (
            <button
              type="button"
              className="viewer__nav viewer__nav--next"
              aria-label="Next photo"
              onClick={() => go(index + 1)}
            >
              <Icon name="chevR" size={20} />
            </button>
          )}
        </div>
        {strip.length > 1 && (
          <nav className="viewer__strip" aria-label="Nearby photos">
            {strip.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`viewer__thumb${p.id === photoId ? ' is-current' : ''}`}
                aria-label={p.filename}
                aria-current={p.id === photoId || undefined}
                onClick={() => go(items.indexOf(p))}
              >
                {p.hasThumb ? (
                  <img src={thumbUrl(p.id)} alt="" loading="lazy" />
                ) : (
                  <Icon name="image" size={14} />
                )}
              </button>
            ))}
          </nav>
        )}
        {/* Phone: settings summary and an action bar. */}
        {(camera || exif) && (
          <div className="viewer__summary">
            <span>
              <span className="viewer__dim">{camera ?? ''}</span>
              <span>{md.lens ?? ''}</span>
            </span>
            <span>
              <span className="viewer__dim">{exif ?? ''}</span>
              <span>{photo ? formatBytes(photo.sizeBytes) : ''}</span>
            </span>
          </div>
        )}
        <nav className="viewer__tabs" aria-label="Photo actions">
          <button type="button" disabled title="Coming soon">
            <Icon name="share" size={22} />
            Share
          </button>
          <button
            type="button"
            onClick={favourite}
            disabled={!photo}
            aria-pressed={photo?.favourite ?? false}
          >
            <Icon name="heart" size={22} className={photo?.favourite ? 'is-filled' : undefined} />
            Favourite
          </button>
          <button type="button" onClick={toggleInfo} aria-pressed={info}>
            <Icon name="info" size={22} />
            Info
          </button>
          <button type="button" onClick={() => setPicker(true)} disabled={!photo}>
            <Icon name="folder" size={22} />
            Album
          </button>
          <button type="button" onClick={trash} disabled={!photo}>
            <Icon name="trash" size={22} />
            Delete
          </button>
        </nav>
      </div>
      {info && (
        <aside className="viewer__info" aria-label="Photo info">
          <div className="viewer__info-head">
            <h2>Info</h2>
            <button
              type="button"
              className="vbtn viewer__info-close"
              aria-label="Hide info"
              onClick={toggleInfo}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
          <dl className="viewer__dl">
            {infoRows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          <div className="viewer__albums">
            <span className="viewer__eyebrow">Albums</span>
            {d ? (
              d.albums.length ? (
                <ul>
                  {d.albums.map((a) => (
                    <li key={a.id} className="viewer__chip">
                      <Icon name="folder" size={13} />
                      {a.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="viewer__dim">Not in an album</span>
              )
            ) : (
              <span className="viewer__dim">…</span>
            )}
          </div>
          <p className="viewer__note">
            Location data stays inside your original file. Zephyr doesn’t read or show it.
          </p>
        </aside>
      )}
      <p className={`viewer__flash${status ? ' is-on' : ''}`} role="status" aria-live="polite">
        {status}
      </p>
      {photo && (
        <AlbumPicker
          open={picker}
          photoIds={[photo.id]}
          onClose={() => setPicker(false)}
          onDone={(a) => {
            setStatus(`Added to ${a.name}`);
            getPhoto(photo.id)
              .then(setDetail)
              .catch(() => {});
          }}
        />
      )}
    </dialog>
  );
}
