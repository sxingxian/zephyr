/**
 * Billing emails (phase 7). Receipts and failed-payment emails come from Stripe/Link (the merchant of
 * record); these are ours: a subscriber's price-change notice, the Owners' notice of a price change, and the
 * plan-ended notice. Amounts are US dollars; no card or Stripe details.
 */
import { layout, type Mail } from './share-templates';

const PLAN_NAME: Record<string, string> = { pro: 'Pro', studio: 'Studio' };
export const usdCents = (cents: number) => `US$${(cents / 100).toFixed(2)}`;
const day = (isoTime: string) =>
  new Date(isoTime).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const per = (interval: string | null) =>
  interval === 'year' ? 'a year' : interval === 'month' ? 'a month' : '';

export function priceNoticeEmail(e: {
  plan: string | null;
  interval: string | null;
  from: number;
  to: number;
  moveAt: string;
  appUrl: string;
}): Mail {
  const plan = PLAN_NAME[e.plan ?? ''] ?? 'Your plan';
  const rise = e.to > e.from;
  return layout(
    `${plan}’s price ${rise ? 'is changing' : 'is going down'} on ${day(e.moveAt)}`,
    `${plan}’s price is changing`,
    [
      `From your renewal on ${day(e.moveAt)}, ${plan} costs ${usdCents(e.to)} ${per(e.interval)} instead of ${usdCents(e.from)}, plus tax where it applies.`,
      rise
        ? 'Nothing changes before then. If you’d rather not continue, you can cancel any time before that date in Settings › Plan & billing, and keep your plan until the end of the period you’ve paid for.'
        : 'You don’t need to do anything.',
    ],
    { link: { label: 'Open Plan & billing', url: `${e.appUrl.replace(/\/$/, '')}/settings/billing` } },
  );
}

export function priceChangeOwnersEmail(e: {
  kind: 'raise' | 'pack_on' | 'stopped';
  actor: string;
  lookupKey: string;
  from?: number;
  to?: number;
  reason?: string;
  adminUrl: string;
}): Mail {
  const what =
    e.kind === 'pack_on'
      ? `${e.actor} put the top-up pack ${e.lookupKey} on sale.`
      : e.kind === 'stopped'
        ? `${e.actor} stopped the price change for ${e.lookupKey}. Subscribers not yet moved stay on their current price.`
        : (e.to ?? 0) > (e.from ?? 0)
          ? `${e.actor} raised ${e.lookupKey} from ${usdCents(e.from ?? 0)} to ${usdCents(e.to ?? 0)}. New sign-ups pay it now; existing subscribers move at their first renewal at least 30 days after their notice.`
          : `${e.actor} changed ${e.lookupKey} from ${usdCents(e.from ?? 0)} to ${usdCents(e.to ?? 0)}. That's still a rise for subscribers paying less on an older price: they move at their first renewal at least 30 days after their notice.`;
  return layout(
    e.kind === 'stopped' ? '[Zephyr billing] Price change stopped' : '[Zephyr billing] Price changed',
    e.kind === 'stopped' ? 'A price change was stopped' : 'A price was changed',
    [what, 'Every Owner gets this email. The full record is in the audit log.'],
    { ...(e.reason ? { quote: e.reason } : {}), link: { label: 'Open Plans & billing', url: e.adminUrl } },
  );
}

export function planEndedEmail(e: { appUrl: string }): Mail {
  return layout(
    'Your Zephyr plan has ended',
    'Your plan has ended',
    [
      'You’re on Free now. Your photos are safe: if your library is over Free’s storage, it’s read-only, so you can view, download and delete, but not upload or edit, until it’s back under or you choose a plan again.',
      'Shared galleries stay live until they expire; new galleries and extensions need a plan. Teammates of a Studio library can’t open it until Studio is back.',
    ],
    { link: { label: 'See plans', url: `${e.appUrl.replace(/\/$/, '')}/settings/billing` } },
  );
}
