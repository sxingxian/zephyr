import { Button, Icon, type IconName } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PLAN_NAME } from '../lib/billing';
import { shortDate } from '../lib/format';
import { switchLibrary, useActiveLibrary, useLibraries } from '../lib/libraryContext';
import { useSession } from '../lib/session';
import { formatBytes, useUsage } from '../lib/usage';

/** Full-width notice at the top of a page (read-only library, Viewer, payment due). */
export function Banner({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: 'acc' | 'warn' | 'bad';
  icon: IconName;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`bl-banner bl-banner--${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <span className="bl-banner__icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="bl-banner__text">
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
      {actions && <div className="bl-banner__actions">{actions}</div>}
    </div>
  );
}

/**
 * Phase 7 notices for the library pages:
 * - a read-only library (over its plan's storage after a lapse or downgrade);
 * - a Viewer in a team library.
 */
export function LibraryBanner() {
  const lib = useActiveLibrary();
  const libs = useLibraries();
  const usage = useUsage();
  const own = libs?.[0];
  const name = lib.summary?.name ?? 'This library';
  if (lib.state === 'read_only') {
    const figures =
      usage && usage.limitBytes > 0
        ? `${lib.self ? 'You use' : `${name} uses`} ${formatBytes(usage.usedBytes)} and ${PLAN_NAME[usage.plan]} includes ${formatBytes(usage.limitBytes)}, so `
        : '';
    return (
      <Banner
        tone="warn"
        icon="lock"
        title={lib.self ? 'Your library is read-only' : `${name} is read-only`}
        actions={
          lib.self ? (
            <>
              <Link to="/plans" className="z-btn z-btn--primary z-btn--sm">
                <span>See plans</span>
              </Link>
              <Link to="/settings/billing" className="z-btn z-btn--ghost z-btn--sm">
                <span>Plan &amp; billing</span>
              </Link>
            </>
          ) : undefined
        }
      >
        {figures ? figures : 'It’s over its plan’s storage, so '}
        {lib.self ? 'you' : 'the team'} can view, download, share existing galleries and delete photos, but
        not upload or edit. Nothing is deleted.
        {lib.self ? '' : ' Ask the owner to renew the plan or free up space.'}
      </Banner>
    );
  }
  if (!lib.self && lib.role === 'viewer' && !lib.pending) {
    return (
      <Banner
        tone="acc"
        icon="eye"
        title={`You’re viewing ${name}`}
        actions={
          own ? (
            <Button size="sm" onClick={() => void switchLibrary(own.ownerId)}>
              Switch to your library
            </Button>
          ) : undefined
        }
      >
        As a Viewer you can browse and download. Ask the library’s owner if you need to upload or edit.
      </Banner>
    );
  }
  return null;
}

/** Phase 8: `/me` (the session user) carries the last retention batch of the member's own library. */
export interface RetentionNotice {
  trashedAt: string;
  photos: number;
  restoreBy: string;
}
export function retentionOf(user: unknown): RetentionNotice | null {
  const r = (user as { retention?: RetentionNotice | null } | null | undefined)?.retention;
  if (!r || typeof r.photos !== 'number' || r.photos <= 0 || typeof r.restoreBy !== 'string') return null;
  const by = new Date(r.restoreBy).getTime();
  return Number.isNaN(by) || by <= Date.now() ? null : r;
}

/**
 * Phase 8: after a year over the Free storage, the oldest photos beyond it went to Trash (30 days to restore).
 * Shown on the member's own library only.
 */
export function RetentionBanner() {
  const { user } = useSession();
  const libs = useLibraries();
  const lib = useActiveLibrary();
  // Only once the library list has loaded and confirms the open library is the member's own: until the session id
  // is known, a tab opened on a team library briefly looks like the member's own.
  const r =
    libs && lib.self && user && lib.ownerId === (user as { id?: string }).id ? retentionOf(user) : null;
  if (!r) return null;
  const n = r.photos.toLocaleString('en-GB');
  return (
    <Banner
      tone="warn"
      icon="trash"
      title={`${n} of your oldest photo${r.photos === 1 ? ' was' : 's were'} moved to Trash`}
      actions={
        <>
          <Link to="/trash" className="z-btn z-btn--secondary z-btn--sm">
            <span>Open Trash</span>
          </Link>
          <Link to="/plans" className="z-btn z-btn--primary z-btn--sm">
            <span>Upgrade to Pro</span>
          </Link>
        </>
      }
    >
      Your library stayed over the Free plan’s storage for a year after your paid plan ended. Restore anything
      by {shortDate(r.restoreBy)}, or upgrade to keep everything.
    </Banner>
  );
}
