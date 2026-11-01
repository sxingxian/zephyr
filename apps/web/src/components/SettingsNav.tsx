import { Icon, type IconName } from '@zephyr/ui';
import { NavLink } from 'react-router';

const ITEMS: { label: string; icon: IconName; to?: string }[] = [
  { label: 'Account & security', icon: 'shield', to: '/settings/security' },
  { label: 'Invite friends', icon: 'mail', to: '/settings/invites' },
  { label: 'Sharing & branding', icon: 'share', to: '/settings/sharing' },
  { label: 'Zephyr AI', icon: 'breeze', to: '/settings/ai' },
  { label: 'Appearance', icon: 'sun' },
  { label: 'Plan & billing', icon: 'card' },
  { label: 'Privacy & data', icon: 'database' },
  { label: 'About & licences', icon: 'info', to: '/settings/about' },
];

export function SettingsNav() {
  return (
    <nav className="settings-nav" aria-label="Settings">
      {ITEMS.map((i) =>
        i.to ? (
          <NavLink key={i.label} to={i.to} className="nav-item">
            <Icon name={i.icon} size={18} />
            <span className="nav-item__label">{i.label}</span>
          </NavLink>
        ) : (
          <span key={i.label} className="nav-item nav-item--off" aria-disabled="true">
            <Icon name={i.icon} size={18} />
            <span className="nav-item__label">{i.label}</span>
            <span className="nav-item__soon">Soon</span>
          </span>
        ),
      )}
    </nav>
  );
}
