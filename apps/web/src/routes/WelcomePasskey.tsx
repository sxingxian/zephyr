import { APP_API, type PasskeyOptions } from '@zephyr/shared/client';
import { Button, Chip, Icon, Note } from '@zephyr/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { createPasskey, isCancelled, passkeysSupported } from '../lib/passkey';
import { useSession } from '../lib/session';

/** Shown once after joining: offer a passkey so future sign-ins skip email codes. */
export function WelcomePasskey() {
  const nav = useNavigate();
  const { user, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = user?.displayName?.split(' ')[0];
  const supported = passkeysSupported();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await api<PasskeyOptions>(APP_API.myPasskeyOptions, { method: 'POST', body: {} });
      const credential = await createPasskey(opts);
      await api(APP_API.myPasskeyVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
      });
      await refresh();
      nav('/', { replace: true });
    } catch (e) {
      if (!isCancelled(e))
        setError(
          e instanceof ApiFailure
            ? errorMessage(e)
            : 'Your device couldn’t save the passkey. Try again, or skip for now.',
        );
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
      {supported ? (
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
        Not now, I’ll use email codes
      </Button>
      <span className="z-hint">You can add or remove passkeys any time in Settings › Security.</span>
    </AuthLayout>
  );
}
