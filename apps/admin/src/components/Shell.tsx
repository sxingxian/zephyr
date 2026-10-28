import { Button, Chip, Icon, type IconName, Wordmark } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { ROLE_LABEL, useAdminSession } from '../lib/session';
import { Avatar } from './Avatar';

const NAV: { label: string; icon: IconName; to?: string; phase?: number }[] = [
  { label: 'Overview', icon: 'home', phase: 8 },
  { label: 'Users', icon: 'people', phase: 8 },
  { label: 'Sign-ups & invites', icon: 'mail', to: '/signups' },
  { label: 'Safety & reports', icon: 'shield', phase: 5 },
  { label: 'AI jobs', icon: 'cpu', phase: 6 },
  { label: 'Zephyr AI', icon: 'breeze', phase: 6 },
  { label: 'Plans & billing', icon: 'card', phase: 7 },
  { label: 'Plan limits', icon: 'sliders', phase: 7 },
  { label: 'Ads', icon: 'megaphone', phase: 8 },
  { label: 'Galleries', icon: 'link', phase: 5 },
  { label: 'Audit log', icon: 'file', phase: 8 },
  { label: 'Team & roles', icon: 'key', phase: 8 },
  { label: 'System settings', icon: 'settings', phase: 8 },
];

const initials = (s: string) =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

export function AdminShell({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { staff, signOut } = useAdminSession();
  const nav = useNavigate();
  const name = staff?.displayName || staff?.email || '';
  const out = async () => {
    await signOut();
    nav('/sign-in', { replace: true });
  };
  return (
    <div className="ashell">
      <nav className="anav" aria-label="Admin">
        <div className="anav__brand">
          <Wordmark size={20} />
          <Chip tone="ink" size="sm">
            Admin
          </Chip>
        </div>
        <div className="anav__env">
          <Icon name="globe" size={15} />
          Production
        </div>
        <div className="anav__items">
          {NAV.map((n) =>
            n.to ? (
              <NavLink key={n.label} to={n.to} className="anav__item">
                <Icon name={n.icon} size={18} />
                <span>{n.label}</span>
              </NavLink>
            ) : (
              <span key={n.label} className="anav__item anav__item--off" aria-disabled="true">
                <Icon name={n.icon} size={18} />
                <span>{n.label}</span>
                <span className="anav__phase">Phase {n.phase}</span>
              </span>
            ),
          )}
        </div>
        {staff && (
          <div className="anav__me">
            <div className="anav__me-row">
              <Avatar text={initials(name)} seed={staff.id} size={32} />
              <div className="anav__me-text">
                <span className="anav__me-name">{name}</span>
                <span className="z-hint">{ROLE_LABEL[staff.role]} · passkey</span>
              </div>
            </div>
            <div className="anav__me-note">
              <Icon name="clock" size={14} />
              Locks after 30 min idle
            </div>
          </div>
        )}
      </nav>
      <div className="ashell__main">
        <header className="atop">
          <span className="atop__phone">
            <Wordmark size={18} />
            <Chip tone="ink" size="sm">
              Admin
            </Chip>
          </span>
          <div className="atop__spacer" />
          {staff && <Chip tone="acc">{ROLE_LABEL[staff.role]}</Chip>}
          <Button kind="ghost" size="sm" icon="logout" onClick={out}>
            Sign out
          </Button>
        </header>
        <div className="apage-head">
          <div>
            <h1 className="apage-head__title">{title}</h1>
            {sub && <p className="apage-head__sub">{sub}</p>}
          </div>
          {actions && <div className="apage-head__actions">{actions}</div>}
        </div>
        <main id="main" className="apage">
          {children}
        </main>
      </div>
    </div>
  );
}
