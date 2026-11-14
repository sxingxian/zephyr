import { ADMIN_API, type AdminSessionResponse, type PasskeyOptions } from '@zephyr/shared/client';
import { Button, CodeInput, Field, Note } from '@zephyr/ui';
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthFrame } from '../components/AuthFrame';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { createPasskey, isCancelled, passkeysSupported } from '../lib/passkey';
import { useAdminSession } from '../lib/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * First sign-in for a staff member with no passkey: email code, then save a passkey. The session from an
 * email code is enrolment-only; nothing else in the console works until a passkey exists.
 */
export function Enrol() {
  const nav = useNavigate();
  const location = useLocation();
  const { staff, enrolOnly, setSession } = useAdminSession();
  // Prefilled after accepting a staff invite (/invite passes the invited address in router state, never the URL).
  const [email, setEmail] = useState(() => {
    const s = location.state as { email?: unknown } | null;
    return typeof s?.email === 'string' ? s.email : '';
  });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step: 'email' | 'code' | 'passkey' = staff && enrolOnly ? 'passkey' : sentTo ? 'code' : 'email';

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const m = email.trim().toLowerCase();
    if (!EMAIL_RE.test(m)) {
      setError('Enter your staff email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(ADMIN_API.emailStart, { method: 'POST', body: { email: m }, quiet401: true });
      setSentTo(m);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!sentTo || value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSession(
        await api<AdminSessionResponse>(ADMIN_API.emailVerify, {
          method: 'POST',
          body: { email: sentTo, code: value },
          quiet401: true,
        }),
      );
    } catch (err) {
      setCode('');
      setError(
        err instanceof ApiFailure && (err.code === 'invalid' || err.code === 'invalid_code')
          ? 'That code didn’t work. Check it, or ask for a new one.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const enrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await api<PasskeyOptions>(ADMIN_API.passkeyEnrolOptions, { method: 'POST', body: {} });
      const credential = await createPasskey(opts);
      const s = await api<AdminSessionResponse>(ADMIN_API.passkeyEnrolVerify, {
        method: 'POST',
        body: { challengeId: opts.challengeId, credential },
      });
      setSession(s);
      nav('/signups', { replace: true });
    } catch (err) {
      if (!isCancelled(err))
        setError(
          err instanceof ApiFailure ? errorMessage(err) : 'Your device couldn’t save the passkey. Try again.',
        );
    } finally {
      setBusy(false);
    }
  };

  if (step === 'passkey') {
    return (
      <AuthFrame
        step={1}
        title="Save your passkey"
        sub={
          <>
            Signed in as <strong className="strong">{staff?.email}</strong>. Save a passkey on this device to
            finish.
          </>
        }
      >
        {passkeysSupported() ? (
          <Button kind="primary" size="lg" full icon="passkey" busy={busy} onClick={enrol}>
            Add passkey
          </Button>
        ) : (
          <Note tone="warn" icon="alert">
            This browser can’t save passkeys. Use a current version of Safari, Chrome, Edge or Firefox.
          </Note>
        )}
        {error && (
          <Note tone="warn" icon="alert" role="alert">
            {error}
          </Note>
        )}
        <Note>
          Email codes only work here until your first passkey is saved. After that, the passkey is the only
          way in.
        </Note>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      step={1}
      title="Enrol your passkey"
      sub={
        step === 'code' ? (
          <>
            Enter the 6-digit code we emailed to <strong className="strong">{sentTo}</strong>, then save a
            passkey on this device.
          </>
        ) : (
          'First sign-in? We’ll email a one-time code to your staff address, then you’ll save a passkey on this device.'
        )
      }
    >
      {step === 'email' ? (
        <form className="stack" onSubmit={start} noValidate>
          <Field
            label="Staff email"
            type="email"
            icon="mail"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@midnightpoetry.studio"
          />
          <Button type="submit" kind="primary" size="lg" full busy={busy}>
            Email me a code
          </Button>
        </form>
      ) : (
        <div className="stack">
          <CodeInput
            value={code}
            onChange={setCode}
            onComplete={verify}
            label="Email code"
            invalid={Boolean(error)}
            disabled={busy}
            autoFocus
          />
          <Button
            kind="primary"
            size="lg"
            full
            icon="passkey"
            busy={busy}
            disabled={code.length !== 6}
            onClick={() => verify(code)}
          >
            Verify and add passkey
          </Button>
        </div>
      )}
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <Note>
        Email codes only work here until your first passkey is saved. After that, the passkey is the only way
        in.
      </Note>
      <p className="z-hint">
        Already have a passkey? <Link to="/sign-in">Sign in</Link>
      </p>
    </AuthFrame>
  );
}
