import { Button, Icon, type IconName } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PLAN_NAME } from '../lib/billing';
import { switchLibrary, useActiveLibrary, useLibraries } from '../lib/libraryContext';
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
