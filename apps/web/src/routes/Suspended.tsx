import { Button, buttonClass } from '@zephyr/ui';
import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { SUPPORT_EMAIL } from '../lib/config';
import { browser } from '../lib/sessionGuard';

/**
 * Phase 8: shown after any call answers 403 account_suspended (sign-in included). The server has already
 * ended the session; this screen never shows photo data.
 */
export function SuspendedPage() {
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout pose="ponder" line="We’ll sort this out." tone="guard" footer={false}>
      <div className="auth__head">
        <h1>This account is suspended</h1>
        <p>
          You can’t sign in or share galleries right now. Your photos are kept safe. If you think this is a
          mistake, write to us and we’ll look into it.
        </p>
      </div>
      <a
        className={buttonClass({ kind: 'primary', size: 'lg', full: true })}
        href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('My Zephyr account is suspended')}`}
      >
        <span>Email support</span>
      </a>
      <Button
        kind="ghost"
        size="lg"
        full
        busy={busy}
        onClick={() => {
          setBusy(true);
          browser.assign('/sign-in');
        }}
      >
        Use a different account
      </Button>
    </AuthLayout>
  );
}
