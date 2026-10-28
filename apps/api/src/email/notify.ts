import type { Context } from 'hono';
import { background, logError } from '../http';
import type { HonoEnv } from '../types';
import { sendEmail } from './resend';
import { accountDeletionEmail, passkeyChangeEmail } from './templates';

/** Tells the account owner about a passkey change, after the response (failures are only logged). */
export async function notifyPasskeyChange(
  c: Context<HonoEnv>,
  to: string,
  change: 'added' | 'removed',
  name: string | null,
  where: string,
) {
  const requestId = c.get('requestId');
  await background(c, async () => {
    try {
      if (!to) return;
      await sendEmail(c.env, { to, ...passkeyChangeEmail({ change, name, where, at: new Date() }) });
    } catch (err) {
      logError(requestId, 'passkey_change_email', err);
    }
  });
}

/** Confirms a scheduled account deletion to the account's address, after the response. */
export async function notifyAccountDeletion(c: Context<HonoEnv>, to: string, purgeAt: string) {
  const requestId = c.get('requestId');
  await background(c, async () => {
    try {
      if (!to) return;
      await sendEmail(c.env, { to, ...accountDeletionEmail({ purgeAt, appUrl: c.env.APP_URL }) });
    } catch (err) {
      logError(requestId, 'account_deletion_email', err);
    }
  });
}
