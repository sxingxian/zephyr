import { APP_API, type InvitePreview, type SessionResponse } from '@zephyr/shared/client';
import { Button, Field, Note, Spinner } from '@zephyr/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { Avatar } from '../components/Avatar';
import { ApiFailure, api, errorMessage } from '../lib/api';
import { REQUEST_INVITE_URL } from '../lib/config';
import { initials, useSession } from '../lib/session';

const TOKEN_RE = /(?:^|[#&])t=([A-Za-z0-9_-]{43})(?:&|$)/;

/** The token, once taken from the URL. Kept in memory only (module scope survives React's double render). */
let taken: string | null = null;

/**
 * Reads the invite token from the URL fragment and removes it from the address bar straight away, so it
 * doesn't linger in history, screenshots or shared links. The token then lives only in memory and is
 * sent nowhere except the preview and redeem request bodies. Safe to call more than once.
 */
export function takeInviteToken(): string | null {
  const m = TOKEN_RE.exec(window.location.hash);
  if (m?.[1]) taken = m[1];
  if (window.location.hash)
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  return taken;
}
/** Forget the token once it has been used (or for tests). */
export function forgetInviteToken(): void {
  taken = null;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function Join() {
  const nav = useNavigate();
  const { setUser } = useSession();
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = takeInviteToken();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'missing' | 'error'>(
    token.current ? 'loading' : 'missing',
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = token.current;
    if (!t) return;
    const ac = new AbortController();
    api<InvitePreview>(APP_API.invitePreview, {
      method: 'POST',
      body: { token: t },
      signal: ac.signal,
      quiet401: true,
    })
      .then((p) => {
        setPreview(p);
        setState('ready');
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return;
        if (e instanceof ApiFailure && (e.code === 'invite_invalid' || e.code === 'not_found'))
          setState('invalid');
        else {
          setError(errorMessage(e));
          setState('error');
        }
      });
    return () => ac.abort();
  }, []);

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: { token: string; displayName?: string } = { token: token.current };
      if (name.trim()) body.displayName = name.trim().slice(0, 80);
      const r = await api<SessionResponse>(APP_API.inviteRedeem, { method: 'POST', body, quiet401: true });
      token.current = null;
      forgetInviteToken();
      setUser(r.user);
      nav(r.user.passkeyCount > 0 ? '/' : '/welcome/passkey', {
        replace: true,
        state: { welcome: r.user.displayName },
      });
    } catch (err) {
      if (err instanceof ApiFailure && err.code === 'invite_invalid') setState('invalid');
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <AuthLayout pose="hop" line="Opening your invite…" tone="lilac">
        <div className="center-block">
          <Spinner size={24} label="Checking your invite" />
        </div>
      </AuthLayout>
    );
  }
  if (state === 'invalid' || state === 'missing' || state === 'error') {
    return (
      <AuthLayout pose="ponder" line="That invite blew away." tone="lilac">
        <AuthHead
          title={state === 'error' ? 'We couldn’t open this invite' : 'This invite link doesn’t work'}
        >
          {state === 'missing'
            ? 'The link looks incomplete. Open it straight from the invite email, or ask for a new one.'
            : state === 'invalid'
              ? 'It may have expired, been used already, or been cancelled. Ask whoever invited you for a new one.'
              : error}
        </AuthHead>
        <Link to="/sign-in" className="z-btn z-btn--primary z-btn--lg z-btn--full">
          Sign in
        </Link>
        <div className="link-row">
          <span>
            Have a code? <Link to="/sign-up">Use it here</Link>
          </span>
          <span>
            No invite? <a href={REQUEST_INVITE_URL}>Request one</a>
          </span>
        </div>
      </AuthLayout>
    );
  }

  const p = preview as InvitePreview;
  return (
    <AuthLayout pose="wave" line="Someone saved you a seat." tone="lilac">
      <div className="invite-banner">
        <Avatar
          text={initials({ displayName: p.inviterName, email: 'z@z' })}
          seed={p.inviterName ?? 'zephyr'}
          size={32}
        />
        <span>
          <strong>
            {p.inviterName ? `${p.inviterName} invited you to Zephyr` : 'You’re invited to Zephyr'}
          </strong>
          <span>Invite expires {fmtDate(p.expiresAt)}</span>
        </span>
      </div>
      <AuthHead title="Create your account">Starts on the Free plan. You can upgrade any time.</AuthHead>
      <form className="stack" onSubmit={redeem}>
        <Field
          label="Your email"
          icon="lock"
          value={p.email}
          readOnly
          hint="Opening this invite from your inbox confirms the address. It can’t be changed here."
        />
        <Field
          label="Your name (optional)"
          name="name"
          autoComplete="name"
          maxLength={80}
          placeholder="Wei Tan"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" kind="primary" size="lg" full busy={busy}>
          Create my account
        </Button>
      </form>
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <span className="z-hint">
        Not you, or didn’t expect this? Just close this page. The invite expires on its own.
      </span>
    </AuthLayout>
  );
}
