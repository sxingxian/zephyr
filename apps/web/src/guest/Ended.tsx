import type { GuestGalleryInfo } from '@zephyr/shared/client';
import { Mascot } from '@zephyr/ui';
import { brandingOn } from './brand';
import { accentStyle, CardScreen, formatDate, StudioBadge } from './Chrome';

/** An expired or revoked gallery. */
export function Ended({ info }: { info: GuestGalleryInfo }) {
  const branded = brandingOn(info.brand);
  const when = formatDate(info.expiresAt);
  const past = Date.parse(info.expiresAt) <= Date.now();
  return (
    <CardScreen style={accentStyle(info.brand)}>
      {branded ? (
        <StudioBadge brand={info.brand} size={88} />
      ) : (
        <Mascot
          pose="nap"
          width={170}
          tile={{ background: 'var(--m-mist, #E9EDF3)', height: 180, radius: 40 }}
        />
      )}
      <h1 className="g-card__title">This gallery has ended</h1>
      <p className="g-lede">
        {past && when
          ? `The link to “${info.name}” stopped working on ${when}.`
          : `The link to “${info.name}” has been turned off.`}{' '}
        If you still need the photos, ask {info.brand.studioName} for a new link.
      </p>
    </CardScreen>
  );
}

/** Unknown, mistyped or malformed links. Says nothing about whether a gallery ever existed. */
export function BadLink() {
  return (
    <CardScreen>
      <Mascot
        pose="ponder"
        width={170}
        tile={{ background: 'var(--m-mist, #E9EDF3)', height: 180, radius: 40 }}
      />
      <h1 className="g-card__title">This link doesn’t work</h1>
      <p className="g-lede">
        It may have been typed incorrectly, or the photographer turned it off. Ask them for a new link.
      </p>
    </CardScreen>
  );
}

/** Something went wrong loading the page (offline, server error). */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <CardScreen>
      <Mascot
        pose="ponder"
        width={150}
        tile={{ background: 'var(--m-mist, #E9EDF3)', height: 160, radius: 36 }}
      />
      <h1 className="g-card__title">The gallery didn’t load</h1>
      <p className="g-lede">Check your connection, then try again.</p>
      <button type="button" className="z-btn z-btn--primary z-btn--lg g-acc-btn" onClick={onRetry}>
        <span>Try again</span>
      </button>
    </CardScreen>
  );
}
