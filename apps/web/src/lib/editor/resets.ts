/**
 * Clean-up for lazily loaded editor modules. Each module registers its own reset when it loads, so ending a
 * session never has to load code just to tell it there is nothing to drop.
 *
 * `server`: the session is still valid (a deliberate sign-out), so a reset may send a last request first.
 */
type Reset = (o: { server: boolean }) => void | Promise<void>;
const resets = new Set<Reset>();
export function onEditorReset(fn: Reset): void {
  resets.add(fn);
}
export function runEditorResets(o: { server: boolean } = { server: false }): Promise<void> {
  const runs: Promise<unknown>[] = [];
  for (const fn of resets) {
    try {
      runs.push(Promise.resolve(fn(o)).catch(() => undefined));
    } catch {
      // One failing reset mustn't stop the others.
    }
  }
  return Promise.all(runs).then(() => undefined);
}
