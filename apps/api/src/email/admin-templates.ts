/**
 * Phase 8 emails (docs/phase-8.md): the Owners' notice of a high-risk admin change, the staff invite, and the
 * member notices (account suspended, lower plan limits, retention). No member emails, photo names or store
 * details ever appear in an Owners' email; staff names are the staff member's own display name or email.
 */
import { layout, type Mail } from './share-templates';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const base = (url: string) => url.replace(/\/$/, '');

/** What a high-risk change was, in one sentence (no member data: ids only). */
export type OwnerChange =
  | { kind: 'plan_override'; userId: string; plan: string; until: string | null }
  | { kind: 'unsuspend'; userId: string }
  | { kind: 'sharing_lift'; userId: string }
  | { kind: 'deletion_scheduled'; userId: string }
  | { kind: 'credits'; userId: string; amount: number }
  | { kind: 'hold_released'; photoId: string }
  | { kind: 'limits_scheduled'; version: number; effectiveAt: string | null; decreases: boolean }
  | { kind: 'adsense'; enabled: boolean; changed: string[] }
  | { kind: 'retention_approved'; libraries: number }
  | { kind: 'staff_invited'; role: string }
  | { kind: 'staff_role'; userId: string; role: string }
  | { kind: 'staff_removed'; userId: string };

function describe(actor: string, c: OwnerChange): string {
  switch (c.kind) {
    case 'plan_override':
      return `${actor} gave member ${c.userId} the ${c.plan} plan${c.until ? ` until ${day(c.until)}` : ' with no end date'}, outside Stripe.`;
    case 'unsuspend':
      return `${actor} lifted the suspension of member ${c.userId}.`;
    case 'sharing_lift':
      return `${actor} lifted the sharing suspension of member ${c.userId}: their galleries can be shared again.`;
    case 'deletion_scheduled':
      return `${actor} scheduled member ${c.userId}'s account for deletion in 30 days.`;
    case 'credits':
      return `${actor} granted ${c.amount.toLocaleString('en-GB')} cloud AI credits to member ${c.userId}.`;
    case 'hold_released':
      return `${actor} released the safety hold on photo ${c.photoId}. It can be served and shared again.`;
    case 'limits_scheduled':
      return `${actor} scheduled plan limits version ${c.version} to apply ${c.effectiveAt ? `on ${day(c.effectiveAt)}` : 'now'}.${c.decreases ? ' It lowers some limits; affected members are emailed.' : ''}`;
    case 'adsense':
      return c.enabled
        ? `${actor} turned Google AdSense on for Free members${c.changed.length ? ` (changed: ${c.changed.join(', ')})` : ''}. Google's script runs inside the app for them: the accepted risk in docs/phase-8.md applies.`
        : `${actor} changed the AdSense settings (${c.changed.join(', ') || 'no fields'}).`;
    case 'retention_approved':
      return `${actor} approved the retention clean-up for ${c.libraries} lapsed ${c.libraries === 1 ? 'library' : 'libraries'}: their oldest photos beyond the Free storage move to Trash.`;
    case 'staff_invited':
      return `${actor} invited a new staff member as ${c.role}.`;
    case 'staff_role':
      return `${actor} changed staff member ${c.userId}'s role to ${c.role}.`;
    case 'staff_removed':
      return `${actor} removed staff member ${c.userId}. Their admin sessions were ended.`;
  }
}

export function ownerChangeEmail(e: {
  actor: string;
  change: OwnerChange;
  reason: string;
  adminUrl: string;
}): Mail {
  return layout(
    '[Zephyr admin] A high-risk change was made',
    'A high-risk change was made',
    [describe(e.actor, e.change), 'Every Owner gets this email. The full record is in the audit log.'],
    { quote: e.reason, link: { label: 'Open the audit log', url: `${base(e.adminUrl)}/admin/audit` } },
  );
}

const ROLE_LINE: Record<string, string> = {
  owner: 'Owner: everything, including staff, prices and storage.',
  admin: 'Admin: users, ads, storage and retention.',
  finance: 'Finance: prices, packs, plan limits and plan overrides.',
  safety: 'Safety: reports, holds and suspensions.',
  support: 'Support: users, sign-outs and credits.',
};

/** The subject and text are fixed: the invite goes to any address an Owner types. */
export function staffInviteEmail(e: { role: string; link: string; expiresAt: string }): Mail {
  return layout(
    'You’re invited to Zephyr admin',
    'You’re invited to Zephyr admin',
    [
      `You’ve been invited to the Zephyr admin console. ${ROLE_LINE[e.role] ?? ''}`,
      `The link works once, until ${day(e.expiresAt)}. You also need access through Cloudflare Access for this email; your first sign-in uses an emailed code that can only add a passkey.`,
      'If you weren’t expecting this, ignore this email.',
    ],
    { link: { label: 'Accept the invite', url: e.link } },
  );
}

export function suspendedEmail(e: { appUrl: string }): Mail {
  return layout(
    'Your Zephyr account is suspended',
    'Your account is suspended',
    [
      'We’ve suspended your Zephyr account. You can’t sign in or share galleries for now, and your shared galleries are offline. Your photos are kept safe.',
      'If you think this is a mistake, reply to this email and we’ll look into it.',
    ],
    { link: { label: 'Open Zephyr', url: base(e.appUrl) } },
  );
}

export interface LimitsChangeLine {
  label: string;
  from: string;
  to: string;
}
export function limitsDecreaseEmail(e: {
  effectiveAt: string;
  changes: LimitsChangeLine[];
  appUrl: string;
}): Mail {
  return layout(
    `Changes to your Zephyr plan on ${day(e.effectiveAt)}`,
    'Changes to your plan',
    [
      `From ${day(e.effectiveAt)}, these limits change on your plan:`,
      ...e.changes.slice(0, 12).map((c) => `${c.label}: ${c.from} → ${c.to}`),
      'Nothing changes before then. Your photos are never deleted because of a limit change.',
    ],
    { link: { label: 'See your plan', url: `${base(e.appUrl)}/settings/billing` } },
  );
}

export function retentionNoticeEmail(e: { dueAt: string; photos: number; appUrl: string }): Mail {
  const n = e.photos.toLocaleString('en-GB');
  return layout(
    `Your oldest ${n} photos move to Trash on ${day(e.dueAt)}`,
    'Some photos will move to Trash',
    [
      `Your library has been over the Free plan’s storage since your paid plan ended a year ago. On ${day(e.dueAt)}, your oldest ${n} photos beyond the Free storage move to Trash, where you can still restore them for 30 days.`,
      'To keep everything, choose a plan, or download and delete photos to get under the Free storage before then. Photos in live shared galleries are left alone.',
    ],
    { link: { label: 'Choose a plan', url: `${base(e.appUrl)}/settings/billing` } },
  );
}
