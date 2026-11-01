import type { AiSpendToday } from '@zephyr/shared/client';
import { Chip, Icon } from '@zephyr/ui';
import { formatUsd, spendPct, spendTone } from '../lib/ai';

/** One spend bar with marks at the 50 % and 80 % alerts. */
export function SpendBar({ label, spent, cap }: { label: string; spent: number; cap: number | null }) {
  const pct = cap === null ? 0 : spendPct(spent, cap);
  const tone = spendTone(pct);
  return (
    <div className="spend">
      <div className="spend__head">
        <span className="spend__label">{label}</span>
        <span className="z-mono spend__value">
          {formatUsd(spent)}
          {cap !== null && ` of ${formatUsd(cap)}`}
        </span>
      </div>
      {cap !== null && (
        <div
          className="spend__track"
          role="progressbar"
          aria-label={`${label} spend today`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}% of the daily cap`}
        >
          <span className={`spend__fill spend__fill--${tone}`} style={{ width: `${pct}%` }} />
          <span className="spend__mark" style={{ left: '50%' }} aria-hidden="true" />
          <span className="spend__mark" style={{ left: '80%' }} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

/** Today's spend against the caps (caps omitted when unknown). */
export function SpendToday({
  spend,
  caps,
}: {
  spend: AiSpendToday;
  caps: { total: number; bgRemoval: number; sceneTags: number } | null;
}) {
  return (
    <div className="stack">
      <SpendBar label="All providers" spent={spend.totalUsd} cap={caps?.total ?? null} />
      <SpendBar label="Background removal" spent={spend.bgRemovalUsd} cap={caps?.bgRemoval ?? null} />
      <SpendBar label="Scene tags (Workers AI)" spent={spend.sceneTagsUsd} cap={caps?.sceneTags ?? null} />
      <span className="z-hint">
        {caps ? 'Lines mark the 50% and 80% alerts. ' : ''}
        {spend.credits.toLocaleString('en-GB')} credits spent on {spend.photos.toLocaleString('en-GB')} photos
        today.
      </span>
      {spend.capped && (
        <Chip tone="warn" icon="pause">
          A cap was reached · cloud work waits until 00:00 UTC
        </Chip>
      )}
    </div>
  );
}

export function WhereChip({ cloud }: { cloud: boolean }) {
  return (
    <Chip tone={cloud ? 'acc' : 'good'} icon={cloud ? 'cpu' : 'phone'} size="sm">
      {cloud ? 'Cloud · costs you' : 'On device · free'}
    </Chip>
  );
}

export function ReadOnlyChip() {
  return (
    <Chip tone="outline" icon="eye">
      Read-only for your role
    </Chip>
  );
}

export function ResetsChip() {
  return (
    <span className="resets">
      <Icon name="clock" size={14} />
      Resets 00:00 UTC
    </span>
  );
}
