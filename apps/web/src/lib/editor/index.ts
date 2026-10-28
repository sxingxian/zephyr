import { onSessionEnd } from '../sessionGuard';
import { clearCopied } from './clipboard';
import { renderQueue } from './queue';
import { stopRawDecoder } from './raw';
import { runEditorResets } from './resets';

/**
 * Editor state that outlives a page (copied edits, the thumbnail queue, the RAW worker) is dropped when
 * the session ends, together with the upload queue, so nothing carries over to the next member.
 */
let wired = false;
export function wireEditorSessionReset(): void {
  if (wired) return;
  wired = true;
  onSessionEnd(async ({ server }) => {
    clearCopied();
    renderQueue.reset();
    stopRawDecoder();
    // Open edit sessions (saved first on a deliberate sign-out), running exports, the background renderer
    // and the RAW exposure cache, if they were ever loaded.
    await runEditorResets({ server });
    // A last save may have queued a thumbnail render: drop it too.
    renderQueue.reset();
  });
}
wireEditorSessionReset();

export { copyEdits, getCopied, useCopied } from './clipboard';
export { renderQueue } from './queue';
