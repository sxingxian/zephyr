import type { BillingInterval, BillingStatusResult, PaidPlanId } from '@zephyr/shared/client';
import { Button, Chip, Icon, Note, Spinner, useToast } from '@zephyr/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChangePlanDialog, TAX_NOTE, TopUpDialog } from '../components/billing/BillingDialogs';
import { Banner } from '../components/LibraryBanner';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';
import { useAiStatus } from '../lib/aiClient';
import { errorMessage } from '../lib/api';
import {
  fetchBilling,
  leave,
  longDate,
  openPortal,
  PLAN_NAME,
  undoScheduledChange,
  usd,
  usePrices,
} from '../lib/billing';
import { switchLibrary, useActiveLibrary, useLibraries } from '../lib/libraryContext';
import { useSession } from '../lib/session';
import { formatBytes, formatOf } from '../lib/usage';
import '../billing.css';

const per = (i: BillingInterval) => (i === 'year' ? 'a year' : 'a month');

export function Meter({
  label,
  value,
  pct,
  tone = 'acc',
}: {
  label: string;
  value: string;
  pct: number;
  tone?: 'acc' | 'good' | 'warn' | 'bad';
}) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="meter">
      <div className="meter__row">
        <span>{label}</span>
        <span className="meter__val">{value}</span>
      </div>
      <div
        className={`meter__bar meter__bar--${tone}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={p}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={value}
      >
        <span style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function RowCard({
  icon,
  title,
  children,
  action,
}: {
  icon?: 'breeze';
  title: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <section className="z-card bl-row-card">
      {icon && (
        <span className="bl-tile">
          <Icon name={icon} size={20} />
        </span>
      )}
      <div className="bl-row-card__text">
        <h2 className="bl-h3">{title}</h2>
        <span className="z-muted">{children}</span>
      </div>
      {action}
    </section>
  );
}

/** Credits meters from the AI status (the library's own credits; Plan & billing is shown in the own library). */
function CreditMeters() {
  const ai = useAiStatus();
  const c = ai?.credits;
  if (!c) return null;
  const top = (c.topUps ?? []).reduce((n, t) => n + t.credits, 0);
  const soonest = c.topUps?.[0]?.expiresAt;
  return (
    <>
      <Meter
        label="Monthly credits"
        value={`${(c.monthlyBalance ?? c.balance).toLocaleString('en')} / ${c.monthly.toLocaleString('en')}`}
        pct={c.monthly ? ((c.monthlyBalance ?? c.balance) / c.monthly) * 100 : 0}
        tone="good"
      />
      {top > 0 && (
        <Meter
          label="Top-up credits"
          value={`${top.toLocaleString('en')}${soonest ? ` · to ${new Date(soonest).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : ''}`}
          pct={100}
          tone="good"
        />
      )}
    </>
  );
}

/** A teammate looking at Plan & billing while working in a team library. */
function TeammateView() {
  const lib = useActiveLibrary();
  const libs = useLibraries();
  const ai = useAiStatus();
  const { user } = useSession();
  const own = libs?.[0];
  const name = lib.summary?.name ?? 'This team';
  const c = ai?.credits;
  return (
    <>
      <section className="z-card">
        <div className="bl-col">
          <h2 className="bl-h2">
            {name} is on {PLAN_NAME[lib.summary?.plan ?? 'studio']}
          </h2>
          <span className="z-muted">
            {lib.summary?.ownerName ?? 'The team’s owner'} manages the plan, seats and billing for this team
            library. Your own library has its own plan.
          </span>
        </div>
        {c && (
          <div className="bl-meters">
            <Meter
              label="Team cloud credits"
              value={`${c.balance.toLocaleString('en')} of ${c.monthly.toLocaleString('en')} left`}
              pct={c.monthly ? (c.balance / c.monthly) * 100 : 0}
              tone="good"
            />
          </div>
        )}
      </section>
      <Note tone="neutral" icon="info">
        Credits you use in {name} come from the team, not from your own library.
      </Note>
      {own && user && (
        <RowCard
          title={`Your own plan: ${PLAN_NAME[user.plan]}`}
          action={
            <Button size="sm" onClick={() => void switchLibrary(own.ownerId)}>
              Switch to your library
            </Button>
          }
        >
          Switch to your own library to change your plan or buy credits.
        </RowCard>
      )}
    </>
  );
}

/** Settings › Plan & billing (phase 7). */
export function BillingPage() {
  const lib = useActiveLibrary();
  const { refresh } = useSession();
  const toast = useToast();
  const prices = usePrices();
  const [status, setStatus] = useState<BillingStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [change, setChange] = useState<{ plan: PaidPlanId; interval: BillingInterval } | null>(null);
  const [topup, setTopup] = useState(false);

  useEffect(() => {
    if (!lib.self) return;
    const c = new AbortController();
    fetchBilling(c.signal)
      .then(setStatus)
      .catch((e) => (e as Error).name !== 'AbortError' && setError(errorMessage(e)));
    return () => c.abort();
  }, [lib.self]);

  const portal = async () => {
    setBusy('portal');
    try {
      const r = await openPortal();
      leave.to(r.url);
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
      setBusy(null);
    }
  };
  const keep = async () => {
    setBusy('keep');
    try {
      setStatus(await undoScheduledChange());
      toast.show('Your plan stays as it is.', 'good');
    } catch (e) {
      toast.show(errorMessage(e), 'bad');
    } finally {
      setBusy(null);
    }
  };

  const sub = status?.subscription ?? null;
  const planName = status ? PLAN_NAME[status.plan] : '';
  const yearlySaving =
    sub && sub.interval === 'month' ? sub.price.amount * 12 - prices.plans[sub.plan].year : 0;

  let content: ReactNode;
  if (!lib.self) content = <TeammateView />;
  else if (!status)
    content = error ? (
      <Note tone="bad" icon="alert" role="alert">
        {error}
      </Note>
    ) : (
      <Spinner size={20} label="Loading Plan & billing" />
    );
  else
    content = (
      <>
        {sub?.priceChange && (
          <Banner
            tone="acc"
            icon="info"
            title={`${PLAN_NAME[sub.plan]}’s price changes on ${longDate(sub.priceChange.at)}`}
            actions={
              <Link to="/plans" className="z-btn z-btn--secondary z-btn--sm">
                <span>Compare plans</span>
              </Link>
            }
          >
            From your renewal on {longDate(sub.priceChange.at)}, {PLAN_NAME[sub.plan]} is{' '}
            {usd(sub.priceChange.amount)} {per(sub.interval)}. You can switch plans or cancel before then.
          </Banner>
        )}
        {sub?.status === 'past_due' && (
          <Banner
            tone="bad"
            icon="alert"
            title="Your last payment didn’t go through"
            actions={
              status.hasCustomer ? (
                <Button
                  size="sm"
                  kind="primary"
                  iconRight="external"
                  busy={busy === 'portal'}
                  onClick={portal}
                >
                  Update card
                </Button>
              ) : undefined
            }
          >
            Stripe will try your card again. Update it to keep {PLAN_NAME[sub.plan]}; if the payment keeps
            failing, your plan ends and anything over Free’s limits becomes read-only.
          </Banner>
        )}
        {status.state === 'read_only' && (
          <Banner tone="warn" icon="lock" title="Your library is read-only">
            You use {formatBytes(status.storage.usedBytes)} and {planName} includes{' '}
            {formatBytes(status.storage.limitBytes)}. You can view, download, share existing galleries and
            delete photos, but not upload or edit. Nothing is deleted.
          </Banner>
        )}
        <section className="z-card">
          <div className="bl-plan-head">
            <div className="bl-col">
              <span className="bl-plan-head__title">
                <h2 className="bl-h2">{planName} plan</h2>
                {sub && <Chip tone="outline">{sub.interval === 'year' ? 'Yearly' : 'Monthly'}</Chip>}
                {sub?.status === 'past_due' ? (
                  <Chip tone="bad" dot>
                    Payment due
                  </Chip>
                ) : sub?.scheduledChange ? (
                  <Chip tone="warn" dot>
                    Changes on {longDate(sub.scheduledChange.at)}
                  </Chip>
                ) : sub?.cancelAtPeriodEnd ? (
                  <Chip tone="warn" dot>
                    Ends on {longDate(sub.currentPeriodEnd)}
                  </Chip>
                ) : sub ? (
                  <Chip tone="good" dot>
                    Active
                  </Chip>
                ) : null}
              </span>
              <span className="z-muted">
                {!sub
                  ? status.plan === 'free'
                    ? 'Includes ads. Upgrade for more storage, cloud credits and pro sharing.'
                    : 'Your plan is managed by Zephyr.'
                  : sub.scheduledChange
                    ? `Moves to ${PLAN_NAME[sub.scheduledChange.plan]} (${sub.scheduledChange.interval === 'year' ? 'yearly' : 'monthly'}) on ${longDate(sub.scheduledChange.at)}. Until then everything in ${planName} stays on.`
                    : sub.cancelAtPeriodEnd
                      ? `Moves to Free on ${longDate(sub.currentPeriodEnd)}. Until then everything in ${planName} stays on.`
                      : `${usd(sub.price.amount)} ${per(sub.interval)} · renews on ${longDate(sub.currentPeriodEnd)}`}
              </span>
            </div>
            <div className="bl-actions">
              {!sub ? (
                <Link to="/plans" className="z-btn z-btn--primary z-btn--sm">
                  <span>See plans</span>
                </Link>
              ) : sub.scheduledChange ? (
                <Button size="sm" kind="primary" busy={busy === 'keep'} onClick={keep}>
                  Keep {planName}
                </Button>
              ) : sub.cancelAtPeriodEnd ? (
                <Button
                  size="sm"
                  kind="primary"
                  iconRight="external"
                  busy={busy === 'portal'}
                  onClick={portal}
                >
                  Keep {planName}
                </Button>
              ) : (
                <>
                  <Link to="/plans" className="z-btn z-btn--primary z-btn--sm">
                    <span>Change plan</span>
                  </Link>
                  {sub.interval === 'month' && (
                    <Button size="sm" onClick={() => setChange({ plan: sub.plan, interval: 'year' })}>
                      {yearlySaving > 0 ? `Switch to yearly · save ${usd(yearlySaving)}` : 'Switch to yearly'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="bl-meters">
            <Meter
              label="Storage"
              value={formatOf(status.storage.usedBytes, status.storage.limitBytes)}
              pct={
                status.storage.limitBytes ? (status.storage.usedBytes / status.storage.limitBytes) * 100 : 0
              }
              tone={status.state === 'read_only' ? 'bad' : 'acc'}
            />
            <CreditMeters />
          </div>
        </section>
        {status.hasCustomer && (
          <RowCard
            title="Payment and invoices"
            action={
              <Button size="sm" iconRight="external" busy={busy === 'portal'} onClick={portal}>
                Manage in Stripe
              </Button>
            }
          >
            Your card, billing address and full invoices are managed securely by Stripe. Zephyr never sees
            card numbers.
          </RowCard>
        )}
        {status.packs.length > 0 && (
          <RowCard
            icon="breeze"
            title="Buy cloud credits"
            action={
              <Button size="sm" onClick={() => setTopup(true)}>
                Buy credits
              </Button>
            }
          >
            {status.packs[0]?.credits.toLocaleString('en')} credits for {usd(status.packs[0]?.amount ?? 0)}.
            They last 12 months and are used after your monthly credits.
          </RowCard>
        )}
        {sub && !sub.cancelAtPeriodEnd && sub.status !== 'past_due' && (
          <RowCard
            title="Cancel your plan"
            action={
              <Button size="sm" busy={busy === 'portal'} onClick={portal}>
                Cancel plan
              </Button>
            }
          >
            You keep {planName} until {longDate(sub.currentPeriodEnd)}. After that you’re on Free: photos are
            kept, galleries stay live until they expire, and anything over Free’s limits becomes read-only.
          </RowCard>
        )}
        <Note tone="neutral" icon="lock">
          {TAX_NOTE} Stripe’s Link is the reseller for Zephyr plans and sends your receipts.
        </Note>
      </>
    );

  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">{content}</div>
      </div>
      {status && (
        <ChangePlanDialog
          open={change !== null}
          target={change}
          current={{ plan: status.plan, interval: sub?.interval ?? null }}
          onClose={() => setChange(null)}
          onDone={(r, kind) => {
            setStatus(r);
            void refresh();
            toast.show(
              kind === 'upgrade'
                ? 'Your plan renews yearly from today.'
                : 'Your plan changes at your renewal.',
              'good',
            );
          }}
        />
      )}
      {status && <TopUpDialog open={topup} packs={status.packs} onClose={() => setTopup(false)} />}
    </Shell>
  );
}
