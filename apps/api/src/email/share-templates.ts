/**
 * Sharing emails (phase 5): a gallery paused after wrong passcodes, favourites sent by a guest, a gallery
 * about to expire, and the safety team's alerts. Every user-provided value (gallery names, guest names and
 * notes) is plain text, escaped here; the safety alerts carry ids only, never image content or links to it.
 */
import { escapeHtml, oneLine } from './escape';

export interface Mail {
  subject: string;
  html: string;
  text: string;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });

/** One layout for every sharing email: a heading, paragraphs, an optional quote and button. */
function layout(
  subject: string,
  heading: string,
  paras: string[],
  o: { quote?: string; link?: { label: string; url: string } } = {},
): Mail {
  const p = (t: string) =>
    `<tr><td style="font-size:15px;line-height:1.55;color:#2A313C;padding-bottom:16px;">${escapeHtml(t)}</td></tr>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:40px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:20px;padding:36px 32px;">
<tr><td style="font-size:20px;font-weight:600;letter-spacing:-0.02em;padding-bottom:28px;">zephyr</td></tr>
<tr><td style="font-size:22px;font-weight:600;letter-spacing:-0.03em;line-height:1.25;padding-bottom:12px;">${escapeHtml(heading)}</td></tr>
${paras.map(p).join('\n')}
${o.quote ? `<tr><td style="padding-bottom:20px;"><div style="font-size:15px;line-height:1.55;color:#2A313C;background:#F7F8FB;border-radius:14px;padding:14px 16px;white-space:pre-wrap;">${escapeHtml(o.quote)}</div></td></tr>` : ''}
${o.link ? `<tr><td style="padding-bottom:8px;"><a href="${escapeHtml(o.link.url)}" style="display:inline-block;background:#0D1117;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:600;border-radius:12px;padding:14px 22px;">${escapeHtml(o.link.label)}</a></td></tr>` : ''}
</table>
<p style="font-size:12px;color:#566070;margin:20px 0 0;">Midnight Poetry Studio · zephyr.midnightpoetry.studio</p>
</td></tr></table></body></html>`;
  const text = [
    heading,
    '',
    ...paras.flatMap((t) => [t, '']),
    ...(o.quote ? [o.quote, ''] : []),
    ...(o.link ? [`${o.link.label}: ${o.link.url}`] : []),
  ]
    .join('\n')
    .trim();
  return { subject, html, text };
}

const name = (s: string) => `“${oneLine(s).slice(0, 80)}”`;
const galleryUrl = (appUrl: string, id: string) =>
  `${appUrl.replace(/\/$/, '')}/shared/${encodeURIComponent(id)}`;

export function galleryPausedEmail(e: {
  galleryName: string;
  galleryId: string;
  pausedUntil: string;
  appUrl: string;
}): Mail {
  return layout(
    'A shared gallery was paused',
    `${name(e.galleryName)} was paused`,
    [
      `Someone entered the wrong passcode many times, so nobody can unlock this gallery until ${formatDate(e.pausedUntil)}. Guests who already unlocked it can still see it.`,
      'If you don’t recognise this, give the gallery a new passcode: it ends every guest’s access and reopens it straight away.',
    ],
    { link: { label: 'Open the gallery', url: galleryUrl(e.appUrl, e.galleryId) } },
  );
}

export function favouritesSentEmail(e: {
  galleryName: string;
  galleryId: string;
  guestName: string;
  count: number;
  note: string | null;
  appUrl: string;
}): Mail {
  const who = oneLine(e.guestName).slice(0, 60);
  return layout(
    `${who} sent favourites from ${name(e.galleryName)}`,
    `${who} picked ${e.count} ${e.count === 1 ? 'photo' : 'photos'}`,
    [
      `From ${name(e.galleryName)}. Other guests’ selections are on the gallery’s Favourites tab (we send at most one of these emails an hour per gallery).`,
    ],
    {
      quote: e.note ? e.note.trim().slice(0, 1000) : undefined,
      link: { label: 'See favourites', url: galleryUrl(e.appUrl, e.galleryId) },
    },
  );
}

export function galleryExpiringEmail(e: {
  galleryName: string;
  galleryId: string;
  expiresAt: string;
  appUrl: string;
}): Mail {
  return layout(
    'A shared gallery expires soon',
    `${name(e.galleryName)} expires soon`,
    [
      `The link stops working on ${formatDate(e.expiresAt)}. To keep sharing, choose a later date in the gallery’s settings.`,
    ],
    { link: { label: 'Open the gallery', url: galleryUrl(e.appUrl, e.galleryId) } },
  );
}

/** To SAFETY_ALERT_EMAIL. Ids only: no image, no link to one, no member email. */
export function safetyMatchEmail(e: { photoId: string; galleryId: string; ownerId: string; at: Date }): Mail {
  return layout('[Zephyr safety] CSAM scanning match', 'CSAM scanning match: photo held', [
    `Cloudflare blocked a guest rendition. The photo is on a safety hold (never served, shared or purged) and the account’s sharing is suspended.`,
    `Photo ${e.photoId} · gallery ${e.galleryId} · account ${e.ownerId} · ${e.at.toISOString()}`,
    'Review it in Admin › Safety. Follow the reporting procedure in docs/setup.md.',
  ]);
}

/** To SAFETY_ALERT_EMAIL for a guest's CSAM report. Ids only; the guest's details stay in the database. */
export function safetyReportEmail(e: {
  reportId: string;
  galleryId: string;
  ownerId: string;
  photoId: string | null;
  at: Date;
}): Mail {
  return layout('[Zephyr safety] CSAM report from a guest', 'CSAM report from a guest', [
    'A guest reported a shared gallery for child sexual abuse material. Review it now.',
    `Report ${e.reportId} · gallery ${e.galleryId} · account ${e.ownerId}${e.photoId ? ` · photo ${e.photoId}` : ''} · ${e.at.toISOString()}`,
  ]);
}
