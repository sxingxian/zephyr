import type { GalleryDownloads, GuestPhoto } from '@zephyr/shared/client';
import { Icon } from '@zephyr/ui';
import { type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { GuestImage } from './GuestImage';
import { useReport } from './Report';

export interface ViewerProps {
  photos: GuestPhoto[];
  /** Photos in the whole gallery (more pages may still be loading). */
  total: number;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  downloads: GalleryDownloads;
  favourites: boolean;
  onFavourite: (p: GuestPhoto) => void;
  /** Signed URLs expire; the grid refetches them when an image fails. */
  onImageError: () => void;
  /** Near the end of what's loaded: fetch the next page. */
  onNearEnd: () => void;
}

/**
 * Full-screen viewer on a native modal <dialog> (focus stays inside, Escape closes, the page behind is
 * inert). Arrow keys and swipes move between photos.
 */
export function Viewer(p: ViewerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const menuId = useId();
  const moreId = useId();
  const report = useReport();
  const photo = p.photos[p.index];
  const count = p.photos.length;
  const total = Math.max(p.total, count);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    return () => {
      if (d?.open) d.close();
    };
  }, []);
  useEffect(() => {
    if (p.index >= count - 3) p.onNearEnd();
    setMenu(false);
    setMore(false);
  }, [p.index, count, p.onNearEnd]);

  const go = (d: number) => {
    const n = p.index + d;
    if (n >= 0 && n < count) p.onIndex(n);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'Escape' && (menu || more)) {
      e.preventDefault();
      setMenu(false);
      setMore(false);
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };
  if (!photo) return null;
  const dl = p.downloads !== 'none' ? photo.download : undefined;

  return (
    <dialog
      ref={ref}
      className="g-viewer"
      aria-label={`Photo ${p.index + 1} of ${total}`}
      onCancel={(e) => {
        e.preventDefault();
        if (menu || more) {
          setMenu(false);
          setMore(false);
        } else p.onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <header className="g-viewer__bar">
        <button
          type="button"
          className="g-viewer__btn g-viewer__btn--icon"
          aria-label="Close"
          onClick={p.onClose}
        >
          <Icon name="x" size={18} />
        </button>
        <span className="g-viewer__count" aria-live="polite">
          {p.index + 1} of {total}
        </span>
        <span className="g-grow" />
        {p.favourites && (
          <button
            type="button"
            className={`g-viewer__btn${photo.favourite ? ' g-viewer__btn--on' : ''}`}
            aria-pressed={Boolean(photo.favourite)}
            onClick={() => p.onFavourite(photo)}
          >
            <Icon name="heart" size={16} />
            <span>Favourite</span>
          </button>
        )}
        {dl && (
          <div className="g-menu-wrap">
            <button
              type="button"
              className="g-viewer__btn"
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-controls={menu ? menuId : undefined}
              onClick={() => {
                setMore(false);
                setMenu((m) => !m);
              }}
            >
              <Icon name="download" size={16} />
              <span>Download</span>
              <Icon name="chevD" size={14} />
            </button>
            {menu && (
              <div className="g-menu" role="menu" id={menuId}>
                {p.downloads === 'full' &&
                  (dl.full ? (
                    <a
                      role="menuitem"
                      className="g-menu__item"
                      href={dl.full}
                      download
                      referrerPolicy="no-referrer"
                      onClick={() => setMenu(false)}
                    >
                      <span>Full size</span>
                      <span className="g-muted">
                        {photo.width && photo.height ? `${photo.width} × ${photo.height} · JPEG` : 'JPEG'}
                      </span>
                    </a>
                  ) : (
                    <span
                      role="menuitem"
                      aria-disabled="true"
                      tabIndex={-1}
                      className="g-menu__item g-menu__item--off"
                    >
                      <span>Full size</span>
                      <span className="g-muted">Preparing · try again in a minute</span>
                    </span>
                  ))}
                <a
                  role="menuitem"
                  className="g-menu__item"
                  href={dl.web}
                  download
                  referrerPolicy="no-referrer"
                  onClick={() => setMenu(false)}
                >
                  <span>Web size</span>
                  <span className="g-muted">Up to 2048 px · JPEG</span>
                </a>
              </div>
            )}
          </div>
        )}
        {report && (
          <div className="g-menu-wrap">
            <button
              type="button"
              className="g-viewer__btn g-viewer__btn--icon"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={more}
              aria-controls={more ? moreId : undefined}
              onClick={() => {
                setMenu(false);
                setMore((m) => !m);
              }}
            >
              <Icon name="more" size={18} />
            </button>
            {more && (
              <div className="g-menu" role="menu" id={moreId}>
                <button
                  type="button"
                  role="menuitem"
                  className="g-menu__item"
                  onClick={() => {
                    setMore(false);
                    report(photo.id);
                  }}
                >
                  <span>Report this photo</span>
                  <span className="g-muted">Tell our safety team</span>
                </button>
              </div>
            )}
          </div>
        )}
      </header>
      <div className="g-viewer__stage" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <GuestImage
          key={photo.id}
          variant="viewer"
          src={photo.view}
          alt={`Shot ${p.index + 1} of ${total}`}
          width={photo.width || undefined}
          height={photo.height || undefined}
          draggable={false}
          onExpired={p.onImageError}
        />
        <button
          type="button"
          className="g-viewer__nav g-viewer__nav--prev"
          aria-label="Previous photo"
          disabled={p.index === 0}
          onClick={() => go(-1)}
        >
          <Icon name="chevL" size={20} />
        </button>
        <button
          type="button"
          className="g-viewer__nav g-viewer__nav--next"
          aria-label="Next photo"
          disabled={p.index >= count - 1}
          onClick={() => go(1)}
        >
          <Icon name="chevR" size={20} />
        </button>
      </div>
    </dialog>
  );
}
