import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Note } from './Card';
import { loadTurnstile, type TurnstileApi } from './turnstile';

export interface TurnstileHandle {
  /** Clears the current token and asks for a new challenge (tokens are single-use). */
  reset: () => void;
}
export interface TurnstileProps {
  siteKey: string;
  /** Checked by the server; must match what the API expects for this form. */
  action: string;
  onToken: (token: string) => void;
  onExpire?: () => void;
  /** 'interaction-only' keeps the widget hidden unless Cloudflare needs the visitor to click. */
  appearance?: 'always' | 'interaction-only';
}

/** Cloudflare Turnstile widget, loaded only when this component mounts. */
export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { siteKey, action, onToken, onExpire, appearance = 'always' },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<TurnstileApi | null>(null);
  const widget = useRef<string | undefined>(undefined);
  const cbs = useRef({ onToken, onExpire });
  cbs.current = { onToken, onExpire };
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    reset: () => {
      cbs.current.onExpire?.();
      if (widget.current !== undefined) api.current?.reset(widget.current);
    },
  }));

  useEffect(() => {
    let alive = true;
    loadTurnstile()
      .then((ts) => {
        if (!alive || !el.current) return;
        api.current = ts;
        widget.current = ts.render(el.current, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          size: 'flexible',
          appearance,
          'response-field': false,
          callback: (t: string) => cbs.current.onToken(t),
          'expired-callback': () => cbs.current.onExpire?.(),
          'error-callback': () => cbs.current.onExpire?.(),
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (widget.current !== undefined) api.current?.remove(widget.current);
    };
  }, [siteKey, action, appearance]);

  return (
    <div className={appearance === 'interaction-only' ? 'z-turnstile z-turnstile--quiet' : 'z-turnstile'}>
      <div ref={el} />
      {failed && (
        <Note tone="warn" icon="alert" role="alert">
          The security check didn’t load. Check your connection or content blocker, then reload.
        </Note>
      )}
    </div>
  );
});
