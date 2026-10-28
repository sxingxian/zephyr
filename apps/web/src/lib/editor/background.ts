import { Renderer, type RenderOptions } from './gl';
import { onEditorReset } from './resets';

/** One off-screen renderer shared by the thumbnail queue and exports (one at a time). */
let shared: Renderer | null = null;
let chain: Promise<unknown> = Promise.resolve();

export function withRenderer<T>(fn: (r: Renderer) => Promise<T> | T): Promise<T> {
  const run = chain.then(async () => {
    if (!shared || shared.isLost) {
      shared?.dispose();
      shared = new Renderer();
    }
    return fn(shared);
  });
  chain = run.catch(() => {});
  return run;
}

export function disposeBackgroundRenderer(): void {
  shared?.dispose();
  shared = null;
}

export type { RenderOptions };

onEditorReset(disposeBackgroundRenderer);
