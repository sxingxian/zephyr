import { Spinner } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { safeReturnPath } from '../lib/returnPath';
import { useSession } from '../lib/session';

function Loading() {
  return (
    <div className="loading">
      <Spinner size={22} label="Loading" />
    </div>
  );
}

/** Pages for signed-in members. Others go to sign-in, remembering where they were headed. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const loc = useLocation();
  if (user === undefined) return <Loading />;
  if (!user) {
    const next = safeReturnPath(`${loc.pathname}${loc.search}`);
    return <Navigate to={next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Sign-in and sign-up pages. Signed-in members skip straight to where they were going. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [params] = useSearchParams();
  if (user === undefined) return <Loading />;
  if (user) return <Navigate to={safeReturnPath(params.get('next'))} replace />;
  return <>{children}</>;
}
