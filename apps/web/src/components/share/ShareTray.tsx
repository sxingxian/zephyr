import { Button, Chip, type ChipTone, IconButton } from '@zephyr/ui';
import { useState, useSyncExternalStore } from 'react';
import { thumbUrl } from '../../lib/library';
import { type ShareRenderState, shareRenders } from '../../lib/shareRenders';

const TONE: Record<ShareRenderState, ChipTone> = {
  pending: 'neutral',
  processing: 'acc',
  completed: 'good',
  failed: 'bad',
};
const LABEL: Record<ShareRenderState, string> = {
  pending: 'Pending',
  processing: 'Preparing',
  completed: 'Ready',
  failed: 'Failed',
};

/** Full-size downloads being prepared on this device for shared galleries. */
export function ShareTray() {
  const s = useSyncExternalStore(shareRenders.subscribe, shareRenders.getSnapshot, shareRenders.getSnapshot);
  const [min, setMin] = useState(false);
  if (!s.total) return null;
  const pct = Math.round((s.done / Math.max(1, s.total)) * 100);
  const galleries = new Set(s.items.map((i) => i.galleryName));
  const name = galleries.size === 1 ? `“${[...galleries][0]}”` : `${galleries.size} galleries`;
  const order: ShareRenderState[] = ['processing', 'failed', 'pending', 'completed'];
  const rows = [...s.items]
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
    .slice(0, min ? 0 : 30);
  return (
    <section className={`tray stray${min ? ' tray--min' : ''}`} aria-label="Preparing full-size downloads">
      <div className="tray__headrow">
        <div className="tray__head">
          <span className="tray__icon">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M12 4v11" />
              <path d="m7 10 5 5 5-5" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
          </span>
          <span className="tray__titles">
            <strong aria-live="polite">
              {s.busy ? `Preparing full size · ${s.done} of ${s.total}` : 'Full-size downloads ready'}
            </strong>
            <span>
              {s.storageFull
                ? 'Your storage is full, so the rest are waiting.'
                : s.busy
                  ? `For ${name}. Keep Zephyr open.`
                  : s.failed
                    ? `${s.failed} couldn’t be prepared`
                    : `For ${name}`}
            </span>
          </span>
        </div>
        <IconButton
          icon={min ? 'chevU' : 'chevD'}
          size="sm"
          label={min ? 'Expand' : 'Minimise'}
          onClick={() => setMin(!min)}
        />
        {!s.busy && <IconButton icon="x" size="sm" label="Close" onClick={() => shareRenders.dismiss()} />}
      </div>
      <div
        className="tray__total"
        role="progressbar"
        aria-label="Preparing full-size downloads"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      {!min && (
        <ul className="tray__list">
          {rows.map((r) => (
            <li key={r.key} className="tray__row">
              <span className="tray__thumb">
                <img src={thumbUrl(r.photoId)} alt="" loading="lazy" />
              </span>
              <span className="tray__info">
                <span className="tray__name">{r.galleryName}</span>
                {r.message && <span className="tray__status tray__status--muted">{r.message}</span>}
              </span>
              <Chip tone={TONE[r.state]} dot size="sm">
                {LABEL[r.state]}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {!min && s.failed > 0 && (
        <div className="etray__foot">
          <span />
          <Button size="sm" icon="refresh" onClick={() => shareRenders.retryFailed()}>
            Retry failed
          </Button>
        </div>
      )}
    </section>
  );
}
