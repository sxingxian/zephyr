import { type StaffAction, staffCan } from '@zephyr/shared/client';
import { Button, Chip, Icon, type IconName, Wordmark } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { ROLE_LABEL, useAdminSession } from '../lib/session';
import { Avatar } from './Avatar';

type Role = NonNullable<ReturnType<typeof useAdminSession>['staff']>['role'];
/** Nav items. Each one is shown only to roles that may view it; the API answers 403 to everyone else. */
export const NAV: {
  label: string;
  icon: IconName;
  to: string;
  end?: boolean;
  /** STAFF_CAN action that lets a role view the page. */
  can?: StaffAction;
  /** Older pages gated by an explicit role list. */
  roles?: Role[];
}[] = [
  { label: 'Users', icon: 'people', to: '/users', can: 'usersView' },
  { label: 'Sign-ups & invites', icon: 'mail', to: '/signups' },
  { label: 'Safety & reports', icon: 'shield', to: '/safety', can: 'safetyView' },
  { label: 'AI jobs', icon: 'cpu', to: '/ai/jobs' },
  { label: 'Zephyr AI', icon: 'breeze', to: '/ai', end: true },
  { label: 'Plans & billing', icon: 'card', to: '/billing', roles: ['owner', 'admin', 'finance'] },
  { label: 'Plan limits', icon: 'sliders', to: '/limits', can: 'limitsView' },
  { label: 'Ads', icon: 'megaphone', to: '/ads', can: 'ads' },
  { label: 'Storage', icon: 'database', to: '/storage', can: 'storage' },
  { label: 'Retention', icon: 'clock', to: '/retention', can: 'retention' },
  { label: 'Audit log', icon: 'file', to: '/audit', can: 'auditView' },
  { label: 'Staff & roles', icon: 'key', to: '/staff', can: 'staff' },
  { label: 'System settings', icon: 'settings', to: '/settings', can: 'settings' },
];

export const navFor = (role: Role | undefined) =>
  NAV.filter((n) => role && (n.can ? staffCan(role, n.can) : !n.roles || n.roles.includes(role)));

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
          {navFor(staff?.role).map((n) => (
            <NavLink key={n.label} to={n.to} end={n.end} className="anav__item">
              <Icon name={n.icon} size={18} />
              <span>{n.label}</span>
            </NavLink>
          ))}
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
