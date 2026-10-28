import { ToastProvider } from '@zephyr/ui';
import { useCallback } from 'react';
import { createBrowserRouter, Outlet, type RouteObject, useLocation, useNavigate } from 'react-router';
import { PublicOnly, RequireAuth } from './components/Guards';
import { safeReturnPath } from './lib/returnPath';
import { SessionProvider } from './lib/session';
import { InviteFriends } from './routes/Invites';
import { Join } from './routes/Join';
import { Library } from './routes/Library';
import { NotFound } from './routes/NotFound';
import { Security } from './routes/Security';
import { SignIn } from './routes/SignIn';
import { SignInCode } from './routes/SignInCode';
import { SignUp } from './routes/SignUp';
import { WelcomePasskey } from './routes/WelcomePasskey';
import { You } from './routes/You';

function Root() {
  const nav = useNavigate();
  const loc = useLocation();
  // A 401 from any call: back to sign-in, remembering where the visitor was.
  const onUnauthenticated = useCallback(() => {
    const next = safeReturnPath(`${loc.pathname}${loc.search}`);
    nav(next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`, { replace: true });
  }, [nav, loc.pathname, loc.search]);
  return (
    <SessionProvider onUnauthenticated={onUnauthenticated}>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </SessionProvider>
  );
}

const pub = (el: React.ReactNode) => <PublicOnly>{el}</PublicOnly>;
const auth = (el: React.ReactNode) => <RequireAuth>{el}</RequireAuth>;

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/', element: auth(<Library />) },
      { path: '/sign-in', element: pub(<SignIn />) },
      { path: '/sign-in/code', element: pub(<SignInCode />) },
      { path: '/sign-up', element: pub(<SignUp />) },
      // Opening an invite works whether or not someone is signed in on this device.
      { path: '/join', element: <Join /> },
      { path: '/welcome/passkey', element: auth(<WelcomePasskey />) },
      { path: '/settings', element: auth(<Security />) },
      { path: '/settings/security', element: auth(<Security />) },
      { path: '/settings/invites', element: auth(<InviteFriends />) },
      { path: '/you', element: auth(<You />) },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
