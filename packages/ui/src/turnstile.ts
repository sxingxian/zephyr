/** Lazy loader for Cloudflare Turnstile (explicit rendering). The script is added at most once per page. */
export interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(timeoutMs = 10_000): Promise<TurnstileApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no-window'));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.referrerPolicy = 'strict-origin';
    const started = Date.now();
    const poll = () => {
      if (window.turnstile) resolve(window.turnstile);
      else if (Date.now() - started > timeoutMs) fail(new Error('turnstile-timeout'));
      else setTimeout(poll, 50);
    };
    const fail = (e: Error) => {
      loading = null;
      s.remove();
      reject(e);
    };
    s.onload = poll;
    s.onerror = () => fail(new Error('turnstile-load'));
    document.head.append(s);
  });
  return loading;
}

/** Test helper: forget a previous load. */
export function resetTurnstileLoader(): void {
  loading = null;
}
