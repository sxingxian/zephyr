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
