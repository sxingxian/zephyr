import type {
  BillingInterval,
  PaidPlanId,
  PlanChangePreviewResult,
  PlanChangeResult,
  PlanId,
  TopUpLookupKey,
} from '@zephyr/shared/client';
import { Button, Dialog, Icon, Note, Spinner } from '@zephyr/ui';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { changePlan, leave, longDate, PLAN_NAME, previewChange, startCheckout, usd } from '../../lib/billing';

/** Invoice-style rows with a total, as in the upgrade and top-up dialogs. */
export function LineItems({
  rows,
  total,
}: {
  rows: { label: ReactNode; amount: string; sub?: ReactNode }[];
  total: [ReactNode, string];
}) {
  return (
    <div className="bl-lines">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids and never reorder
        <div className="bl-lines__row" key={i}>
          <span className="bl-lines__what">
            <span>{r.label}</span>
            {r.sub && <span className="bl-lines__sub">{r.sub}</span>}
          </span>
          <span className="mono">{r.amount}</span>
        </div>
      ))}
      <div className="bl-lines__row bl-lines__row--total">
        <strong>{total[0]}</strong>
        <strong className="mono">{total[1]}</strong>
      </div>
    </div>
  );
}

const GB = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString('en')} TB` : `${n.toLocaleString('en')} GB`;

/**
 * Change an existing subscription (phase 7: in the app, not the Stripe portal). Shows the server's preview
 * first: an upgrade lists the prorated lines and the amount due now; a downgrade lists what changes at the
 * renewal. An upgrade that needs the card confirmed returns a Stripe invoice page, which we open.
 */
export function ChangePlanDialog({
  open,
  target,
  current,
  onClose,
  onDone,
}: {
  open: boolean;
  target: { plan: PaidPlanId; interval: BillingInterval } | null;
  current: { plan: PlanId; interval: BillingInterval | null };
  onClose: () => void;
  onDone: (r: PlanChangeResult, kind: 'upgrade' | 'downgrade') => void;
}) {
  const [preview, setPreview] = useState<PlanChangePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !target) return;
    setPreview(null);
    setError(null);
    let live = true;
    previewChange(target)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [open, target]);

  const go = async () => {
    if (!target || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await changePlan(target);
      if (r.actionUrl) {
        leave.to(r.actionUrl);
        return;
      }
      onDone(r, preview.kind);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const curName = PLAN_NAME[current.plan];
  const name = target ? PLAN_NAME[target.plan] : '';
  const sameplan = target?.plan === current.plan;
  const up = preview?.kind === 'upgrade';
  const title = !preview
    ? sameplan
      ? `Switch to ${target?.interval === 'year' ? 'yearly' : 'monthly'}`
      : `Change to ${name}`
    : up
      ? sameplan
        ? 'Switch to yearly'
        : `Upgrade to ${name}`
      : `Move to ${sameplan ? `${name} ${target?.interval === 'year' ? 'yearly' : 'monthly'}` : name} on ${longDate(preview.effectiveAt)}?`;
  const due = preview?.dueNow ? usd(preview.dueNow.amount) : null;
  const fx = preview?.effects;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            {preview && !up ? `Keep ${curName}` : 'Cancel'}
          </Button>
          <Button kind="primary" busy={busy} disabled={!preview} onClick={go}>
            {!preview
              ? 'Continue'
              : up
                ? due
                  ? `Pay ${due} and upgrade`
                  : 'Upgrade now'
                : `Move to ${name} on ${longDate(preview.effectiveAt)}`}
          </Button>
        </>
      }
    >
      <div className="bl-dialog">
        {!preview && !error && <Spinner size={20} label="Working out the change" />}
        {preview && up && (
          <>
            <span className="z-muted">Takes effect now</span>
            <LineItems
              rows={preview.lines.map((l) => ({ label: l.description, amount: usd(l.amount) }))}
              total={['Due today', due ?? usd(0)]}
            />
            {target && (
              <p>
                {sameplan
                  ? 'Your plan renews yearly from today.'
                  : `You get ${name}’s monthly credits straight away${
                      target.plan === 'studio' ? ', and can invite teammates' : ''
                    }.`}
              </p>
            )}
            <Note tone="neutral" icon="lock">
              Charged to the card you use with Stripe. Tax is added where it applies. Your plan changes once
              the payment goes through.
            </Note>
          </>
        )}
        {preview && !up && fx && target && (
          <>
            <span className="z-muted">{curName} stays on until your renewal</span>
            <p>Here’s what changes on {longDate(preview.effectiveAt)}:</p>
            <ul className="bl-effects">
              {fx.teammatesLosingAccess > 0 && (
                <li>
                  <strong>Your team loses access.</strong>{' '}
                  {fx.teammatesLosingAccess === 1
                    ? 'Your teammate'
                    : `Your ${fx.teammatesLosingAccess} teammates`}{' '}
                  can no longer open your library. Their own libraries aren’t affected, and their edits stay
                  in yours.
                </li>
              )}
              {fx.storageGb.from !== fx.storageGb.to && (
                <li>
                  <strong>
                    Storage goes from {GB(fx.storageGb.from)} to {GB(fx.storageGb.to)}.
                  </strong>{' '}
                  {fx.overStorage
                    ? `You use more than that, so uploads pause until you’re under ${GB(fx.storageGb.to)}. Nothing is deleted.`
                    : 'You’re within it.'}
                </li>
              )}
              {fx.lost.length > 0 && (
                <li>
                  <strong>{fx.lost.join(', ')} turn off.</strong> Live galleries stay as they are until they
                  expire.
                </li>
              )}
              {fx.teammatesLosingAccess === 0 &&
                fx.storageGb.from === fx.storageGb.to &&
                fx.lost.length === 0 && (
                  <li>Your features stay the same; only the billing period changes.</li>
                )}
            </ul>
          </>
        )}
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

/** Buy a top-up pack (Stripe Checkout, one-time payment). */
export function TopUpDialog({
  open,
  packs,
  onClose,
}: {
  open: boolean;
  packs: { lookupKey: TopUpLookupKey; credits: number; amount: number }[];
  onClose: () => void;
}) {
  const [pick, setPick] = useState<TopUpLookupKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPick((p) =>
      p && packs.some((x) => x.lookupKey === p)
        ? p
        : (packs[Math.min(1, packs.length - 1)]?.lookupKey ?? null),
    );
  }, [open, packs]);
  const chosen = packs.find((p) => p.lookupKey === pick) ?? null;
  const until = new Date();
  until.setMonth(until.getMonth() + 12);
  const go = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await startCheckout({ kind: 'topup', pack: chosen.lookupKey });
      leave.to(r.url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Buy cloud credits"
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" iconRight="external" busy={busy} disabled={!chosen} onClick={go}>
            Continue to Stripe
          </Button>
        </>
      }
    >
      <div className="bl-dialog">
        <span className="z-muted">For background removal</span>
        {packs.length === 0 ? (
          <Note tone="neutral">Credit packs aren’t on sale right now.</Note>
        ) : (
          <fieldset className="bl-packs">
            <legend className="z-sr">Pack</legend>
            {packs.map((p) => (
              <label key={p.lookupKey} className={`bl-pack${p.lookupKey === pick ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  className="z-sr"
                  name={name}
                  value={p.lookupKey}
                  checked={p.lookupKey === pick}
                  onChange={() => setPick(p.lookupKey)}
                />
                <span className="bl-pack__n mono">{p.credits.toLocaleString('en')}</span>
                <span className="bl-pack__p">credits · {usd(p.amount)}</span>
              </label>
            ))}
          </fieldset>
        )}
        {chosen && (
          <LineItems
            rows={[
              {
                label: `${chosen.credits.toLocaleString('en')} top-up credits`,
                amount: usd(chosen.amount),
                sub: `Last until ${longDate(until.toISOString())}`,
              },
            ]}
            total={['Total before tax', usd(chosen.amount)]}
          />
        )}
        <Note tone="neutral" icon="info">
          Top-up credits are used after your monthly credits and stay with your library if you change plan.
        </Note>
        {error && (
          <Note tone="bad" icon="alert" role="alert">
            {error}
          </Note>
        )}
      </div>
    </Dialog>
  );
}

/** "Prices are in US dollars…" footnote used on Plans and Plan & billing. */
export const TAX_NOTE =
  'Prices are in US dollars. Your card is charged in your local currency where Stripe offers it, with tax added where it applies.';

export function SecureNote() {
  return (
    <span className="bl-secure">
      <Icon name="lock" size={16} />
      Secure checkout by Stripe
    </span>
  );
}
