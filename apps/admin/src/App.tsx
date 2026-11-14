import { Spinner, ToastProvider } from '@zephyr/ui';
import { lazy, type ReactNode, Suspense, useCallback } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject, useNavigate } from 'react-router';
import { AdminSessionProvider, useAdminSession } from './lib/session';
import { AiControls } from './routes/AiControls';
import { AiJobs } from './routes/AiJobs';
import { Billing } from './routes/Billing';
import { Enrol } from './routes/Enrol';
import { SignIn } from './routes/SignIn';
import { Signups } from './routes/Signups';
import { StaffInvite } from './routes/StaffInvite';

// Phase 8 pages load on first visit, so sign-in and the older pages stay small.
const Ads = lazy(() => import('./routes/Ads').then((m) => ({ default: m.Ads })));
const Audit = lazy(() => import('./routes/Audit').then((m) => ({ default: m.Audit })));
const Limits = lazy(() => import('./routes/Limits').then((m) => ({ default: m.Limits })));
const Retention = lazy(() => import('./routes/Retention').then((m) => ({ default: m.Retention })));
const Safety = lazy(() => import('./routes/Safety').then((m) => ({ default: m.Safety })));
const Settings = lazy(() => import('./routes/Settings').then((m) => ({ default: m.Settings })));
const Staff = lazy(() => import('./routes/Staff').then((m) => ({ default: m.Staff })));
const Storage = lazy(() => import('./routes/Storage').then((m) => ({ default: m.Storage })));
const Users = lazy(() => import('./routes/Users').then((m) => ({ default: m.Users })));

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
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
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
      {
        path: '/users',
        element: (
          <RequireStaff>
            <Users />
          </RequireStaff>
        ),
      },
      {
        path: '/safety',
        element: (
          <RequireStaff>
            <Safety />
          </RequireStaff>
        ),
      },
      {
        path: '/limits',
        element: (
          <RequireStaff>
            <Limits />
          </RequireStaff>
        ),
      },
      {
        path: '/ads',
        element: (
          <RequireStaff>
            <Ads />
          </RequireStaff>
        ),
      },
      {
        path: '/storage',
        element: (
          <RequireStaff>
            <Storage />
          </RequireStaff>
        ),
      },
      {
        path: '/retention',
        element: (
          <RequireStaff>
            <Retention />
          </RequireStaff>
        ),
      },
      {
        path: '/audit',
        element: (
          <RequireStaff>
            <Audit />
          </RequireStaff>
        ),
      },
      {
        path: '/staff',
        element: (
          <RequireStaff>
            <Staff />
          </RequireStaff>
        ),
      },
      {
        path: '/settings',
        element: (
          <RequireStaff>
            <Settings />
          </RequireStaff>
        ),
      },
      // Public: the staff invite link (token in the fragment). It never needs a session.
      { path: '/invite', element: <StaffInvite /> },
      { path: '*', element: <Navigate to="/signups" replace /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes, { basename: '/admin' });
