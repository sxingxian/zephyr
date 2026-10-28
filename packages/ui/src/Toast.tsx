import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

type Tone = 'neutral' | 'good' | 'bad';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}
interface ToastApi {
  show: (text: string, tone?: Tone) => void;
}
const Ctx = createContext<ToastApi>({ show: () => {} });

/** Polite live region plus short-lived toasts. One per app, near the root. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const show = useCallback((text: string, tone: Tone = 'neutral') => {
    seq.current += 1;
    const id = seq.current;
    setItems((xs) => [...xs.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="z-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('z-toast', `z-toast--${t.tone}`)}>
            <Icon name={t.tone === 'bad' ? 'alert' : 'check'} size={16} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}
