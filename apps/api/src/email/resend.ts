import type { Env } from '../env';
import { UpstreamError } from '../supabase';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend de-duplicates retries with the same key for 24 hours. */
  idempotencyKey?: string;
}

/** Sends one email through Resend. Throws UpstreamError (status only) on failure; never logs content. */
export async function sendEmail(env: Env, m: OutgoingEmail): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [m.to],
      subject: m.subject,
      html: m.html,
      text: m.text,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new UpstreamError('resend', res.status);
}
