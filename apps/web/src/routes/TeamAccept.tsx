import type { TeamInvitePreview } from '@zephyr/shared/client';
import { Button, Note, Spinner, useToast } from '@zephyr/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthHead, AuthLayout } from '../components/AuthLayout';
import { ApiFailure, errorMessage } from '../lib/api';
import { acceptTeamInvite, previewTeamInvite } from '../lib/billing';
import { getLibraries, setLibraries, switchLibrary } from '../lib/libraryContext';
import { useSession } from '../lib/session';

/** `#token=…` (or `#t=…`, the phase-1 invite form) holding 32 random bytes in base64url. */
const TOKEN_RE = /(?:^|[#&])(?:token|t)=([A-Za-z0-9_-]{43})(?:&|$)/;
const ROLE_NAME = { editor: 'Editor', viewer: 'Viewer' } as const;

/** The token, once taken from the URL. Memory only: it survives the in-app sign-in, never storage. */
let taken: string | null = null;

/**
 * Reads the team invite token from the URL fragment and strips it from the address bar straight away, so it
 * doesn't stay in history, screenshots or shared links (the fragment is never sent to servers either).
 */
export function takeTeamInviteToken(): string | null {
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
export function forgetTeamInviteToken(): void {
  taken = null;
}

/** /team/accept: join a Studio team library from an invite email. */
export function TeamAcceptPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { user } = useSession();
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = takeTeamInviteToken();
  const [preview, setPreview] = useState<TeamInvitePreview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'missing' | 'error'>(
    token.current ? 'loading' : 'missing',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = token.current;
    if (!t) return;
    let live = true;
    previewTeamInvite(t)
      .then((r) => {
        if (!live) return;
        setPreview(r.invite);
        setState('ready');
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiFailure && (e.code === 'invite_invalid' || e.code === 'not_found'))
          setState('invalid');
        else {
          setError(errorMessage(e));
          setState('error');
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const accept = async () => {
    const t = token.current;
    if (!t || !preview) return;
    setBusy(true);
    setError(null);
    const before = new Set((getLibraries() ?? []).map((l) => l.ownerId));
    try {
      const r = await acceptTeamInvite(t);
      forgetTeamInviteToken();
      setLibraries(r.libraries);
      const joined =
        r.libraries.slice(1).find((l) => !before.has(l.ownerId)) ??
        r.libraries.slice(1).find((l) => l.name === preview.teamName);
      toast.show(`You joined ${preview.teamName}.`, 'good');
      if (joined) await switchLibrary(joined.ownerId);
      else nav('/', { replace: true });
    } catch (e) {
      setError(
        e instanceof ApiFailure && e.code === 'invite_invalid'
          ? `This invite only works for ${preview.emailHint}. Sign out, then sign in with that address.`
          : e instanceof ApiFailure && e.code === 'limit_reached'
            ? `${preview.teamName} has no free seat right now. Ask ${preview.ownerName} to make room.`
            : errorMessage(e),
      );
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <AuthLayout pose="hop" line="Opening your invite…" tone="lilac" footer={false}>
        <div className="center-block">
          <Spinner size={24} label="Checking your invite" />
        </div>
      </AuthLayout>
    );
  }
  if (state !== 'ready' || !preview) {
    return (
      <AuthLayout pose="ponder" line="That invite blew away." tone="lilac" footer={false}>
        <AuthHead
          title={state === 'error' ? 'We couldn’t open this invite' : 'This invite link doesn’t work'}
        >
          {state === 'missing'
            ? 'The link looks incomplete. Open it straight from the invite email, or ask for a new one.'
            : state === 'invalid'
              ? 'It may have expired, been used already, or been cancelled. Ask whoever invited you for a new one.'
              : error}
        </AuthHead>
        <Link to={user ? '/' : '/sign-in'} className="z-btn z-btn--primary z-btn--lg z-btn--full">
          {user ? 'Back to your library' : 'Sign in'}
        </Link>
      </AuthLayout>
    );
  }

  const role = ROLE_NAME[preview.role];
  return (
    <AuthLayout pose="wave" line="Someone saved you a seat." tone="lilac" footer={false}>
      <AuthHead title={`Join ${preview.teamName}`}>
        {preview.ownerName} invited <strong>{preview.emailHint}</strong> to {preview.teamName} as a{' '}
        <strong>{role}</strong>. You’ll see their team library next to your own.
      </AuthHead>
      {user ? (
        <Button kind="primary" size="lg" full busy={busy} onClick={accept}>
          Accept and open {preview.teamName}
        </Button>
      ) : (
        <>
          <Button
            kind="primary"
            size="lg"
            full
            onClick={() => nav(`/sign-in?next=${encodeURIComponent('/team/accept')}`)}
          >
            Sign in to accept
          </Button>
          {preview.needsAccount && (
            <Button
              size="lg"
              full
              onClick={() => {
                // The team invite is also a sign-up invite: the join page takes it from the fragment and
                // strips it again at once.
                const t = token.current;
                forgetTeamInviteToken();
                nav({ pathname: '/join', hash: `t=${t ?? ''}` });
              }}
            >
              Create a Zephyr account
            </Button>
          )}
        </>
      )}
      {error && (
        <Note tone="warn" icon="alert" role="alert">
          {error}
        </Note>
      )}
      <span className="z-hint">
        This invite only works for {preview.emailHint}. Not you? You can ignore it; it expires on its own.
      </span>
    </AuthLayout>
  );
}
