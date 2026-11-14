import { Spinner, ToastProvider } from '@zephyr/ui';
import { type ReactNode, useCallback } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject, useNavigate } from 'react-router';
import { AdminSessionProvider, useAdminSession } from './lib/session';
import { AiControls } from './routes/AiControls';
import { AiJobs } from './routes/AiJobs';
import { Billing } from './routes/Billing';
import { Enrol } from './routes/Enrol';
import { SignIn } from './routes/SignIn';
import { Signups } from './routes/Signups';

function Root() {
  const nav = useNavigate();
  const onUnauthenticated = useCallback(() => nav('/sign-in', { replace: true }), [nav]);
  return (
    <AdminSessionProvider onUnauthenticated={onUnauthenticated}>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </AdminSessionProvider>
  );
}

function Loading() {
  return (
    <div className="loading">
      <Spinner size={22} label="Loading" />
    </div>
  );
}

/** Console pages: a full staff session (signed in with a passkey). */
function RequireStaff({ children }: { children: ReactNode }) {
  const { staff, enrolOnly } = useAdminSession();
  if (staff === undefined) return <Loading />;
  if (!staff) return <Navigate to="/sign-in" replace />;
  if (enrolOnly) return <Navigate to="/enrol" replace />;
  return <>{children}</>;
}

function SignedOutOnly({ children }: { children: ReactNode }) {
  const { staff, enrolOnly } = useAdminSession();
  if (staff === undefined) return <Loading />;
  if (staff && !enrolOnly) return <Navigate to="/signups" replace />;
  return <>{children}</>;
}

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/', element: <Navigate to="/signups" replace /> },
      {
        path: '/sign-in',
        element: (
          <SignedOutOnly>
            <SignIn />
          </SignedOutOnly>
        ),
      },
      {
        path: '/enrol',
        element: (
          <SignedOutOnly>
            <Enrol />
          </SignedOutOnly>
        ),
      },
      {
        path: '/signups',
        element: (
          <RequireStaff>
            <Signups />
          </RequireStaff>
        ),
      },
      {
        path: '/ai',
        element: (
          <RequireStaff>
            <AiControls />
          </RequireStaff>
        ),
      },
      {
        path: '/ai/jobs',
        element: (
          <RequireStaff>
            <AiJobs />
          </RequireStaff>
        ),
      },
      {
        path: '/billing',
        element: (
          <RequireStaff>
            <Billing />
          </RequireStaff>
        ),
      },
      { path: '*', element: <Navigate to="/signups" replace /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes, { basename: '/admin' });
