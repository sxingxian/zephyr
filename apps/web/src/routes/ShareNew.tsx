import { buttonClass } from '@zephyr/ui';
import { useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { Shell } from '../components/Shell';
import { ShNote } from '../components/share/ShareBits';
import { useShareGallery } from '../components/share/ShareDialogs';
import { useCan } from '../lib/libraryContext';
import { SHARE_HANDOFF_PATH, type ShareHandoff, takeShareHandoff } from '../lib/shareHandoff';

/** Read once per page load (this page is always opened with a full page load). */
let taken: { value: ShareHandoff | null } | null = null;
function handoff(): ShareHandoff | null {
  taken ??= { value: takeShareHandoff() };
  return taken.value;
}
/** Test helper. */
export function __resetShareNewForTest(): void {
  taken = null;
}

/**
 * Phase 8: Share, continued from a page that held Google's AdSense script. Opened with a full page load (so the
 * script is gone) on a page without ads; the create dialog, and the new link and passcode, appear only here.
 */
export function ShareNewPage() {
  const canShare = useCan('galleries');
  const nav = useNavigate();
  // When the dialogs close, go to the galleries list (unless a dialog button already went somewhere else).
  const onDone = useCallback(() => {
    queueMicrotask(() => {
      if (window.location.pathname === SHARE_HANDOFF_PATH) nav('/shared', { replace: true });
    });
  }, [nav]);
  const sharing = useShareGallery({ onDone });
  const h = canShare ? handoff() : null;
  const opened = useRef(false);
  const { open } = sharing;
  useEffect(() => {
    if (!h || opened.current) return;
    opened.current = true;
    open(h.ids, h.name);
  }, [h, open]);
  return (
    <Shell title="Share photos">
      {h ? (
        <ShNote icon="lock">
          Choose how guests see these photos. The link and passcode appear on this page only.
        </ShNote>
      ) : (
        <div className="stack">
          <ShNote icon="info">
            There’s nothing to share here. Select photos in your library and choose Share.
          </ShNote>
          <Link to="/" className={buttonClass({ kind: 'primary' })}>
            Back to your library
          </Link>
        </div>
      )}
      {sharing.dialogs}
    </Shell>
  );
}
