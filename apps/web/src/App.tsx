import { Spinner, ToastProvider, useToast } from '@zephyr/ui';
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { createBrowserRouter, Outlet, type RouteObject, useLocation, useNavigate } from 'react-router';
import { AdsBoot, AdsRouteGate } from './components/ads/Ads';
import { AiHost } from './components/ai/AiHost';
import { EditTray } from './components/editor/EditTray';
import { PublicOnly, RequireAuth } from './components/Guards';
import { LibraryHost } from './components/LibraryHost';
import { ShareTray } from './components/share/ShareTray';
import { UploadProvider } from './components/Uploads';
import { useAppStatusPolling } from './lib/appStatus';
import { refreshLibraries, takeLibraryNotice, useCan } from './lib/libraryContext';
import { safeReturnPath } from './lib/returnPath';
import { SessionProvider, useSession } from './lib/session';
import { browser, onOtherTabLibrariesChange } from './lib/sessionGuard';
import { About } from './routes/About';
import { AccountActionPage } from './routes/AccountAction';
import { AccountDeleted } from './routes/AccountScheduled';
import { AlbumsPage } from './routes/Albums';
import { GalleriesPage } from './routes/Galleries';
import { GalleryPage } from './routes/Gallery';
import { InviteFriends } from './routes/Invites';
import { Join } from './routes/Join';
import { NotFound } from './routes/NotFound';
import { Security } from './routes/Security';
import { ShareNewPage } from './routes/ShareNew';
import { SharingSettings } from './routes/SharingSettings';
import { SignIn } from './routes/SignIn';
import { SignInCode } from './routes/SignInCode';
import { SignUp } from './routes/SignUp';
import { SuspendedPage } from './routes/Suspended';
import { TrashPage } from './routes/Trash';
import { WelcomePasskey } from './routes/WelcomePasskey';
import './lib/editor';
import { You } from './routes/You';

/** Uploads (picker, drag & drop, tray) for signed-in members, kept mounted across pages. */
function Uploads({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const on = Boolean(user && !user.pendingDeletion);
  // Phase 7: no picker or drop zone where the member's role (Viewer) or a read-only library forbids uploads.
  const canUpload = useCan('upload');
  return (
    <UploadProvider enabled={on && canUpload}>
      {children}
      {on && <AiHost />}
      {on && <EditTray />}
      {on && <ShareTray />}
    </UploadProvider>
  );
}

/**
 * Phase 7: loads the member's libraries once signed in (validating the team library this tab has open), and
 * shows the notice left by a fall-back to the member's own library.
 */
function LibraryBoot() {
  const { user } = useSession();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const id = user && !user.pendingDeletion ? user.id : null;
  // Phase 8: another tab joined or left a team: re-read the libraries here too.
  useEffect(() => (id ? onOtherTabLibrariesChange(() => void refreshLibraries()) : undefined), [id]);
  useEffect(() => {
    if (!id) return;
    void refreshLibraries();
    if (takeLibraryNotice() === 'unavailable')
      toastRef.current.show(
        'You no longer have access to that team library. You’re back in your own library.',
        'bad',
      );
  }, [id]);
  return null;
}

function Root() {
  // Phase 8: read-only mode and the maintenance notice, for everyone (no session needed).
  useAppStatusPolling();
  const nav = useNavigate();
  const loc = useLocation();
  // A 401 from any call (or a session found ended): back to sign-in, remembering where the visitor was. A full
  // page load (phase 8), so nothing from the ended session stays in memory: photo data, or Google's AdSense
  // script, which would otherwise watch the sign-in form and carry over into the next member's session.
  const onUnauthenticated = useCallback(() => {
    const next = safeReturnPath(`${loc.pathname}${loc.search}`);
    const to = next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`;
    if (loc.pathname.startsWith('/sign-in')) nav(to, { replace: true });
    else browser.assign(to, { sessionEnd: true });
  }, [nav, loc.pathname, loc.search]);
  return (
    <SessionProvider onUnauthenticated={onUnauthenticated}>
      <ToastProvider>
        <LibraryBoot />
        <AdsBoot />
        <Uploads>
          <AdsRouteGate>
            <Outlet />
          </AdsRouteGate>
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
// Phase 7: billing and teams.
const PlansPage = lazy(() => import('./routes/Plans').then((m) => ({ default: m.PlansPage })));
const BillingPage = lazy(() => import('./routes/Billing').then((m) => ({ default: m.BillingPage })));
const BillingReturnPage = lazy(() =>
  import('./routes/BillingReturn').then((m) => ({ default: m.BillingReturnPage })),
);
const TeamPage = lazy(() => import('./routes/Team').then((m) => ({ default: m.TeamPage })));
const TeamAcceptPage = lazy(() => import('./routes/TeamAccept').then((m) => ({ default: m.TeamAcceptPage })));
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
      { path: '/plans', element: auth(page(<PlansPage />)) },
      { path: '/billing/return', element: auth(page(<BillingReturnPage />)) },
      { path: '/settings/billing', element: auth(page(<BillingPage />)) },
      { path: '/settings/team', element: auth(page(<TeamPage />)) },
      // Opening a team invite works whether or not someone is signed in on this device.
      { path: '/team/accept', element: page(<TeamAcceptPage />) },
      { path: '/albums', element: auth(<AlbumsPage />) },
      { path: '/trash', element: auth(<TrashPage />) },
      // Phase 8: Share continued from a page that held Google's AdSense script (never an ad page).
      { path: '/share/new', element: auth(<ShareNewPage />) },
      { path: '/shared', element: auth(<GalleriesPage />) },
      { path: '/shared/:galleryId', element: auth(<GalleryPage />) },
      { path: '/shared/:galleryId/:tab', element: auth(<GalleryPage />) },
      // Phase 8: the page an emailed account action link opens (passkeys, deletion). Never an ad page; it says
      // what to do when nobody, or someone else, is signed in.
      { path: '/account-action', element: <AccountActionPage /> },
      { path: '/account-deleted', element: <AccountDeleted /> },
      // Phase 8: a suspended account (from any call, sign-in included). No session by then.
      { path: '/suspended', element: <SuspendedPage /> },
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
