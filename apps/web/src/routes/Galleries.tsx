import type { GallerySummary } from '@zephyr/shared/client';
import { buttonClass, Icon, Mascot, Note } from '@zephyr/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Segmented } from '../components/LibraryBits';
import { Shell } from '../components/Shell';
import { photosLabel, ShNote, StatusChip } from '../components/share/ShareBits';
import { errorMessage } from '../lib/api';
import { thumbUrl } from '../lib/library';
import { useCan } from '../lib/libraryContext';
import { listGalleries } from '../lib/share';
import { shareRenders } from '../lib/shareRenders';
import { EmptyHint, GridSkeleton } from './Library';

type Filter = 'all' | 'live' | 'ended';

function stats(g: GallerySummary): string {
  if (g.status === 'paused' && g.pausedUntil) {
    const m = Math.max(1, Math.ceil((Date.parse(g.pausedUntil) - Date.now()) / 60_000));
    return `Reopens in ${m} min`;
  }
  if (g.status === 'revoked') return '—';
  const parts = [`${g.views.toLocaleString('en')} view${g.views === 1 ? '' : 's'}`];
  if (g.favourites) parts.push(`${g.favourites} favourite${g.favourites === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Shared galleries: every link the member has made, live or ended. */
export function GalleriesPage() {
  const canManage = useCan('galleries');
  const [items, setItems] = useState<GallerySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the load (Try again)
  useEffect(() => {
    const c = new AbortController();
    setError(null);
    listGalleries(c.signal)
      .then((g) => {
        setItems(g);
        // Full-size renders left unfinished on an earlier visit carry on now.
        void shareRenders.resume(g);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(errorMessage(e));
      });
    return () => c.abort();
  }, [tick]);

  const shown = useMemo(
    () =>
      (items ?? []).filter((g) =>
        filter === 'all'
          ? true
          : filter === 'live'
            ? g.status === 'live' || g.status === 'paused'
            : g.status === 'expired' || g.status === 'revoked',
      ),
    [items, filter],
  );
  const live = (items ?? []).filter((g) => g.status === 'live' || g.status === 'paused').length;

  let body: ReactNode;
  if (error)
    body = (
      <Note tone="bad" icon="alert" role="alert">
        {error}{' '}
        <button type="button" className="text-link" onClick={() => setTick((t) => t + 1)}>
          Try again
        </button>
      </Note>
    );
  else if (!items) body = <GridSkeleton />;
  else if (!items.length)
    body = (
      <EmptyHint
        icon={
          <Mascot pose="hold" width={150} tile={{ background: 'var(--accTint)', height: 170, radius: 28 }} />
        }
        title="No shared galleries yet"
      >
        Select photos in your library and choose Share. Guests get a private link, and a passcode if you want
        one.
        <span className="sh-empty-cta">
          <Link to="/" className={buttonClass({ kind: 'primary' })}>
            <Icon name="library" size={17} />
            <span>Go to library</span>
          </Link>
        </span>
      </EmptyHint>
    );
  else
    body = (
      <>
        <ul className="sh-list" aria-label="Shared galleries">
          {shown.map((g) => (
            <li key={g.id}>
              <Link to={`/shared/${encodeURIComponent(g.id)}`} className="sh-list__row">
                <span className="sh-list__cover">
                  {g.coverPhotoId ? (
                    <img src={thumbUrl(g.coverPhotoId)} alt="" loading="lazy" />
                  ) : (
                    <Icon name="image" size={20} />
                  )}
                </span>
                <span className="sh-list__text">
                  <strong>{g.name}</strong>
                  <span>
                    {photosLabel(g.photoCount)} · {g.passcode ? 'passcode' : 'link only'}
                  </span>
                </span>
                <span className="sh-list__status">
                  <StatusChip g={g} compact />
                </span>
                <span className="sh-list__stats">{stats(g)}</span>
                <Icon name="chevR" size={16} />
              </Link>
            </li>
          ))}
          {!shown.length && <li className="sh-list__none">No galleries here.</li>}
        </ul>
        <ShNote icon="shield">
          Every gallery link is long and unguessable. Wrong passcodes are limited to 5 per 15 minutes from one
          network, and a gallery pauses for 15 minutes after 25 wrong tries from anywhere. We email you when
          that happens.
        </ShNote>
      </>
    );

  return (
    <Shell title="Shared galleries">
      <div className="sh-page">
        {!canManage && (
          <Note tone="neutral" icon="lock">
            You can open and copy gallery links. The library’s Owner and Editors create and change galleries.
          </Note>
        )}
        {items && items.length > 0 && (
          <div className="sh-head">
            <h2 className="sh-h2">Shared galleries</h2>
            <span className="sh-muted">
              {items.length} {items.length === 1 ? 'gallery' : 'galleries'} · {live} live
            </span>
            <span className="sh-grow" />
            <Segmented
              label="Filter galleries"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'live', label: 'Live' },
                { value: 'ended', label: 'Ended' },
              ]}
            />
          </div>
        )}
        {body}
      </div>
    </Shell>
  );
}
