import { useEffect, useState } from 'react';
import type { Scanner, ScanProgress } from './ai/scanner';

/** The background scanner's progress, loading the scanner module lazily (it isn't in the first bundle). */
export function useScanner(): { progress: ScanProgress | null; scanner: Scanner | null } {
  const [state, setState] = useState<{ progress: ScanProgress | null; scanner: Scanner | null }>({
    progress: null,
    scanner: null,
  });
  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void import('./ai/scanner').then(({ scanner }) => {
      if (!live) return;
      setState({ progress: scanner.getSnapshot(), scanner });
      off = scanner.subscribe((p) => setState({ progress: p, scanner }));
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return state;
}
