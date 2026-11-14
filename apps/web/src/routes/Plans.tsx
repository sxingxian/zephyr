import {
  type BillingInterval,
  type BillingStatusResult,
  type PaidPlanId,
  PLANS,
  type PlanId,
} from '@zephyr/shared/client';
import { Button, Chip, Icon, Note, useToast } from '@zephyr/ui';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChangePlanDialog, SecureNote, TAX_NOTE, TopUpDialog } from '../components/billing/BillingDialogs';
import { Segmented } from '../components/LibraryBits';
import { Shell } from '../components/Shell';
import { errorMessage } from '../lib/api';
import { fetchBilling, leave, PLAN_NAME, startCheckout, usd, usePrices } from '../lib/billing';
import { useSession } from '../lib/session';
import '../billing.css';

/** Plan features, in the order the mockup lists them. Numbers come from the plan limits. */
function features(id: PlanId): { text: string; on: boolean }[] {
  const l = PLANS.find((p) => p.id === id)?.limits;
  if (!l) return [];
  const gb = l.storageGb >= 1000 ? `${l.storageGb / 1000} TB` : `${l.storageGb} GB`;
  const credits = `${l.cloudCreditsPerMonth.toLocaleString('en')} cloud AI credits a month`;
  if (id === 'free')
    return [
      { text: 'All manual edits, copy & paste edits', on: true },
      { text: `${gb} storage`, on: true },
      { text: 'Unlimited Zephyr AI on your device', on: true },
      { text: credits, on: true },
      { text: `${l.galleries ?? 3} passcode galleries · links up to ${l.maxLinkDays ?? 7} days`, on: true },
      { text: 'RAW files', on: false },
      { text: 'Team seats', on: false },
    ];
  if (id === 'pro')
    return [
      { text: 'No ads', on: true },
      { text: `${gb} storage`, on: true },
      { text: credits, on: true },
      { text: `Batches of up to ${l.batchSize.toLocaleString('en')} photos`, on: true },
      { text: 'RAW: CR2, NEF, ARW', on: true },
      { text: 'Unlimited galleries, any expiry', on: true },
      { text: 'People grouping and cleanup', on: true },
    ];
  return [
    { text: 'Everything in Pro', on: true },
    { text: `${gb} storage`, on: true },
    { text: credits, on: true },
    { text: `${l.seats} seats: you and ${l.seats - 1} teammates`, on: true },
    { text: 'A shared team library with Editor and Viewer roles', on: true },
    { text: 'Client favourites, watermarks, branding', on: true },
    { text: 'Gallery access log', on: true },
  ];
}
const BLURB: Record<PlanId, string> = {
  free: 'For personal libraries. Includes ads.',
  pro: 'For photographers and creators who edit in bulk.',
  studio: 'For studios delivering client proofs together.',
};
const RANK: Record<PlanId, number> = { free: 0, pro: 1, studio: 2 };

function PlanCard({
  id,
  price,
  per,
  blurb,
  tag,
  highlight,
  cta,
}: {
  id: PlanId;
  price: string;
  per: string;
  blurb: string;
  tag?: React.ReactNode;
  highlight?: boolean;
  cta: React.ReactNode;
}) {
  return (
    <article className={`bl-plan${highlight ? ' bl-plan--hl' : ''}`} aria-labelledby={`plan-${id}`}>
      <div className="bl-plan__head">
        <h2 id={`plan-${id}`} className="bl-plan__name">
          {PLAN_NAME[id]}
        </h2>
        {tag}
      </div>
      <div className="bl-plan__price">
        <span className="bl-plan__amount">{price}</span>
        <span className="z-muted">{per}</span>
      </div>
      <p className="z-muted bl-plan__blurb">{blurb}</p>
      {cta}
      <ul className="bl-plan__list">
        {features(id).map((f) => (
          <li key={f.text} className={f.on ? undefined : 'is-off'}>
            <Icon name={f.on ? 'check' : 'x'} size={16} />
            <span>
              {f.text}
              {!f.on && <span className="z-sr"> (not included)</span>}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Plans (phase 7): prices come from the server (Admin › Plans & billing); constants are only the fallback. */
export function PlansPage() {
  const { user, refresh } = useSession();
  const prices = usePrices();
  const toast = useToast();
  const [status, setStatus] = useState<BillingStatusResult | null>(null);
  const [period, setPeriod] = useState<BillingInterval>('month');
  const [busy, setBusy] = useState<PaidPlanId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<{ plan: PaidPlanId; interval: BillingInterval } | null>(null);
  const [topup, setTopup] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    fetchBilling(c.signal)
      .then((s) => {
        setStatus(s);
        if (s.subscription?.interval) setPeriod(s.subscription.interval);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, []);

  const sub = status?.subscription ?? null;
  const currentPlan: PlanId = status?.plan ?? user?.plan ?? 'free';
  const currentInterval = sub?.interval ?? null;
  const m = prices.plans.pro.month;
  const y = prices.plans.pro.year;
  const monthsFree = m > 0 ? Math.round((12 * m - y) / m) : 0;
  const yearlyLabel = monthsFree >= 1 ? `Yearly · ${monthsFree} months free` : 'Yearly';

  const choose = async (plan: PaidPlanId) => {
    setError(null);
    if (sub) {
      setChange({ plan, interval: period });
      return;
    }
    setBusy(plan);
    try {
      const r = await startCheckout({ kind: 'subscription', plan, interval: period });
      leave.to(r.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const ctaFor = (id: PlanId) => {
    const isCurrent = id === currentPlan && (id === 'free' || currentInterval === period);
    if (isCurrent)
      return (
        <Button full size="lg" disabled>
          Your current plan
        </Button>
      );
    if (id === 'free')
      return sub ? (
        <Link to="/settings/billing" className="z-btn z-btn--secondary z-btn--lg z-btn--full">
          <span>Cancel in Plan &amp; billing</span>
        </Link>
      ) : (
        <Button full size="lg" disabled>
          Your current plan
        </Button>
      );
    const label =
      id === currentPlan
        ? `Switch to ${period === 'year' ? 'yearly' : 'monthly'}`
        : RANK[id] > RANK[currentPlan]
          ? id === 'pro'
            ? 'Upgrade to Pro'
            : 'Choose Studio'
          : `Move to ${PLAN_NAME[id]}`;
    return (
      <Button
        full
        size="lg"
        kind={id === 'pro' ? 'primary' : 'secondary'}
        busy={busy === id}
        disabled={!status || busy !== null}
        onClick={() => void choose(id)}
      >
        {label}
      </Button>
    );
  };

  const paid = (id: PaidPlanId) => {
    const amount = prices.plans[id][period];
    const monthly = Math.round(prices.plans[id].year / 12);
    return {
      price: usd(amount, { plain: true }),
      per: period === 'year' ? '/ year' : '/ month',
      blurb: period === 'year' ? `${usd(monthly)} a month, billed yearly.` : BLURB[id],
    };
  };
  const pack = prices.packs[0];

  return (
    <Shell title="Plans">
      <div className="bl-plans">
        <header className="bl-plans__head">
          <h2 className="bl-plans__title">Pick the plan that fits your shoots</h2>
          <p className="z-muted">
            Manual editing and on-device Zephyr AI are free on every plan. Plans add storage, cloud AI
            credits, pro sharing and team seats.
          </p>
          <Segmented
            label="Billing period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'month', label: 'Monthly' },
              { value: 'year', label: yearlyLabel },
            ]}
          />
        </header>
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
        <div className="bl-plans__grid">
          <PlanCard
            id="free"
            price="$0"
            per="forever"
            blurb={BLURB.free}
            tag={currentPlan === 'free' ? <Chip>Current plan</Chip> : undefined}
            cta={ctaFor('free')}
          />
          <PlanCard
            id="pro"
            {...paid('pro')}
            highlight
            tag={currentPlan === 'pro' ? <Chip>Current plan</Chip> : <Chip tone="ink">Recommended</Chip>}
            cta={ctaFor('pro')}
          />
          <PlanCard
            id="studio"
            {...paid('studio')}
            tag={currentPlan === 'studio' ? <Chip>Current plan</Chip> : undefined}
            cta={ctaFor('studio')}
          />
        </div>
        <div className="bl-plans__extras">
          {pack && (
            <section className="z-card bl-row-card bl-plans__topup">
              <span className="bl-tile">
                <Icon name="breeze" size={20} />
              </span>
              <div className="bl-row-card__text">
                <strong>Need more background removals?</strong>
                <span className="z-muted">
                  Top-up credits last 12 months, work on any plan, and are used after your monthly credits.
                </span>
              </div>
              <span className="mono bl-strong">
                {usd(pack.amount, { plain: true })} · {pack.credits.toLocaleString('en')} credits
              </span>
              <Button size="sm" onClick={() => setTopup(true)}>
                Buy credits
              </Button>
            </section>
          )}
          <section className="z-card bl-plans__secure">
            <SecureNote />
            <span className="z-muted">
              Zephyr never sees your card. Switch plans or cancel any time from Plan &amp; billing.
            </span>
          </section>
        </div>
        <p className="bl-foot">
          {TAX_NOTE} Payments are processed by Stripe’s Link, which acts as the reseller and handles sales
          tax, VAT and GST.
        </p>
      </div>
      <ChangePlanDialog
        open={change !== null}
        target={change}
        current={{ plan: currentPlan, interval: currentInterval }}
        onClose={() => setChange(null)}
        onDone={(r, kind) => {
          setStatus(r);
          void refresh();
          toast.show(
            kind === 'upgrade'
              ? `You’re on ${PLAN_NAME[r.plan]} now.`
              : `Your plan changes at your renewal. ${PLAN_NAME[currentPlan]} stays on until then.`,
            'good',
          );
        }}
      />
      <TopUpDialog open={topup} packs={prices.packs} onClose={() => setTopup(false)} />
    </Shell>
  );
}
