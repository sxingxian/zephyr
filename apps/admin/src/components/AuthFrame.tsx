import { Chip, Icon, Mascot, Wordmark } from '@zephyr/ui';
import type { ReactNode } from 'react';

/** Admin sign-in frame: three steps (Access → Passkey → Console) and the guard mascot. */
export function AuthFrame({
  step,
  title,
  children,
  sub,
}: {
  step: 0 | 1 | 2;
  title: string;
  sub: ReactNode;
  children: ReactNode;
}) {
  const steps = ['Cloudflare Access', 'Passkey', 'Admin console'];
  return (
    <div className="aauth">
      <main id="main" className="aauth__main">
        <div className="aauth__col">
          <div className="aauth__brand">
            <Wordmark size={22} />
            <Chip tone="ink" size="sm">
              Admin
            </Chip>
          </div>
          <ol className="aauth__steps" aria-label="Sign-in steps">
            {steps.map((label, i) => (
              <li
                key={label}
                className={i < step ? 'done' : i === step ? 'current' : ''}
                aria-current={i === step ? 'step' : undefined}
              >
                <span className="aauth__bar" />
                <span className="aauth__label">
                  {i < step && <Icon name="check" size={14} />}
                  {label}
                </span>
              </li>
            ))}
          </ol>
          <div className="aauth__head">
            <h1>{title}</h1>
            <p>{sub}</p>
          </div>
          {children}
        </div>
      </main>
      <aside className="aauth__aside" aria-hidden="true">
        <Mascot pose="guard" width={280} />
        <div className="aauth__aside-text">
          <span className="aauth__aside-kicker">ZEPHYR ADMIN</span>
          <span>zephyr.midnightpoetry.studio/admin · not indexed, not linked from the public site</span>
        </div>
      </aside>
    </div>
  );
}

export function AdminFacts() {
  const facts: [Parameters<typeof Icon>[0]['name'], string][] = [
    ['shieldCheck', 'Staff accounts are separate from Zephyr member accounts and can’t be used in the app.'],
    ['key', 'No passwords. A passkey is required on every sign-in after the first.'],
    ['clock', 'Sessions lock after 30 minutes without activity. Every action is written to the audit log.'],
  ];
  return (
    <ul className="aauth__facts">
      {facts.map(([ic, t]) => (
        <li key={t}>
          <Icon name={ic} size={16} />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}
