import { Button, Chip, Icon } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar } from '../components/Avatar';
import { CreditsMeter } from '../components/ai/AiBits';
import { Shell, StorageMeter } from '../components/Shell';
import { useAiStatus, useRunningJobs } from '../lib/aiClient';
import { initials, useSession } from '../lib/session';

const PLAN_LABEL = { free: 'Free plan', pro: 'Pro plan', studio: 'Studio plan' } as const;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="you-group">
      <h2 className="z-eyebrow">{title}</h2>
      <div className="you-group__box">{children}</div>
    </section>
  );
}

/** Phone account screen (the "You" tab). */
export function You() {
  const { user, signOut } = useSession();
  const nav = useNavigate();
  const ai = useAiStatus();
  const running = useRunningJobs();
  const aiOn = !ai || ai.enabled;
  if (!user) return null;
  const out = async () => {
    await signOut();
    nav('/sign-in', { replace: true });
  };
  return (
    <Shell title="You">
      <div className="you">
        <header className="you__head">
          <Avatar text={initials(user)} seed={user.id} size={52} />
          <div>
            <h1 className="you__name">{user.displayName || user.email.split('@')[0]}</h1>
            <span className="z-muted">{user.email}</span>
          </div>
        </header>
        <section className="you-plan">
          <div className="you-plan__row">
            <strong>{PLAN_LABEL[user.plan]}</strong>
            {user.plan === 'free' && <Chip size="sm">With ads</Chip>}
          </div>
          <StorageMeter />
          <CreditsMeter />
          <Link to="/settings/billing" className="z-btn z-btn--secondary z-btn--md z-btn--full">
            <span>Plan &amp; billing</span>
          </Link>
        </section>
        {aiOn && (
          <Group title="Zephyr AI">
            {(
              [
                ['/people', 'people', 'People'],
                ['/scenes', 'pin', 'Scenes'],
                ['/cleanup', 'sparkGrid', 'Cleanup'],
                ['/ai/queue', 'stack', 'AI queue'],
                ['/settings/ai', 'settings', 'AI settings & credits'],
              ] as const
            ).map(([to, icon, label]) => (
              <Link key={to} to={to} className="you-row">
                <span className="you-row__icon">
                  <Icon name={icon} size={17} />
                </span>
                <span className="you-row__label">{label}</span>
                {to === '/ai/queue' && running > 0 && <span className="z-muted">{running} running</span>}
                <Icon name="chevR" size={16} />
              </Link>
            ))}
          </Group>
        )}
        <Group title="Library">
          <Link to="/favourites" className="you-row">
            <span className="you-row__icon">
              <Icon name="heart" size={17} />
            </span>
            <span className="you-row__label">Favourites</span>
            <Icon name="chevR" size={16} />
          </Link>
          <Link to="/trash" className="you-row">
            <span className="you-row__icon">
              <Icon name="trash" size={17} />
            </span>
            <span className="you-row__label">Trash</span>
            <Icon name="chevR" size={16} />
          </Link>
        </Group>
        <Group title="Security">
          <Link to="/settings/security" className="you-row">
            <span className="you-row__icon">
              <Icon name="passkey" size={17} />
            </span>
            <span className="you-row__label">Passkeys</span>
            <span className="z-muted">{user.passkeyCount}</span>
            <Icon name="chevR" size={16} />
          </Link>
          <Link to="/settings/security?delete=1" className="you-row">
            <span className="you-row__icon you-row__icon--bad">
              <Icon name="trash" size={17} />
            </span>
            <span className="you-row__label">Delete account</span>
            <Icon name="chevR" size={16} />
          </Link>
        </Group>
        <Group title="People">
          <Link to="/settings/team" className="you-row">
            <span className="you-row__icon">
              <Icon name="people" size={17} />
            </span>
            <span className="you-row__label">Team</span>
            <Icon name="chevR" size={16} />
          </Link>
          <Link to="/settings/invites" className="you-row">
            <span className="you-row__icon">
              <Icon name="mail" size={17} />
            </span>
            <span className="you-row__label">Invite friends</span>
            <Icon name="chevR" size={16} />
          </Link>
        </Group>
        <Button kind="danger" size="lg" full icon="logout" onClick={out}>
          Sign out
        </Button>
      </div>
    </Shell>
  );
}
