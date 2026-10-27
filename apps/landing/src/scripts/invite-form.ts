import {
  INVITE_REQUEST_LIMITS,
  type InviteRequestErrorBody,
  type PublicConfig,
  type UseCase,
} from '@zephyr/shared/client';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const ENDPOINT = '/api/v1/invite-requests';
const CONFIG_ENDPOINT = '/api/v1/public/config';
// A friendly first check only; the API validates properly.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Loads Cloudflare Turnstile once, only when the form is about to be used. */
let turnstileLoading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  turnstileLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.referrerPolicy = 'strict-origin';
    s.onload = () => {
      const t0 = performance.now();
      const wait = () => {
        if (window.turnstile) resolve(window.turnstile);
        else if (performance.now() - t0 > 8000) reject(new Error('turnstile-timeout'));
        else setTimeout(wait, 50);
      };
      wait();
    };
    s.onerror = () => {
      turnstileLoading = null;
      reject(new Error('turnstile-load'));
    };
    document.head.append(s);
  });
  return turnstileLoading;
}

export function initInviteForm(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('[data-view="form"]');
  const sent = root.querySelector<HTMLElement>('[data-view="sent"]');
  const paused = root.querySelector<HTMLElement>('[data-view="paused"]');
  const email = root.querySelector<HTMLInputElement>('input[name="email"]');
  const useCase = root.querySelector<HTMLSelectElement>('select[name="useCase"]');
  const emailError = root.querySelector<HTMLElement>('[data-email-error]');
  const alertBox = root.querySelector<HTMLElement>('[data-alert]');
  const alertText = root.querySelector<HTMLElement>('[data-alert-text]');
  const submit = root.querySelector<HTMLButtonElement>('[data-submit]');
  const widgetEl = root.querySelector<HTMLElement>('[data-turnstile]');
  const sentEmail = root.querySelector<HTMLElement>('[data-sent-email]');
  if (!form || !sent || !paused || !email || !submit || !widgetEl) return;

  const siteKey = root.dataset.sitekey ?? '';
  let token = '';
  let widgetId: string | undefined;
  let busy = false;
  let lockedUntil = 0;

  const show = (view: 'form' | 'sent' | 'paused') => {
    form.hidden = view !== 'form';
    sent.hidden = view !== 'sent';
    paused.hidden = view !== 'paused';
    root.dataset.state = view;
    if (view !== 'form') (view === 'sent' ? sent : paused).focus();
  };
  const setAlert = (msg: string | null) => {
    if (!alertBox || !alertText) return;
    alertText.textContent = msg ?? '';
    alertBox.hidden = !msg;
  };
  const setEmailError = (msg: string | null) => {
    if (!emailError) return;
    emailError.textContent = msg ?? '';
    emailError.hidden = !msg;
    email.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const resetChallenge = () => {
    token = '';
    if (widgetId !== undefined) window.turnstile?.reset(widgetId);
  };

  // ---- Lazy work: Turnstile + live config, once the form is near the viewport or focused ----
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    loadTurnstile()
      .then((ts) => {
        widgetId = ts.render(widgetEl, {
          sitekey: siteKey,
          action: 'invite_request',
          theme: 'auto',
          size: 'flexible',
          'response-field': false,
          callback: (t: string) => {
            token = t;
          },
          'expired-callback': () => {
            token = '';
          },
          'error-callback': () => {
            token = '';
          },
        });
      })
      .catch(() =>
        setAlert('The security check didn’t load. Check your connection or content blocker, then reload.'),
      );
    fetch(CONFIG_ENDPOINT, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<PublicConfig>) : null))
      .then((cfg) => {
        if (cfg && (!cfg.acceptingInviteRequests || cfg.signupsPaused)) show('paused');
      })
      .catch(() => {
        /* The form still works; the server makes the final call. */
      });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(root);
  }
  email.addEventListener('focus', start, { once: true });

  // ---- Submit ----
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    start();
    setAlert(null);
    setEmailError(null);

    if (Date.now() < lockedUntil) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      setAlert(`Too many requests from this network. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      return;
    }
    const address = email.value.trim().toLowerCase();
    const use = (useCase?.value || undefined) as UseCase | undefined;
    if (!EMAIL_RE.test(address) || address.length > INVITE_REQUEST_LIMITS.maxEmailLength) {
      setEmailError('Enter an email address like name@example.com.');
      email.focus();
      return;
    }
    if (!token) {
      setAlert('Finish the security check above, then send your request.');
      return;
    }

    busy = true;
    submit.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: address, useCase: use, turnstileToken: token }),
        credentials: 'omit',
      });
      if (res.status === 202) {
        if (sentEmail) sentEmail.textContent = address;
        form.reset();
        show('sent');
        return;
      }
      const body = (await res.json().catch(() => null)) as InviteRequestErrorBody | null;
      resetChallenge();
      if (res.status === 429 || body?.error === 'rate_limited') {
        const secs =
          Number(res.headers.get('retry-after')) ||
          body?.retryAfter ||
          INVITE_REQUEST_LIMITS.windowMinutes * 60;
        lockedUntil = Date.now() + secs * 1000;
        const mins = Math.ceil(secs / 60);
        setAlert(`Too many requests from this network. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      } else if (res.status === 409 || body?.error === 'not_accepting') {
        show('paused');
      } else if (res.status === 400 || body?.error === 'invalid') {
        setEmailError('Enter an email address like name@example.com.');
        email.focus();
      } else if (res.status === 403 || body?.error === 'verification_failed') {
        setAlert('We couldn’t confirm you’re human. Complete the check again, then resend.');
      } else {
        setAlert('Something went wrong on our side. Try again in a minute.');
      }
    } catch {
      resetChallenge();
      setAlert('You seem to be offline. Check your connection and try again.');
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
    }
  });
}
