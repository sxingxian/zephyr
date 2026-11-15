import {
  ACCOUNT_ACTION_HEADER,
  ACCOUNT_ACTION_TOKEN_RE,
  type AccountActionOp,
  type AccountActionPeek,
  MEMBER8_API,
} from '@zephyr/shared/client';
import { api } from './api';

/**
 * Phase 8 (review round 4): adding or removing a passkey and deleting the account are made only on the page an
 * emailed link opens (routes/AccountAction.tsx). Settings just asks for the email (`requestAccountAction`); the
 * page reads the link's token from the URL fragment and sends it with the change. Google's AdSense script, which
 * runs in Free members' library pages, can ask for an email but can't read it, and a passkey made on that page
 * comes from the member's own device.
 */
export const requestAccountAction = (op: AccountActionOp, passkeyId?: string) =>
  api<{ ok: true }>(MEMBER8_API.accountActions, {
    method: 'POST',
    body: passkeyId ? { op, passkeyId } : { op },
  });

export const peekAccountAction = (token: string) =>
  api<AccountActionPeek>(MEMBER8_API.accountActionPeek, { method: 'POST', body: { token } });

export const accountActionHeaders = (token: string): Record<string, string> => ({
  [ACCOUNT_ACTION_HEADER]: token,
});

const TOKEN_IN_HASH = /(?:^|[#&])t=([^&]*)(?:&|$)/;
/** The token, once taken from the URL. Memory only: never storage, forgotten once spent or left. */
let taken: string | null = null;

/**
 * Reads the link's token from the URL fragment and strips the fragment from the address bar straight away, so the
 * token doesn't stay in history, screenshots or shared links (fragments never reach servers either). Anything
 * that isn't exactly a 43-character base64url token is ignored.
 */
export function takeAccountActionToken(): string | null {
  const m = TOKEN_IN_HASH.exec(window.location.hash);
  if (m?.[1] !== undefined) taken = ACCOUNT_ACTION_TOKEN_RE.test(m[1]) ? m[1] : null;
  if (window.location.hash)
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  return taken;
}
export function forgetAccountActionToken(): void {
  taken = null;
}
