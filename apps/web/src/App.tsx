import { Spinner, ToastProvider } from '@zephyr/ui';
import { lazy, Suspense, useCallback } from 'react';
import { createBrowserRouter, Outlet, type RouteObject, useLocation, useNavigate } from 'react-router';
import { AiHost } from './components/ai/AiHost';
import { EditTray } from './components/editor/EditTray';
import { PublicOnly, RequireAuth } from './components/Guards';
import { LibraryHost } from './components/LibraryHost';
import { ShareTray } from './components/share/ShareTray';
import { UploadProvider } from './components/Uploads';
import { safeReturnPath } from './lib/returnPath';
import { SessionProvider, useSession } from './lib/session';
import { About } from './routes/About';
import { AccountDeleted } from './routes/AccountScheduled';
import { AlbumsPage } from './routes/Albums';
import { GalleriesPage } from './routes/Galleries';
import { GalleryPage } from './routes/Gallery';
import { InviteFriends } from './routes/Invites';
import { Join } from './routes/Join';
import { NotFound } from './routes/NotFound';
import { Security } from './routes/Security';
import { SharingSettings } from './routes/SharingSettings';
import { SignIn } from './routes/SignIn';
import { SignInCode } from './routes/SignInCode';
import { SignUp } from './routes/SignUp';
import { TrashPage } from './routes/Trash';
import { WelcomePasskey } from './routes/WelcomePasskey';
import './lib/editor';
import { You } from './routes/You';

/** Uploads (picker, drag & drop, tray) for signed-in members, kept mounted across pages. */
function Uploads({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const on = Boolean(user && !user.pendingDeletion);
  return (
    <UploadProvider enabled={on}>
      {children}
      {on && <AiHost />}
      {on && <EditTray />}
      {on && <ShareTray />}
    </UploadProvider>
  );
}

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
        <Uploads>
          <Outlet />
        </Uploads>
      </ToastProvider>
    </SessionProvider>
  );
}

// Phase 6 pages are their own chunks.
const AiQueuePage = lazy(() => import('./routes/AiQueue').then((m) => ({ default: m.AiQueuePage })));
const AiSettingsPage = lazy(() => import('./routes/AiSettings').then((m) => ({ default: m.AiSettingsPage })));
const CleanupPage = lazy(() => import('./routes/Cleanup').then((m) => ({ default: m.CleanupPage })));
const PeoplePage = lazy(() => import('./routes/People').then((m) => ({ default: m.PeoplePage })));
const ScenesPage = lazy(() => import('./routes/Scenes').then((m) => ({ default: m.ScenesPage })));
const page = (el: React.ReactNode) => (
  <Suspense
    fallback={
      <div className="page-loading">
        <Spinner size={22} label="Loading" />
      </div>
    }
  >
    {el}
  </Suspense>
);

const pub = (el: React.ReactNode) => <PublicOnly>{el}</PublicOnly>;
const auth = (el: React.ReactNode) => <RequireAuth>{el}</RequireAuth>;

export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      {
        // Grid pages and the photo viewer share one host, so opening a photo keeps the grid underneath.
        element: auth(<LibraryHost />),
        children: [
          { path: '/', element: null },
          { path: '/favourites', element: null },
          { path: '/albums/:albumId', element: null },
          { path: '/photo/:photoId', element: null },
          { path: '/edit/:photoId', element: null },
          // Phase 6: one person's and one scene's photos open the viewer on top, like the library.
          { path: '/people/:personId', element: null },
          { path: '/scenes/:scene', element: null },
        ],
      },
      { path: '/people', element: auth(page(<PeoplePage />)) },
      { path: '/scenes', element: auth(page(<ScenesPage />)) },
      { path: '/cleanup', element: auth(page(<CleanupPage />)) },
      { path: '/ai/queue', element: auth(page(<AiQueuePage />)) },
      { path: '/settings/ai', element: auth(page(<AiSettingsPage />)) },
      { path: '/albums', element: auth(<AlbumsPage />) },
      { path: '/trash', element: auth(<TrashPage />) },
      { path: '/shared', element: auth(<GalleriesPage />) },
      { path: '/shared/:galleryId', element: auth(<GalleryPage />) },
      { path: '/shared/:galleryId/:tab', element: auth(<GalleryPage />) },
      { path: '/account-deleted', element: <AccountDeleted /> },
      { path: '/sign-in', element: pub(<SignIn />) },
      { path: '/sign-in/code', element: pub(<SignInCode />) },
      { path: '/sign-up', element: pub(<SignUp />) },
      // Opening an invite works whether or not someone is signed in on this device.
      { path: '/join', element: <Join /> },
      { path: '/welcome/passkey', element: auth(<WelcomePasskey />) },
      { path: '/settings', element: auth(<Security />) },
      { path: '/settings/security', element: auth(<Security />) },
      { path: '/settings/invites', element: auth(<InviteFriends />) },
      { path: '/settings/sharing', element: auth(<SharingSettings />) },
      { path: '/settings/about', element: auth(<About />) },
      { path: '/you', element: auth(<You />) },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
