import { APP_API, type PasskeyOptions, type SessionResponse } from '@zephyr/shared/client';
import { Button, Field, Note, Turnstile, type TurnstileHandle } from '@zephyr/ui';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthHead, AuthLayout, OrRule } from '../components/AuthLayout';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { TURNSTILE_ACTIONS, TURNSTILE_SITE_KEY } from '../lib/config';
import { getPasskeyAssertion, isCancelled, passkeysSupported } from '../lib/passkey';
import { safeReturnPath } from '../lib/returnPath';
import { useSession } from '../lib/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SignIn() {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  const { setUser } = useSession();
  const [email, setEmail] = useState(((loc.state as { email?: string } | null)?.email ?? '') as string);
  const [token, setToken] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'email' | null>(null);
  const ts = useRef<TurnstileHandle>(null);

  const withPasskey = async () => {
    setError(null);
    setBusy('passkey');
    try {
      const opts = await api<PasskeyOptions>(APP_API.passkeyOptions, { method: 'POST', body: {} });
      const credential = await getPasskeyAssertion(opts);
      const r = await api<SessionResponse>(APP_API.passkeyVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
      });
      setUser(r.user);
      nav(next, { replace: true });
    } catch (e) {
      if (!isCancelled(e))
        setError(
          e instanceof ApiFailure
            ? errorMessage(e)
            : 'The passkey didn’t work. Try again, or use an email code.',
        );
    } finally {
      setBusy(null);
    }
  };

  const withEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const address = email.trim().toLowerCase();
    if (!EMAIL_RE.test(address)) {
      setEmailError('Enter an email address like name@example.com.');
      return;
    }
    setEmailError(null);
    if (!token) {
      setError('Finish the security check, then send the code.');
      return;
    }
    setBusy('email');
    try {
      await api(APP_API.emailStart, { method: 'POST', body: { email: address, turnstileToken: token } });
      nav(`/sign-in/code${params.toString() ? `?${params}` : ''}`, { state: { email: address } });
    } catch (err) {
      ts.current?.reset();
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthLayout pose="breeze" line="Edit five hundred photos before the coffee gets cold.">
      <AuthHead title="Sign in to Zephyr">
        New here? Zephyr is invite-only right now. <Link to="/sign-up">Have an invite?</Link>
      </AuthHead>
      {passkeysSupported() && (
        <>
          <Button
            kind="primary"
            size="lg"
            full
            icon="passkey"
            busy={busy === 'passkey'}
            onClick={withPasskey}
          >
            Sign in with a passkey
          </Button>
          <OrRule>or get a code by email</OrRule>
        </>
      )}
      <form className="stack" onSubmit={withEmail} noValidate>
        <Field
          label="Email"
          type="email"
          name="email"
          icon="mail"
          autoComplete="username webauthn"
          inputMode="email"
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
          required
        />
        <Turnstile
          ref={ts}
          siteKey={TURNSTILE_SITE_KEY}
          action={TURNSTILE_ACTIONS.emailStart}
          appearance="interaction-only"
          onToken={setToken}
          onExpire={() => setToken('')}
        />
        <Button type="submit" size="lg" full busy={busy === 'email'}>
          Email me a sign-in code
        </Button>
        <span className="z-hint">
          Codes expire in 10 minutes. We never send links that sign you in by themselves.
        </span>
      </form>
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
    </AuthLayout>
  );
}
