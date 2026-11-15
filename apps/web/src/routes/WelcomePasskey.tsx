import { ACCOUNT_ACTION_MINUTES } from '@zephyr/shared/client';
import { Button, Chip, Icon, Note } from '@zephyr/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { requestAccountAction } from '../lib/accountActions';
import { errorMessage } from '../lib/api';
import { passkeysSupported } from '../lib/passkey';
import { useSession } from '../lib/session';

/**
 * Shown once after joining: offer a passkey so future sign-ins skip email codes. Phase 8: like every passkey
 * change, it's made from a link we email (routes/AccountAction.tsx), so this asks for that link.
 */
export function WelcomePasskey() {
  const nav = useNavigate();
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const first = user?.displayName?.split(' ')[0];
  const supported = passkeysSupported();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestAccountAction('passkey_add');
      setSent(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      pose="hop"
      line={first ? `Welcome to Zephyr, ${first}.` : 'Welcome to Zephyr.'}
      footer={false}
    >
      <Chip tone="good" icon="check" size="lg">
        Account created
      </Chip>
      <AuthHead title="Sign in faster next time">
        Add a passkey and you’ll sign in with Face ID, Touch ID or Windows Hello. No codes, nothing to phish.
      </AuthHead>
      <div className="passkey-card">
        <span className="badge-tile badge-tile--acc">
          <Icon name="passkey" size={24} />
        </span>
        <span>
          <strong>Saved to this device or your password manager</strong>
          <span className="z-muted">Synced passkeys work on your other devices too.</span>
        </span>
      </div>
      {sent ? (
        <Note tone="neutral" icon="mail" role="status">
          We emailed {user?.email ?? 'you'} a link to add your passkey. Open it on this device; it works for{' '}
          {ACCOUNT_ACTION_MINUTES} minutes.
        </Note>
      ) : supported ? (
        <Button kind="primary" size="lg" full icon="passkey" busy={busy} onClick={add}>
          Add a passkey
        </Button>
      ) : (
        <Note tone="neutral">
          This browser can’t save passkeys. You’ll sign in with email codes; add a passkey later from another
          device.
        </Note>
      )}
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <Button kind="ghost" size="lg" full onClick={() => nav('/', { replace: true })}>
        {sent ? 'Continue to my library' : 'Not now, I’ll use email codes'}
      </Button>
      <span className="z-hint">You can add or remove passkeys any time in Settings › Security.</span>
    </AuthLayout>
  );
}
