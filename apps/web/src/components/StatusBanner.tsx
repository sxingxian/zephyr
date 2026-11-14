import { useAppStatus } from '../lib/appStatus';
import { shortDateTime } from '../lib/format';
import { Banner } from './LibraryBanner';

const READ_ONLY_DEFAULT = 'Uploads, edits and Zephyr AI are paused for a little while. Your photos are safe.';

/**
 * Phase 8: Zephyr-wide notices at the top of every signed-in page: read-only mode (set in Admin, or by itself
 * when the photo store stops answering) and a maintenance notice.
 */
export function StatusBanner() {
  const { readOnly, maintenance } = useAppStatus();
  return (
    <>
      {readOnly?.on && (
        <Banner tone="warn" icon="pause" title="Zephyr is read-only right now">
          {readOnly.message || READ_ONLY_DEFAULT} You can still view, download and share existing galleries.
        </Banner>
      )}
      {maintenance && (
        <Banner tone="acc" icon="info" title="Planned maintenance">
          {maintenance.message}
          {noticeWindow(maintenance.startsAt, maintenance.endsAt)}
        </Banner>
      )}
    </>
  );
}

function noticeWindow(startsAt: string | null, endsAt: string | null): string {
  const from = shortDateTime(startsAt);
  const to = shortDateTime(endsAt);
  if (from && to) return ` From ${from} to ${to}.`;
  if (from) return ` Starts ${from}.`;
  if (to) return ` Until ${to}.`;
  return '';
}
