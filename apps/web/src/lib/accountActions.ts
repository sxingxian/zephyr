import {
  ACCOUNT_ACTION_HEADER,
  ACCOUNT_ACTION_NONCE_RE,
  ACCOUNT_ACTION_PATH,
  ACCOUNT_ACTION_TOKEN_RE,
  type AccountActionOp,
  type AccountActionPeek,
  MEMBER8_API,
} from '@zephyr/shared/client';
import { api } from './api';

/**
 * Phase 8 (review round 4): adding or removing a passkey and deleting the account are made only on the page an
 * emailed link opens (routes/AccountAction.tsx). Settings just asks for the email (`requestAccountAction`); the
 * page reads the link's token from the URL fragment (`/account-action/<nonce>#t=<token>`) and sends it with the change. Google's AdSense script, which
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
const LINK_PATH = new RegExp(`^${ACCOUNT_ACTION_PATH}/([^/]+)$`);
/** The token, once taken from the URL. Memory only: never storage, forgotten once spent or left. */
let taken: string | null = null;

/**
 * Reads the link's token from the URL fragment and strips both the path nonce and the fragment from the address
 * bar straight away (replaceState to the bare path), so the token doesn't stay in history, screenshots or shared
 * links (fragments never reach servers either). A token is only taken from the emailed shape,
 * `/account-action/<22-character nonce>#t=<43-character token>`: the nonce makes every link's address unique, so
 * opening one always loads a new document. A token arriving on the bare path (where a page with Google's script
 * could have set its own address) is ignored, and so is anything that isn't exactly a 43-character token.
 */
export function takeAccountActionToken(): string | null {
  const { pathname, search, hash } = window.location;
  const nonce = LINK_PATH.exec(pathname)?.[1];
  const m = TOKEN_IN_HASH.exec(hash);
  if (m?.[1] !== undefined)
    taken =
      nonce !== undefined && ACCOUNT_ACTION_NONCE_RE.test(nonce) && ACCOUNT_ACTION_TOKEN_RE.test(m[1])
        ? m[1]
        : null;
  if (hash || nonce !== undefined)
    window.history.replaceState(window.history.state, '', `${ACCOUNT_ACTION_PATH}${search}`);
  return taken;
}
export function forgetAccountActionToken(): void {
  taken = null;
}
