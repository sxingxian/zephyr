import type { GuestGalleryInfo } from '@zephyr/shared/client';
import { Button, CodeInput, Icon, Mascot, Turnstile, type TurnstileHandle } from '@zephyr/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { TURNSTILE_SITE_KEY } from '../lib/config';
import { GUEST_UNLOCK_ACTION, GuestApiError, unlock } from './api';
import { brandingOn } from './brand';
import { accentStyle, CardScreen, formatCountdown, StudioBadge } from './Chrome';

type Problem =
  | { kind: 'wrong'; remaining: number | null }
  | { kind: 'rate'; until: number }
  | { kind: 'turnstile' }
  | { kind: 'network' }
  | null;

export interface PasscodeProps {
  token: string;
  info: GuestGalleryInfo;
  onUnlocked: () => void;
  /** The gallery paused (423): the caller shows the paused screen. */
  onPaused: (until: number) => void;
  now?: () => number;
}

/** Passcode entry: six boxes, Turnstile after repeated wrong codes, clear messages for every outcome. */
export function Passcode({ token, info, onUnlocked, onPaused, now = Date.now }: PasscodeProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [needsCheck, setNeedsCheck] = useState(info.turnstile);
  const [tsToken, setTsToken] = useState<string | null>(null);
  const ts = useRef<TurnstileHandle>(null);
  const form = useRef<HTMLFormElement>(null);
  const [, tick] = useState(0);

  const rateLeft = problem?.kind === 'rate' ? Math.max(0, (problem.until - now()) / 1000) : 0;
  useEffect(() => {
    if (problem?.kind !== 'rate') return;
    const t = setInterval(() => {
      if (problem.until <= now()) setProblem(null);
      tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [problem, now]);

  const submit = async (value: string) => {
    if (busy || value.length !== 6 || problem?.kind === 'rate') return;
    if (needsCheck && !tsToken) {
      setProblem({ kind: 'turnstile' });
      return;
    }
    setBusy(true);
    const used = tsToken;
    try {
      await unlock(token, used ? { passcode: value, turnstileToken: used } : { passcode: value });
      onUnlocked();
      return;
    } catch (e) {
      // Turnstile tokens are single-use.
      if (used) {
        setTsToken(null);
        ts.current?.reset();
      }
      setCode('');
      if (!(e instanceof GuestApiError) || e.status === 0) setProblem({ kind: 'network' });
      else if (e.status === 423) {
        const until = typeof e.body?.pausedUntil === 'string' ? Date.parse(e.body.pausedUntil) : NaN;
        onPaused(Number.isFinite(until) ? until : now() + (e.retryAfter ?? 900) * 1000);
      } else if (e.status === 429) setProblem({ kind: 'rate', until: now() + (e.retryAfter ?? 900) * 1000 });
      else if (e.status === 401 || e.code === 'wrong_passcode') {
        const remaining = typeof e.body?.remaining === 'number' ? e.body.remaining : null;
        if (e.body?.turnstile === true) setNeedsCheck(true);
        setProblem({ kind: 'wrong', remaining });
      } else if (e.status === 400 && e.code === 'verification_failed') {
        setNeedsCheck(true);
        setProblem({ kind: 'turnstile' });
      } else setProblem({ kind: 'network' });
      // Back to the first box for the next try.
      requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('input')?.focus());
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(code);
  };
  const branded = brandingOn(info.brand);
  const message =
    problem?.kind === 'wrong'
      ? problem.remaining !== null && problem.remaining > 0
        ? `Wrong passcode. ${problem.remaining} ${problem.remaining === 1 ? 'try' : 'tries'} left before a 15-minute pause.`
        : 'Wrong passcode. Check the code and try again.'
      : problem?.kind === 'rate'
        ? `Too many tries from your network. Try again in ${formatCountdown(rateLeft)}.`
        : problem?.kind === 'turnstile'
          ? 'Complete the security check, then try again.'
          : problem?.kind === 'network'
            ? 'That didn’t go through. Check your connection and try again.'
            : null;

  return (
    <CardScreen style={accentStyle(info.brand)}>
      {branded ? (
        <StudioBadge brand={info.brand} size={88} />
      ) : (
        <Mascot pose="guard" width={140} tile={{ background: '#E3E9F5', height: 150, radius: 32 }} />
      )}
      <div className="g-card__titles">
        <span className="g-muted">{info.brand.studioName} shared</span>
        <h1 className="g-card__title">{info.name}</h1>
      </div>
      <form ref={form} className="g-pass" onSubmit={onSubmit} noValidate>
        <p className="g-pass__label" id="g-pass-label">
          Enter the 6-digit passcode
        </p>
        <CodeInput
          value={code}
          onChange={(v) => {
            setCode(v);
            if (problem?.kind === 'wrong' || problem?.kind === 'network') setProblem(null);
          }}
          onComplete={(v) => void submit(v)}
          label="6-digit passcode"
          invalid={problem?.kind === 'wrong'}
          disabled={busy || problem?.kind === 'rate'}
          autoFocus
        />
        <p className="g-pass__msg" role="alert" aria-live="assertive">
          {message && (
            <>
              <Icon name="alert" size={16} />
              {message}
            </>
          )}
        </p>
        {needsCheck && TURNSTILE_SITE_KEY && (
          <Turnstile
            ref={ts}
            siteKey={TURNSTILE_SITE_KEY}
            action={GUEST_UNLOCK_ACTION}
            onToken={(t) => {
              setTsToken(t);
              if (problem?.kind === 'turnstile') setProblem(null);
            }}
            onExpire={() => setTsToken(null)}
          />
        )}
        <Button
          type="submit"
          kind="primary"
          size="lg"
          full
          busy={busy}
          disabled={code.length !== 6 || problem?.kind === 'rate'}
          className="g-acc-btn"
        >
          Open gallery
        </Button>
      </form>
      <p className="g-fine">
        <Icon name="shield" size={15} />
        <span>
          This gallery is private. Photos load over short-lived signed links and are hidden from search
          engines. Don’t have the code? Ask the person who sent you the link.
        </span>
      </p>
    </CardScreen>
  );
}

/** Shown while a gallery is paused after too many wrong passcodes from anywhere. */
export function Paused({
  info,
  until,
  onDone,
  now = Date.now,
}: {
  info: GuestGalleryInfo;
  until: number;
  onDone: () => void;
  now?: () => number;
}) {
  const [left, setLeft] = useState(() => (until - now()) / 1000);
  useEffect(() => {
    const t = setInterval(() => {
      const l = (until - now()) / 1000;
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onDone();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until, now, onDone]);
  const branded = brandingOn(info.brand);
  return (
    <CardScreen style={accentStyle(info.brand)}>
      {branded ? (
        <StudioBadge brand={info.brand} size={88} />
      ) : (
        <Mascot pose="ponder" width={140} tile={{ background: '#F1E9DB', height: 150, radius: 32 }} />
      )}
      <div className="g-card__titles">
        <span className="g-muted">{info.brand.studioName} shared</span>
        <h1 className="g-card__title">{info.name}</h1>
      </div>
      <div className="g-paused" role="alert">
        <h2>Too many tries</h2>
        <p>To keep these photos private, this gallery is paused for a little while.</p>
        <span className="g-muted">Try again in</span>
        <span className="g-paused__time" aria-live="off">
          {formatCountdown(left)}
        </span>
      </div>
      <p className="g-fine g-fine--center">Check the passcode with the person who shared this link.</p>
    </CardScreen>
  );
}
