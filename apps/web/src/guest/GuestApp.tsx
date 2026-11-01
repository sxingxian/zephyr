import type { GuestGalleryInfo } from '@zephyr/shared/client';
import { Spinner } from '@zephyr/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GuestApiError, getInfo, getPhotos } from './api';
import { BadLink, Ended, LoadFailed } from './Ended';
import { Gallery } from './Gallery';
import { Passcode, Paused } from './Passcode';
import { ReportProvider } from './Report';
import { type GuestRoute, parseGuestPath } from './route';

type View =
  | { kind: 'loading' }
  | { kind: 'bad' }
  | { kind: 'failed' }
  | { kind: 'info'; info: GuestGalleryInfo }
  | { kind: 'paused'; info: GuestGalleryInfo; until: number };

const PAUSE_FALLBACK_MS = 15 * 60_000;

export function GuestApp({ pathname, now = Date.now }: { pathname: string; now?: () => number }) {
  const route: GuestRoute = useMemo(() => parseGuestPath(pathname), [pathname]);
  const [view, setView] = useState<View>(route.kind === 'bad' ? { kind: 'bad' } : { kind: 'loading' });

  const load = useCallback(async () => {
    if (route.kind === 'bad') return;
    try {
      const info = await getInfo(route);
      if (info.state === 'paused') {
        const until = info.pausedUntil ? Date.parse(info.pausedUntil) : NaN;
        setView({ kind: 'paused', info, until: Number.isFinite(until) ? until : now() + PAUSE_FALLBACK_MS });
      } else setView({ kind: 'info', info });
    } catch (e) {
      setView(
        e instanceof GuestApiError && (e.status === 404 || e.status === 410)
          ? { kind: 'bad' }
          : { kind: 'failed' },
      );
    }
  }, [route, now]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view.kind === 'info' || view.kind === 'paused') {
      document.title = `${view.info.name} · ${view.info.brand.studioName}`;
    } else if (view.kind === 'bad') document.title = 'Link not working';
  }, [view]);

  const fetchPage = useCallback(
    (cursor: string | null) =>
      route.kind === 'bad' ? Promise.reject(new Error('bad')) : getPhotos(route, cursor),
    [route],
  );

  const content = (() => {
    if (view.kind === 'loading')
      return (
        <div className="g-loading">
          <Spinner size={24} label="Opening the gallery" />
        </div>
      );
    if (view.kind === 'bad') return <BadLink />;
    if (view.kind === 'failed') return <LoadFailed onRetry={() => void load()} />;
    if (view.kind === 'paused')
      return <Paused info={view.info} until={view.until} onDone={() => void load()} now={now} />;
    const { info } = view;
    if (info.state === 'ended') return <Ended info={info} />;
    if (info.state === 'locked' && route.kind === 'token')
      return (
        <Passcode
          token={route.token}
          info={info}
          onUnlocked={() => void load()}
          onPaused={(until) => setView({ kind: 'paused', info, until })}
          now={now}
        />
      );
    return (
      <Gallery
        info={info}
        token={route.kind === 'token' ? route.token : null}
        preview={route.kind === 'preview'}
        fetchPage={fetchPage}
        onLocked={() => void load()}
      />
    );
  })();
  // Guests can report a live gallery (locked or open) by its link; not the owner's preview, not ended links.
  const reportable =
    route.kind === 'token' &&
    (view.kind === 'paused' || (view.kind === 'info' && view.info.state !== 'ended'));
  return (
    <ReportProvider token={reportable && route.kind === 'token' ? route.token : null}>
      {content}
    </ReportProvider>
  );
}
