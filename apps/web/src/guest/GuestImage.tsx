import { type ImgHTMLAttributes, useEffect, useRef, useState } from 'react';
import { classifyImageFailure, type ImageProblem, nextPendingDelay, withProbeSlot } from './media';

type State = { kind: 'ok' } | { kind: 'pending'; since: number } | { kind: 'gave_up' };

export interface GuestImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> {
  src: string;
  /** The signed URL ran out or the photo went away: fetch fresh URLs (the parent passes new `src`). */
  onExpired: () => void | Promise<void>;
  /** "Preparing" in a grid tile (compact) or in the viewer (sentence). */
  variant: 'tile' | 'viewer';
  /** Test seams. */
  classify?: (url: string) => Promise<ImageProblem>;
  now?: () => number;
}

/**
 * A guest image that copes with sizes the server hasn't made yet: it shows a calm "Preparing" state and tries
 * again on a slow backoff (about five minutes in all), then offers a manual retry. Expired URLs are refreshed.
 */
export function GuestImage({ src, onExpired, variant, classify, now = Date.now, ...img }: GuestImageProps) {
  const [state, setState] = useState<State>({ kind: 'ok' });
  const [attempt, setAttempt] = useState(0);
  const expiredFor = useRef<string | null>(null);
  const since = useRef<number | null>(null);
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const srcRef = useRef(src);
  srcRef.current = src;

  useEffect(
    () => () => {
      alive.current = false;
      clearTimeout(timer.current);
    },
    [],
  );
  // A new URL (after a refresh) starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on src only
  useEffect(() => {
    clearTimeout(timer.current);
    since.current = null;
    tries.current = 0;
    setState({ kind: 'ok' });
    setAttempt(0);
  }, [src]);

  const pending = () => {
    if (since.current === null) since.current = now();
    const delay = nextPendingDelay(tries.current, now() - since.current);
    if (delay === null) {
      setState({ kind: 'gave_up' });
      return;
    }
    tries.current++;
    setState({ kind: 'pending', since: since.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (alive.current) setAttempt((a) => a + 1);
    }, delay);
  };

  const onError = () => {
    const url = srcRef.current;
    void withProbeSlot(() => (classify ?? classifyImageFailure)(url)).then((problem) => {
      if (!alive.current || srcRef.current !== url) return;
      // A URL that keeps failing as "expired" after a refresh is treated as pending, so it can't loop.
      if (problem === 'expired' && expiredFor.current !== url) {
        expiredFor.current = url;
        void onExpired();
        return;
      }
      pending();
    });
  };

  const retry = () => {
    since.current = now();
    tries.current = 0;
    setState({ kind: 'pending', since: since.current });
    setAttempt((a) => a + 1);
  };

  const showing = state.kind === 'ok';
  return (
    <>
      <img
        {...img}
        key={`${src}#${attempt}`}
        src={src}
        referrerPolicy="no-referrer"
        onLoad={() => {
          since.current = null;
          tries.current = 0;
          setState({ kind: 'ok' });
        }}
        onError={onError}
        style={showing ? img.style : { ...img.style, opacity: 0 }}
        aria-hidden={showing ? undefined : true}
      />
      {state.kind !== 'ok' && (
        <span className={`g-pending g-pending--${variant}`} role="status">
          {state.kind === 'pending' ? (
            <span>
              {variant === 'viewer'
                ? 'This photo is still being prepared. It’ll appear here shortly.'
                : 'Preparing'}
            </span>
          ) : (
            <>
              <span>{variant === 'viewer' ? 'This photo isn’t ready yet.' : 'Not ready yet'}</span>
              <button type="button" className="g-pending__retry" onClick={retry}>
                Try again
              </button>
            </>
          )}
        </span>
      )}
    </>
  );
}
