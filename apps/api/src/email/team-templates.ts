import type { TeamRole } from '@zephyr/shared';
import { escapeHtml, oneLine } from './escape';

export interface TeamInviteEmail {
  teamName: string;
  inviterName: string | null;
  role: TeamRole;
  /** `<APP>/team/accept#token=…`: the token is in the fragment, so it never reaches a server log or Referer. */
  link: string;
  expiresAt: string;
  /** The address has no Zephyr account yet: the button says "Create my account". */
  needsAccount: boolean;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const ROLE_LINE: Record<TeamRole, string> = {
  editor: 'As an Editor you can upload, edit, use Zephyr AI and share galleries from the team library.',
  viewer: 'As a Viewer you can browse and download photos from the team library.',
};

/** Team invite (phase 7): subject, HTML and plain text. Every member-provided value is escaped. */
export function teamInviteEmail(e: TeamInviteEmail): { subject: string; html: string; text: string } {
  const team = oneLine(e.teamName).slice(0, 60) || 'a Studio team';
  const who = e.inviterName ? oneLine(e.inviterName).slice(0, 80) : null;
  const subject = who ? `${who} invited you to ${team} on Zephyr` : `You’re invited to ${team} on Zephyr`;
  const lead = who ? `${who} invited you to join ${team}` : `You’re invited to join ${team}`;
  const role = ROLE_LINE[e.role];
  const cta = e.needsAccount ? 'Create my account' : 'Join the team';
  const keep = e.needsAccount
    ? 'You’ll get your own free Zephyr library too.'
    : 'Your own library stays yours: you switch between libraries from the sidebar.';
  const expires = formatDate(e.expiresAt);
  const link = escapeHtml(e.link);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:24px;font-weight:600;letter-spacing:-0.03em;line-height:1.2;padding-bottom:12px;">${escapeHtml(lead)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:8px;">${escapeHtml(role)}</td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:24px;">${escapeHtml(keep)}</td></tr>
<tr><td style="padding-bottom:24px;"><a href="${link}" rel="noreferrer" style="display:inline-block;background:#0D1117;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;border-radius:12px;padding:14px 22px;">${cta}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.55;color:#566070;">This link works once, only for this email address, and expires on ${escapeHtml(expires)}. Didn’t expect it? Just ignore this email.</td></tr>
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;

  const text = [
    lead,
    '',
    role,
    keep,
    '',
    `${cta}: ${e.link}`,
    '',
    `This link works once, only for this email address, and expires on ${expires}. Didn’t expect it? Just ignore this email.`,
  ].join('\n');
  return { subject, html, text };
}
