import type { MascotPose } from '@zephyr/brand';
import { Mascot, Wordmark } from '@zephyr/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface AuthLayoutProps {
  pose: MascotPose;
  /** The large line under the mascot on wide screens. */
  line: string;
  /** Panel colour on wide screens; tile colour on phones. */
  tone?: 'sky' | 'lilac' | 'mint' | 'guard';
  children: ReactNode;
  footer?: boolean;
}

const PANEL: Record<NonNullable<AuthLayoutProps['tone']>, string> = {
  sky: 'linear-gradient(180deg, var(--m-sky) 0%, #F4F1EC 100%)',
  lilac: 'linear-gradient(180deg, var(--m-lilac) 0%, #F4F1EC 100%)',
  mint: 'linear-gradient(180deg, var(--m-mint) 0%, #F4F1EC 100%)',
  guard: 'linear-gradient(180deg, #E3E9F5 0%, #F4F1EC 100%)',
};
const TILE: Record<NonNullable<AuthLayoutProps['tone']>, string> = {
  sky: 'var(--m-sky)',
  lilac: 'var(--m-lilac)',
  mint: 'var(--m-mint)',
  guard: '#E3E9F5',
};

/** Sign-in and joining screens: mascot panel on the left on wide screens, a mascot tile on phones. */
export function AuthLayout({ pose, line, tone = 'sky', children, footer = true }: AuthLayoutProps) {
  return (
    <div className="auth">
      <aside className="auth__panel" style={{ background: PANEL[tone] }} aria-hidden="true">
        <Wordmark size={24} className="auth__panel-mark" />
        <div className="auth__panel-art">
          <Mascot pose={pose} width={340} />
        </div>
        <p className="auth__line">{line}</p>
      </aside>
      <main className="auth__main" id="main">
        <div className="auth__col">
          <div className="auth__phone-head">
            <Mascot pose={pose} width={168} tile={{ background: TILE[tone], height: 188 }} />
            <Link to="/" className="auth__phone-mark" aria-label="Zephyr">
              <Wordmark size={22} />
            </Link>
          </div>
          {children}
          {footer && (
            <p className="auth__legal">
              By continuing you agree to the{' '}
              <a href="https://zephyr.midnightpoetry.studio/terms" target="_blank" rel="noopener">
                Terms
              </a>{' '}
              and{' '}
              <a href="https://zephyr.midnightpoetry.studio/privacy" target="_blank" rel="noopener">
                Privacy Policy
              </a>
              . Protected by Cloudflare Turnstile.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

export function AuthHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="auth__head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}

export function OrRule({ children }: { children: ReactNode }) {
  return (
    <div className="or-rule">
      <span />
      {children}
      <span />
    </div>
  );
}
