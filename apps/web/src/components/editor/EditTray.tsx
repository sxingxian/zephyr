import { Button, Chip, type ChipTone, IconButton, useToast } from '@zephyr/ui';
import { useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../../lib/api';
import { type RenderState, renderQueue } from '../../lib/editor/queue';
import { thumbUrl } from '../../lib/library';

const TONE: Record<RenderState, ChipTone> = {
  pending: 'neutral',
  processing: 'acc',
  completed: 'good',
  failed: 'bad',
};
const LABEL: Record<RenderState, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

/** Batch edits (paste, apply recipe, revert): saved on the server, thumbnails updating on this device. */
export function EditTray() {
  const s = useSyncExternalStore(renderQueue.subscribe, renderQueue.getSnapshot, renderQueue.getSnapshot);
  const toast = useToast();
  const [min, setMin] = useState(false);
  const [undoing, setUndoing] = useState(false);
  if (!s.job || !s.total) return null;
  const pct = Math.round((s.done / Math.max(1, s.total)) * 100);
  const title = s.busy ? `${s.job.label} · ${s.done} of ${s.total}` : `${s.job.label} · done`;
  const order: RenderState[] = ['processing', 'failed', 'pending', 'completed'];
  const rows = [...s.items]
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
    .slice(0, min ? 0 : 40);
  const undo = async () => {
    if (!s.job?.undo) return;
    setUndoing(true);
    try {
      await s.job.undo();
      toast.show('Put the previous edits back', 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setUndoing(false);
    }
  };
  return (
    <section className={`tray etray${min ? ' tray--min' : ''}`} aria-label="Applying edits">
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
              <rect x="7" y="3" width="10" height="4" rx="1" />
              <path d="M7 5H5v16h14V5h-2" />
            </svg>
          </span>
          <span className="tray__titles">
            <strong aria-live="polite">{title}</strong>
            <span>
              {s.busy
                ? 'Edits are saved. Updating thumbnails on this device.'
                : s.failed
                  ? `${s.failed} thumbnail${s.failed === 1 ? '' : 's'} didn’t update`
                  : 'All thumbnails updated'}
            </span>
          </span>
        </div>
        <IconButton
          icon={min ? 'chevU' : 'chevD'}
          size="sm"
          label={min ? 'Expand' : 'Minimise'}
          onClick={() => setMin(!min)}
        />
        {!s.busy && <IconButton icon="x" size="sm" label="Close" onClick={() => renderQueue.dismiss()} />}
      </div>
      <div
        className="tray__total"
        role="progressbar"
        aria-label="Applying edits"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      {!min && (
        <ul className="tray__list">
          {rows.map((r) => (
            <li key={r.photoId} className="tray__row">
              <span className="tray__thumb">
                <img
                  src={thumbUrl(r.photoId, r.state === 'completed' ? r.version : undefined)}
                  alt=""
                  loading="lazy"
                />
              </span>
              <span className="tray__info">
                <span className="tray__name">{r.name}</span>
                {r.message && <span className="tray__status tray__status--muted">{r.message}</span>}
              </span>
              <Chip tone={TONE[r.state]} dot size="sm">
                {LABEL[r.state]}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {!min && (
        <div className="etray__foot">
          {s.job.undo ? (
            <Button size="sm" kind="ghost" icon="undo" busy={undoing} onClick={undo}>
              Undo paste
            </Button>
          ) : (
            <span />
          )}
          {s.failed > 0 && (
            <Button size="sm" icon="refresh" onClick={() => renderQueue.retryFailed()}>
              Retry failed
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
