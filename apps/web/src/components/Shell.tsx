import { Button, Chip, Icon, type IconName, Wordmark } from '@zephyr/ui';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { useAiStatus, useRunningJobs } from '../lib/aiClient';
import { useActiveLibrary, useCan } from '../lib/libraryContext';
import { initials, useSession } from '../lib/session';
import { formatOf, useUsage } from '../lib/usage';
import { Avatar } from './Avatar';
import { CreditsMeter } from './ai/AiBits';
import { LibraryBanner } from './LibraryBanner';
import { LibrarySwitcher, PhoneLibrarySwitcher } from './LibrarySwitcher';
import '../billing.css';
import { useUploadPicker } from './Uploads';

interface NavDef {
  label: string;
  icon: IconName;
  to?: string;
  count?: 'photos';
  /** Phase 6: a Zephyr AI page, hidden while Zephyr AI is switched off for everyone. */
  ai?: boolean;
}
const LIBRARY: NavDef[] = [
  { label: 'Library', icon: 'library', to: '/', count: 'photos' },
  { label: 'Albums', icon: 'folder', to: '/albums' },
  { label: 'People', icon: 'people', to: '/people', ai: true },
  { label: 'Scenes', icon: 'pin', to: '/scenes', ai: true },
  { label: 'Favourites', icon: 'heart', to: '/favourites' },
  { label: 'Shared galleries', icon: 'share', to: '/shared' },
  { label: 'Cleanup', icon: 'sparkGrid', to: '/cleanup', ai: true },
  { label: 'Trash', icon: 'trash', to: '/trash' },
];

function Item({ d, count, chip }: { d: NavDef; count?: number; chip?: ReactNode }) {
  if (!d.to) {
    return (
      <span className="nav-item nav-item--off" aria-disabled="true">
        <Icon name={d.icon} size={18} />
        <span className="nav-item__label">{d.label}</span>
        <span className="nav-item__soon">Soon</span>
      </span>
    );
  }
  return (
    <NavLink to={d.to} end={d.to === '/'} className="nav-item">
      <Icon name={d.icon} size={18} />
      <span className="nav-item__label">{d.label}</span>
      {count !== undefined && <span className="nav-item__count">{count.toLocaleString('en')}</span>}
      {chip}
    </NavLink>
  );
}

const PLAN_LABEL = { free: 'Free plan', pro: 'Pro plan', studio: 'Studio plan' } as const;

/** Storage used (originals, previews and Trash) against the plan. */
export function StorageMeter() {
  const usage = useUsage();
  if (!usage) return <div className="meter meter--loading" aria-hidden="true" />;
  const used = usage.usedBytes + usage.reservedBytes;
  const pct = usage.limitBytes ? Math.min(100, Math.round((used / usage.limitBytes) * 100)) : 0;
  const tone = pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'acc';
  return (
    <div className="meter">
      <div className="meter__row">
        <span>Storage</span>
        <span className="meter__val">{formatOf(used, usage.limitBytes)}</span>
      </div>
      <div
        className={`meter__bar meter__bar--${tone}`}
        role="progressbar"
        aria-label="Storage used"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${formatOf(used, usage.limitBytes)} used`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Sidebar() {
  const { user } = useSession();
  const usage = useUsage();
  const ai = useAiStatus();
  const running = useRunningJobs();
  const lib = useActiveLibrary();
  // A team library shows its owner's plan (Studio); the member's own plan is on Plan & billing.
  const plan = lib.self ? (user?.plan ?? 'free') : (lib.summary?.plan ?? 'studio');
  // Zephyr AI pages show unless an admin switched Zephyr AI off for everyone.
  const aiOn = !ai || ai.enabled;
  return (
    <nav className="sidebar" aria-label="Main">
      <Link to="/" className="sidebar__brand" aria-label="Zephyr library">
        <Wordmark size={21} />
      </Link>
      <LibrarySwitcher />
      <div className="sidebar__group">
        {LIBRARY.filter((d) => aiOn || !d.ai).map((d) => (
          <Item key={d.label} d={d} count={d.count && usage ? usage.photoCount : undefined} />
        ))}
      </div>
      <div className="sidebar__group">
        <span className="sidebar__heading">Zephyr AI</span>
        {aiOn ? (
          <>
            <Item
              d={{ label: 'AI queue', icon: 'stack', to: '/ai/queue' }}
              chip={
                running > 0 ? (
                  <Chip tone="acc" size="sm">
                    {running} running
                  </Chip>
                ) : undefined
              }
            />
            <Item d={{ label: 'AI settings', icon: 'settings', to: '/settings/ai' }} />
          </>
        ) : (
          <span className="sidebar__paused">
            <Icon name="breeze" size={16} />
            Zephyr AI is paused
          </span>
        )}
      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__plan">
        <div className="sidebar__plan-row">
          <Link to="/settings/billing" className="sidebar__plan-link">
            <Chip tone={plan === 'free' ? 'neutral' : 'ink'}>{PLAN_LABEL[plan]}</Chip>
          </Link>
          <Link to="/settings/security" aria-label="Settings" className="sidebar__settings">
            <Icon name="settings" size={17} />
          </Link>
        </div>
        <StorageMeter />
        <CreditsMeter />
      </div>
    </nav>
  );
}

function Topbar({ title, actions, search }: { title: string; actions?: ReactNode; search?: ReactNode }) {
  const { user } = useSession();
  const pick = useUploadPicker();
  const canUpload = useCan('upload');
  return (
    <header className="topbar">
      <PhoneLibrarySwitcher />
      <h1 className="topbar__title">{title}</h1>
      {search && <div className="topbar__search">{search}</div>}
      <div className="topbar__spacer" />
      {actions}
      {canUpload && (
        <Button kind="primary" icon="upload" className="topbar__upload" onClick={pick}>
          Upload
        </Button>
      )}
      {user && (
        <Link to="/settings/security" className="topbar__avatar" aria-label="Account and security">
          <Avatar text={initials(user)} seed={user.id} size={34} />
        </Link>
      )}
    </header>
  );
}

function TabBar() {
  const pick = useUploadPicker();
  const canUpload = useCan('upload');
  const { pathname } = useLocation();
  const inAlbums = /^\/(albums|favourites|trash)(\/|$)/.test(pathname);
  const tab = (to: string | undefined, icon: IconName, label: string, active?: boolean) =>
    to ? (
      <NavLink
        to={to}
        end={to === '/'}
        className={({ isActive }) => `tab${isActive || active ? ' active' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <Icon name={icon} size={23} />
        <span>{label}</span>
      </NavLink>
    ) : (
      <span className="tab tab--off" aria-disabled="true" title="Coming soon">
        <Icon name={icon} size={23} />
        <span>{label}</span>
      </span>
    );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab('/', 'library', 'Library')}
      {tab('/albums', 'folder', 'Albums', inAlbums)}
      <span className="tabbar__upload-wrap">
        <button
          type="button"
          className="tabbar__upload"
          aria-label={canUpload ? 'Upload photos' : 'Uploading isn’t available in this library'}
          onClick={pick}
          disabled={!canUpload}
        >
          <Icon name="plus" size={24} />
        </button>
      </span>
      {tab('/shared', 'link', 'Shared')}
      {tab('/you', 'user', 'You')}
    </nav>
  );
}

/** Signed-in app frame: sidebar and top bar on wide screens, large title and tab bar on phones. */
export function Shell({
  title,
  actions,
  search,
  children,
}: {
  title: string;
  actions?: ReactNode;
  /** Search box shown in the top bar (wraps to its own line on phones). */
  search?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // Library notices (read-only, Viewer) on library pages; settings and plans have their own.
  const banner = !/^\/(settings|plans|billing|you)(\/|$)/.test(pathname);
  // Expose the top bar's height so sticky toolbars and day headers sit just below it.
  useLayoutEffect(() => {
    const el = ref.current;
    const bar = el?.querySelector<HTMLElement>('.topbar');
    if (!el || !bar) return;
    const set = () => el.style.setProperty('--topbar-h', `${bar.getBoundingClientRect().height}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="shell" ref={ref}>
      <Sidebar />
      <div className="shell__main">
        <Topbar title={title} actions={actions} search={search} />
        <main id="main" className="shell__content">
          {banner && <LibraryBanner />}
          {children}
        </main>
      </div>
      <TabBar />
    </div>
  );
}
