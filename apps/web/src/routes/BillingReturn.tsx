import type { CheckoutStatusResult } from '@zephyr/shared/client';
import { Mascot, Spinner } from '@zephyr/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Shell } from '../components/Shell';
import { refreshAiStatus } from '../lib/aiClient';
import { ApiFailure } from '../lib/api';
import { checkoutStatus, PLAN_NAME } from '../lib/billing';
import { useSession } from '../lib/session';
import { refreshUsage } from '../lib/usage';
import '../billing.css';

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/** Poll every 2 s for up to a minute; the API applies the session itself if the webhook is slow. */
export const POLL = { everyMs: 2000, forMs: 60_000 };

const PLAN_WINS = {
  pro: 'Ads are gone, RAW uploads are on, and your Pro cloud credits are ready.',
  studio: 'Your Studio storage and credits are ready, and you can invite 2 teammates from Settings › Team.',
  free: '',
} as const;

/** Back from Stripe Checkout: wait for the payment to be confirmed, then welcome the member. */
export function BillingReturnPage() {
  const [params] = useSearchParams();
  const { user, refresh } = useSession();
  const id = params.get('session_id') ?? '';
  const valid = SESSION_RE.test(id);
  const [res, setRes] = useState<CheckoutStatusResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [gone, setGone] = useState(!valid);
  const applied = useRef(false);

  useEffect(() => {
    if (!valid) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await checkoutStatus(id);
        if (stop) return;
        setRes(r);
        if (r.state !== 'pending') return;
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiFailure && (e.code === 'not_found' || e.code === 'forbidden')) {
          setGone(true);
          return;
        }
      }
      if (Date.now() - started >= POLL.forMs) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL.everyMs);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, valid]);

  // Once applied: re-read the session (plan), AI status (credits) and usage (storage).
  useEffect(() => {
    if (res?.state !== 'done' || applied.current) return;
    applied.current = true;
    void refresh();
    void refreshAiStatus({ fresh: true });
    void refreshUsage();
  }, [res, refresh]);

  const done = res?.state === 'done';
  const failed = res?.state === 'failed';
  const refunded = res?.state === 'refunded';
  let body: React.ReactNode;
  if (gone) {
    body = (
      <>
        <h2 className="bl-return__title">We couldn’t find that checkout</h2>
        <p className="bl-return__text">If you paid, your plan updates as soon as Stripe confirms it.</p>
        <div className="bl-return__actions">
          <Link to="/settings/billing" className="z-btn z-btn--primary z-btn--md">
            <span>Plan &amp; billing</span>
          </Link>
        </div>
      </>
    );
  } else if (failed) {
    body = (
      <>
        <h2 className="bl-return__title">The payment didn’t go through</h2>
        <p className="bl-return__text">
          Nothing was charged and your plan hasn’t changed. You can try again.
        </p>
        <div className="bl-return__actions">
          <Link to="/plans" className="z-btn z-btn--primary z-btn--md">
            <span>Back to plans</span>
          </Link>
        </div>
      </>
    );
  } else if (refunded) {
    body = (
      <>
        <h2 className="bl-return__title">You already have a plan</h2>
        <p className="bl-return__text">
          You already have a plan, so this purchase was refunded. Your plan hasn’t changed.
        </p>
        <div className="bl-return__actions">
          <Link to="/settings/billing" className="z-btn z-btn--primary z-btn--md">
            <span>Plan &amp; billing</span>
          </Link>
        </div>
      </>
    );
  } else if (done) {
    const topup = res.kind === 'topup';
    const plan = res.plan && res.plan !== 'free' ? res.plan : null;
    body = (
      <>
        <h2 className="bl-return__title">
          {topup
            ? `${(res.credits ?? 0).toLocaleString('en')} credits added`
            : plan
              ? `You’re on ${PLAN_NAME[plan]}`
              : 'You’re all set'}
        </h2>
        <p className="bl-return__text">
          {topup
            ? 'They last 12 months and are used after your monthly credits.'
            : plan
              ? PLAN_WINS[plan]
              : ''}{' '}
          {user ? `A receipt is on its way to ${user.email}.` : ''}
        </p>
        <div className="bl-return__actions">
          <Link to="/" className="z-btn z-btn--primary z-btn--md">
            <span>Back to your library</span>
          </Link>
          <Link to="/settings/billing" className="z-btn z-btn--secondary z-btn--md">
            <span>Plan &amp; billing</span>
          </Link>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h2 className="bl-return__title">Confirming your payment…</h2>
        <p className="bl-return__text">
          {timedOut
            ? 'Stripe is taking longer than usual. Zephyr switches your plan as soon as Stripe confirms it. You can close this page.'
            : 'Stripe has your payment. Zephyr switches your plan as soon as Stripe confirms it, usually within a few seconds. You can close this page.'}
        </p>
        {!timedOut && (
          <span className="bl-return__wait" role="status">
            <Spinner size={16} />
            Waiting for Stripe
          </span>
        )}
      </>
    );
  }
  return (
    <Shell title="Plans">
      <section className="bl-return" aria-live="polite">
        <Mascot
          pose={done ? 'hop' : failed || gone || refunded ? 'ponder' : 'guard'}
          width={140}
          tile={{ background: 'var(--m-mist)', height: 150 }}
          className="bl-return__art"
        />
        {body}
      </section>
    </Shell>
  );
}
