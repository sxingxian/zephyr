import { escapeHtml, oneLine } from './escape';

export interface InviteEmail {
  inviterName: string | null;
  note: string | null;
  link: string;
  expiresAt: string;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Invite email: subject, HTML and plain text. Every user-provided value is escaped. */
export function inviteEmail(e: InviteEmail): { subject: string; html: string; text: string } {
  const who = e.inviterName ? oneLine(e.inviterName).slice(0, 80) : null;
  const subject = who ? `${who} invited you to Zephyr` : 'You’re invited to Zephyr';
  const lead = who ? `${who} invited you to Zephyr` : 'The Zephyr team invited you to Zephyr';
  const expires = formatDate(e.expiresAt);
  const note = e.note ? e.note.trim().slice(0, 500) : null;
  const link = escapeHtml(e.link);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:24px;font-weight:600;letter-spacing:-0.03em;line-height:1.2;padding-bottom:12px;">${escapeHtml(lead)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:${note ? 16 : 24}px;">Edit a whole shoot at once and share it behind a private passcode. Your seat is ready.</td></tr>
${note ? `<tr><td style="padding-bottom:24px;"><div style="font-size:15px;line-height:1.55;color:#2A313C;background:#F7F8FB;border-radius:14px;padding:14px 16px;white-space:pre-wrap;">${escapeHtml(note)}</div></td></tr>` : ''}
<tr><td style="padding-bottom:24px;"><a href="${link}" style="display:inline-block;background:#0D1117;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;border-radius:12px;padding:14px 22px;">Create my account</a></td></tr>
<tr><td style="font-size:13px;line-height:1.55;color:#566070;">This link works once, only for this email address, and expires on ${escapeHtml(expires)}. Didn’t expect it? Just ignore this email.</td></tr>
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;

  const text = [
    lead,
    '',
    'Edit a whole shoot at once and share it behind a private passcode. Your seat is ready.',
    ...(note ? ['', note] : []),
    '',
    `Create your account: ${e.link}`,
    '',
    `This link works once, only for this email address, and expires on ${expires}. Didn’t expect it? Just ignore this email.`,
  ].join('\n');
  return { subject, html, text };
}

export interface PasskeyChangeEmail {
  change: 'added' | 'removed';
  /** The passkey's name, when known (added). */
  name: string | null;
  /** 'Zephyr' or 'the Zephyr admin console'. */
  where: string;
  at: Date;
}

/**
 * Security notice sent whenever a passkey is added to or removed from an account, so an unexpected
 * change is noticed even if a session was taken over.
 */
export function passkeyChangeEmail(e: PasskeyChangeEmail): { subject: string; html: string; text: string } {
  const subject =
    e.change === 'added'
      ? 'A passkey was added to your Zephyr account'
      : 'A passkey was removed from your Zephyr account';
  const name = e.name ? oneLine(e.name).slice(0, 120) : null;
  const when = `${e.at.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
  const what =
    e.change === 'added'
      ? `${name ? `A passkey named “${name}”` : 'A new passkey'} was added to your account in ${e.where} on ${when}.`
      : `A passkey was removed from your account in ${e.where} on ${when}.`;
  const advice =
    'If this was you, there’s nothing to do. If it wasn’t, sign in, remove any passkey you don’t recognise and reply to this email so we can help.';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:22px;font-weight:600;letter-spacing:-0.03em;line-height:1.25;padding-bottom:12px;">${escapeHtml(subject)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:16px;">${escapeHtml(what)}</td></tr>
<tr><td style="font-size:13px;line-height:1.55;color:#566070;">${escapeHtml(advice)}</td></tr>
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;
  const text = [subject, '', what, '', advice].join('\n');
  return { subject, html, text };
}

export interface AccountDeletionEmail {
  purgeAt: string;
  appUrl: string;
}

/** Sent when a member schedules their account for deletion: what happens, when, and how to undo it. */
export function accountDeletionEmail(e: AccountDeletionEmail): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Your Zephyr account is scheduled for deletion';
  const when = formatDate(e.purgeAt);
  const what = `Your account, every photo and album in it, will be permanently deleted on ${when}. You’ve been signed out on every device.`;
  const undo =
    'Changed your mind? Sign in before then and choose Restore account: everything comes back as it was.';
  const advice =
    'If you didn’t ask for this, sign in now, restore your account and reply to this email so we can help.';
  const link = escapeHtml(e.appUrl);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:22px;font-weight:600;letter-spacing:-0.03em;line-height:1.25;padding-bottom:12px;">${escapeHtml(subject)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:16px;">${escapeHtml(what)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:24px;">${escapeHtml(undo)}</td></tr>
<tr><td style="padding-bottom:24px;"><a href="${link}" style="display:inline-block;background:#0D1117;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;border-radius:12px;padding:14px 22px;">Open Zephyr</a></td></tr>
<tr><td style="font-size:13px;line-height:1.55;color:#566070;">${escapeHtml(advice)}</td></tr>
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;
  const text = [subject, '', what, '', undo, `Open Zephyr: ${e.appUrl}`, '', advice].join('\n');
  return { subject, html, text };
}

export interface StepUpEmail {
  code: string;
  op: 'passkey_add' | 'passkey_remove' | 'account_delete';
  minutes: number;
}

const STEP_UP_WHAT: Record<StepUpEmail['op'], string> = {
  passkey_add: 'add a passkey to your account',
  passkey_remove: 'remove a passkey from your account',
  account_delete: 'delete your account',
};

/**
 * Phase 8: the one-time code that confirms an account-level change (adding or removing a passkey, deleting the
 * account) while the member may be shown ads. Only the six digits and fixed text; nothing user-provided.
 */
export function stepUpEmail(e: StepUpEmail): { subject: string; html: string; text: string } {
  const code = /^\d{4,10}$/.test(e.code) ? e.code : '';
  const subject = `${code} is your Zephyr confirmation code`;
  const what = `Enter this code in Zephyr to ${STEP_UP_WHAT[e.op]}. It works once, for ${e.minutes} minutes.`;
  const advice =
    'Didn’t ask for this? Don’t enter the code anywhere. Your account stays as it is; sign out of Zephyr on any device you don’t recognise and reply to this email so we can help.';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:22px;font-weight:600;letter-spacing:-0.03em;line-height:1.25;padding-bottom:12px;">Confirm this change</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:20px;">${escapeHtml(what)}</td></tr>
<tr><td style="font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:0.18em;padding-bottom:24px;">${escapeHtml(code)}</td></tr>
<tr><td style="font-size:13px;line-height:1.55;color:#566070;">${escapeHtml(advice)}</td></tr>
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;
  const text = [subject, '', what, '', code, '', advice].join('\n');
  return { subject, html, text };
}
