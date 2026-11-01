import { lazy, Suspense, useState } from 'react';
import { isAvailable, isOn, useAiStatus } from '../../lib/aiClient';

// The dialog (and the Zephyr AI styles) load the first time it opens.
const BatchDialog = lazy(() => import('./BatchDialog').then((m) => ({ default: m.BatchDialog })));

/** Library selection hook: the "Zephyr AI" action and its dialog (phase 6). */
export function useAiBatch() {
  const status = useAiStatus();
  const [ids, setIds] = useState<string[] | null>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const available =
    (Boolean(status?.enabled) &&
      (['auto_enhance', 'hdr', 'color_match'] as const).some((f) => isOn(status, f))) ||
    isAvailable(status, 'bg_removal');
  return {
    available,
    open: (photoIds: string[], t?: string) => {
      setTitle(t);
      setIds(photoIds);
    },
    dialog:
      ids === null ? null : (
        <Suspense fallback={null}>
          <BatchDialog open photoIds={ids} title={title} onClose={() => setIds(null)} />
        </Suspense>
      ),
  };
}
