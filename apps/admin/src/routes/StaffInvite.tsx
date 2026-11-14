import { ADMIN8_API } from '@zephyr/shared/client';
import { Button, Note, Spinner } from '@zephyr/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthFrame } from '../components/AuthFrame';
import { ApiFailure, api, errorMessage } from '../lib/api';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Reads `#t=…` (or `#token=…`) once and strips it from the address bar (and history) straight away. */
export function takeInviteToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get('t') ?? params.get('token');
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  return token && TOKEN_RE.test(token) ? token : null;
}

/**
 * Staff invite link: /admin/staff-invite#t=… The token is in the fragment so it never reaches a server log; it's
 * exchanged once (the Cloudflare Access identity must be the invited email), then the person continues with the
 * normal email code → passkey enrolment.
 */
export function StaffInvite() {
  const nav = useNavigate();
  const token = useRef<string | null | undefined>(undefined);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (token.current === undefined) token.current = takeInviteToken();
    if (started.current) return;
    started.current = true;
    const t = token.current;
    if (!t) {
      setError(
        'This invite link isn’t complete. Open it again from the email, or ask an Owner for a new one.',
      );
      return;
    }
    void (async () => {
      try {
        const r = await api<{ ok: true; email: string }>(ADMIN8_API.staffInviteAccept, {
          method: 'POST',
          body: { token: t },
          quiet401: true,
        });
        nav('/enrol', { replace: true, state: { email: r.email } });
      } catch (e) {
        setError(
          e instanceof ApiFailure && (e.code === 'invalid' || e.code === 'not_found' || e.code === 'conflict')
            ? 'This invite has expired or was already used. Ask an Owner to send a new one.'
            : e instanceof ApiFailure && e.code === 'forbidden'
              ? 'This invite is for a different email than the one you signed in to Cloudflare Access with. Sign in to Access with the invited address and open the link again.'
              : errorMessage(e),
        );
      }
    })();
  }, [nav]);
  return (
    <AuthFrame step={1} title="Join Zephyr Admin" sub="Checking your staff invite…">
      {error ? (
        <>
          <Note tone="warn" icon="alert" role="alert">
            {error}
          </Note>
          <p className="z-hint">
            Already set up? <Link to="/sign-in">Sign in</Link>
          </p>
        </>
      ) : (
        <div className="loading">
          <Spinner size={22} label="Checking your invite" />
        </div>
      )}
      {error && (
        <Button kind="ghost" full onClick={() => nav('/enrol', { replace: true })}>
          Go to first sign-in
        </Button>
      )}
    </AuthFrame>
  );
}
