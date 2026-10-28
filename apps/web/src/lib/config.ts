/** Cloudflare's always-pass test key, only for dev and explicitly allowed test builds. */
const TEST_SITE_KEY = '1x00000000000000000000AA';

export const TURNSTILE_SITE_KEY: string =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  (import.meta.env.DEV || import.meta.env.VITE_ALLOW_TEST_TURNSTILE === '1' ? TEST_SITE_KEY : '');

/** Turnstile actions; the API checks the action on each token. Shared with the API. */
export { TURNSTILE_ACTIONS } from '@zephyr/shared/client';

export const LANDING_URL = 'https://zephyr.midnightpoetry.studio';
export const REQUEST_INVITE_URL = `${LANDING_URL}/#request-invite`;
