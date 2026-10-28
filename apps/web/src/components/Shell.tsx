import { Chip, Icon, type IconName, Wordmark } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { initials, useSession } from '../lib/session';
import { Avatar } from './Avatar';

interface NavDef {
  label: string;
  icon: IconName;
  to?: string;
}
const LIBRARY: NavDef[] = [
  { label: 'Library', icon: 'library', to: '/' },
  { label: 'Albums', icon: 'folder' },
  { label: 'People', icon: 'people' },
  { label: 'Places & scenes', icon: 'pin' },
  { label: 'Favourites', icon: 'heart' },
  { label: 'Shared galleries', icon: 'share' },
  { label: 'Cleanup', icon: 'sparkGrid' },
  { label: 'Trash', icon: 'trash' },
];
const AI: NavDef[] = [
  { label: 'Batch queue', icon: 'stack' },
  { label: 'Presets', icon: 'breeze' },
];

function Item({ d }: { d: NavDef }) {
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
    <NavLink to={d.to} end className="nav-item">
      <Icon name={d.icon} size={18} />
      <span className="nav-item__label">{d.label}</span>
    </NavLink>
  );
}

const PLAN_LABEL = { free: 'Free plan', pro: 'Pro plan', studio: 'Studio plan' } as const;

function Sidebar() {
  const { user } = useSession();
  const plan = user?.plan ?? 'free';
  return (
    <nav className="sidebar" aria-label="Main">
      <Link to="/" className="sidebar__brand" aria-label="Zephyr library">
        <Wordmark size={21} />
      </Link>
      <div className="sidebar__group">
        {LIBRARY.map((d) => (
          <Item key={d.label} d={d} />
        ))}
      </div>
      <div className="sidebar__group">
        <span className="sidebar__heading">Zephyr AI</span>
        {AI.map((d) => (
          <Item key={d.label} d={d} />
        ))}
      </div>
      <div className="sidebar__spacer" />
      <div className="sidebar__plan">
        <div className="sidebar__plan-row">
          <Chip tone={plan === 'free' ? 'neutral' : 'ink'}>{PLAN_LABEL[plan]}</Chip>
          <Link to="/settings/security" aria-label="Settings" className="sidebar__settings">
            <Icon name="settings" size={17} />
          </Link>
        </div>
        <p className="z-hint">Storage and Zephyr AI credits appear here once your first photos are in.</p>
      </div>
    </nav>
  );
}

function Topbar({ title, actions }: { title: string; actions?: ReactNode }) {
  const { user } = useSession();
  return (
    <header className="topbar">
      <Link to="/" className="topbar__phone-mark" aria-label="Zephyr library">
        <Wordmark size={18} />
      </Link>
      <h1 className="topbar__title">{title}</h1>
      <div className="topbar__spacer" />
      {actions}
      {user && (
        <Link to="/settings/security" className="topbar__avatar" aria-label="Account and security">
          <Avatar text={initials(user)} seed={user.id} size={34} />
        </Link>
      )}
    </header>
  );
}

function TabBar() {
  const tab = (to: string | undefined, icon: IconName, label: string) =>
    to ? (
      <NavLink to={to} end className="tab">
        <Icon name={icon} size={23} />
        <span>{label}</span>
      </NavLink>
    ) : (
      <span className="tab tab--off" aria-disabled="true">
        <Icon name={icon} size={23} />
        <span>{label}</span>
      </span>
    );
  return (
    <nav className="tabbar" aria-label="Main">
      {tab('/', 'library', 'Library')}
      {tab(undefined, 'folder', 'Albums')}
      <span className="tabbar__upload-wrap">
        <button type="button" className="tabbar__upload" aria-label="Upload photos (coming soon)" disabled>
          <Icon name="plus" size={24} />
        </button>
      </span>
      {tab(undefined, 'link', 'Shared')}
      {tab('/you', 'user', 'You')}
    </nav>
  );
}

/** Signed-in app frame: sidebar and top bar on wide screens, tab bar on phones. */
export function Shell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <Sidebar />
      <div className="shell__main">
        <Topbar title={title} actions={actions} />
        <main id="main" className="shell__content">
          {children}
        </main>
      </div>
      <TabBar />
    </div>
  );
}
