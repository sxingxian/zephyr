import { ADMIN_API, type AdminSessionResponse, type PasskeyOptions } from '@zephyr/shared/client';
import { Button, Note } from '@zephyr/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AdminFacts, AuthFrame } from '../components/AuthFrame';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { getPasskeyAssertion, isCancelled } from '../lib/passkey';
import { useAdminSession } from '../lib/session';

export function SignIn() {
  const nav = useNavigate();
  const { setSession, accessDenied } = useAdminSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await api<PasskeyOptions>(ADMIN_API.passkeyOptions, {
        method: 'POST',
        body: {},
        quiet401: true,
      });
      const credential = await getPasskeyAssertion(opts);
      const s = await api<AdminSessionResponse>(ADMIN_API.passkeyVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
        quiet401: true,
      });
      setSession(s);
      nav(s.enrolOnly ? '/enrol' : '/signups', { replace: true });
    } catch (e) {
      if (isCancelled(e)) return;
      setError(
        e instanceof ApiFailure && e.code === 'forbidden'
          ? 'This passkey isn’t linked to a staff account, or it doesn’t match your Cloudflare Access identity.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  if (accessDenied) {
    return (
      <AuthFrame
        step={0}
        title="Cloudflare Access required"
        sub="This console only opens for devices that pass Cloudflare Access. Reload the page to sign in with Access."
      >
        <Button kind="primary" size="lg" full icon="refresh" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      step={1}
      title="Confirm it’s you"
      sub="Your device passed Cloudflare Access. Use your passkey to open the console."
    >
      <Button kind="primary" size="lg" full icon="passkey" busy={busy} onClick={go}>
        Use my passkey
      </Button>
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <AdminFacts />
      <p className="z-hint">
        First time here, or lost your passkey? Another Owner can send you a one-time enrolment code.{' '}
        <Link to="/enrol">Enrol a passkey</Link>
      </p>
    </AuthFrame>
  );
}
