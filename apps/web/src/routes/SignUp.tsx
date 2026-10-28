import { APP_API } from '@zephyr/shared/client';
import { Button, Field, Icon, Note, Turnstile, type TurnstileHandle } from '@zephyr/ui';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { api, errorMessage } from '../lib/api';
import { REQUEST_INVITE_URL, TURNSTILE_ACTIONS, TURNSTILE_SITE_KEY } from '../lib/config';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_RE = /^[A-Z0-9-]{4,32}$/;

/** Invite-only sign-up: an invite code plus an email gets a sign-up link by email. */
export function SignUp() {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<{ code?: string; email?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ code: string; email: string } | null>(null);
  const ts = useRef<TurnstileHandle>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const c = code.trim().toUpperCase();
    const m = email.trim().toLowerCase();
    const errs = {
      code: CODE_RE.test(c) ? undefined : 'Codes use letters, numbers and dashes, like WEDDING-EXPO.',
      email: EMAIL_RE.test(m) ? undefined : 'Enter an email address like name@example.com.',
    };
    setErrors(errs);
    if (errs.code || errs.email) return;
    if (!token) {
      setError('Finish the security check, then send the link.');
      return;
    }
    setBusy(true);
    try {
      await api(APP_API.inviteCode, { method: 'POST', body: { code: c, email: m, turnstileToken: token } });
      setSent({ code: c, email: m });
    } catch (err) {
      ts.current?.reset();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout pose="hold" line="Your invite is on its way." tone="mint">
        <span className="badge-tile badge-tile--good">
          <Icon name="mail" size={26} />
        </span>
        <AuthHead title="Check your email">
          If <strong className="strong">{sent.code}</strong> is a valid code, we’ve sent a sign-up link to{' '}
          <strong className="strong">{sent.email}</strong>. It works once and expires in 7 days.
        </AuthHead>
        <ul className="fact-list">
          <li>
            <Icon name="clock" size={16} />
            <span>Nothing after a few minutes? Check spam, or try again in 15 minutes.</span>
          </li>
          <li>
            <Icon name="shieldCheck" size={16} />
            <span>The link only works for this email address, so it’s safe if someone sees the code.</span>
          </li>
        </ul>
        <Link to="/sign-in" className="z-btn z-btn--secondary z-btn--lg z-btn--full">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout pose="guard" line="Zephyr is opening up a few seats at a time." tone="guard">
      <AuthHead title="Zephyr is invite-only right now">
        Got an invite email? Open the link in it. Got an invite code? Enter it with your email and we’ll send
        you a link.
      </AuthHead>
      <form className="stack" onSubmit={submit} noValidate>
        <Field
          label="Invite code"
          name="code"
          icon="key"
          mono
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="WEDDING-EXPO"
          maxLength={32}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          error={errors.code}
        />
        <Field
          label="Email"
          type="email"
          name="email"
          icon="mail"
          autoComplete="email"
          inputMode="email"
          placeholder="you@studio.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <Turnstile
          ref={ts}
          siteKey={TURNSTILE_SITE_KEY}
          action={TURNSTILE_ACTIONS.inviteCode}
          onToken={setToken}
          onExpire={() => setToken('')}
        />
        <Button type="submit" kind="primary" size="lg" full busy={busy}>
          Email me a sign-up link
        </Button>
      </form>
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <div className="link-row">
        <span>
          Already a member? <Link to="/sign-in">Sign in</Link>
        </span>
        <span>
          No invite yet? <a href={REQUEST_INVITE_URL}>Request one</a>
        </span>
      </div>
      <Note tone="neutral" icon="link">
        Opening a client gallery? You don’t need an account: use the gallery link and passcode you were sent.
      </Note>
    </AuthLayout>
  );
}
