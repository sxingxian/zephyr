import { Spinner } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { safeReturnPath } from '../lib/returnPath';
import { useSession } from '../lib/session';
import { AccountScheduled } from '../routes/AccountScheduled';

function Loading() {
  return (
    <div className="loading">
      <Spinner size={22} label="Loading" />
    </div>
  );
}

/**
 * Pages for signed-in members. Others go to sign-in, remembering where they were headed. Accounts scheduled
 * for deletion see the Restore screen instead.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const loc = useLocation();
  if (user === undefined) return <Loading />;
  if (!user) {
    const next = safeReturnPath(`${loc.pathname}${loc.search}`);
    return <Navigate to={next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`} replace />;
  }
  // While the account is scheduled for deletion, every signed-in page is the Restore screen.
  if (user.pendingDeletion) return <AccountScheduled purgeAt={user.pendingDeletion.purgeAt} />;
  return <>{children}</>;
}

/** Sign-in and sign-up pages. Signed-in members skip straight to where they were going (unless re-authenticating). */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [params] = useSearchParams();
  if (user === undefined) return <Loading />;
  // `reauth=1`: a signed-in member was asked to sign in again (recent sign-in needed for passkeys or deleting
  // the account), so show the form instead of bouncing them straight back.
  if (user && params.get('reauth') !== '1')
    return <Navigate to={safeReturnPath(params.get('next'))} replace />;
  return <>{children}</>;
}
