import { APP_API, type SessionResponse } from '@zephyr/shared/client';
import { Button, CodeInput, Note, Turnstile, type TurnstileHandle } from '@zephyr/ui';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { TURNSTILE_ACTIONS, TURNSTILE_SITE_KEY } from '../lib/config';
import { safeReturnPath } from '../lib/returnPath';
import { useSession } from '../lib/session';

const RESEND_AFTER = 60;

export function SignInCode() {
  const loc = useLocation();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  const email = (loc.state as { email?: string } | null)?.email;
  const { setUser } = useSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(RESEND_AFTER);
  // The first try needs no check; every later try needs a fresh Turnstile token (one per attempt).
  const [token, setToken] = useState('');
  const [tries, setTries] = useState(0);
  const ts = useRef<TurnstileHandle>(null);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  // The address is only kept in memory for this step; a reload starts over.
  if (!email) return <Navigate to="/sign-in" replace />;

  const verify = async (value: string) => {
    if (value.length !== 6 || busy) return;
    if (tries > 0 && !token) {
      setError('Finish the security check below, then try again.');
      return;
    }
    setBusy(true);
    setError(null);
    const used = token;
    setToken('');
    setTries((n) => n + 1);
    try {
      const r = await api<SessionResponse>(APP_API.emailVerify, {
        method: 'POST',
        body: used ? { email, code: value, turnstileToken: used } : { email, code: value },
      });
      setUser(r.user);
      nav(next, { replace: true });
    } catch (e) {
      setCode('');
      ts.current?.reset();
      setError(
        e instanceof ApiFailure && e.code === 'invalid'
          ? errorMessage(new ApiFailure('invalid_code', 400))
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const back = () => nav(`/sign-in${params.toString() ? `?${params}` : ''}`, { state: { email } });

  return (
    <AuthLayout pose="peek" line="Check your inbox. Zephyr will wait right here.">
      <Button kind="ghost" size="sm" icon="chevL" className="back-btn" onClick={back}>
        Use a different email
      </Button>
      <AuthHead title="Enter your code">
        We sent a 6-digit code to <strong className="strong">{email}</strong>.
      </AuthHead>
      <CodeInput
        value={code}
        onChange={setCode}
        onComplete={verify}
        label="6-digit sign-in code"
        invalid={Boolean(error)}
        disabled={busy}
        autoFocus
      />
      <Button
        kind="primary"
        size="lg"
        full
        busy={busy}
        disabled={code.length !== 6}
        onClick={() => verify(code)}
      >
        Sign in
      </Button>
      <Turnstile
        ref={ts}
        siteKey={TURNSTILE_SITE_KEY}
        action={TURNSTILE_ACTIONS.emailVerify}
        appearance="interaction-only"
        onToken={setToken}
        onExpire={() => setToken('')}
      />
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <div className="split-row">
        <span>Didn’t get it? Check spam.</span>
        {left > 0 ? (
          <span aria-live="off">
            Resend in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </span>
        ) : (
          <button type="button" className="text-link" onClick={back}>
            Send a new code
          </button>
        )}
      </div>
    </AuthLayout>
  );
}
