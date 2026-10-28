/**
 * Clean-up for lazily loaded editor modules. Each module registers its own reset when it loads, so ending a
 * session never has to load code just to tell it there is nothing to drop.
 */
const resets = new Set<() => void>();
export function onEditorReset(fn: () => void): void {
  resets.add(fn);
}
export function runEditorResets(): void {
  for (const fn of resets) {
    try {
      fn();
    } catch {
      // One failing reset mustn't stop the others.
    }
  }
}
