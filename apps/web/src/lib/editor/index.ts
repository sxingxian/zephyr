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
  onSessionEnd(() => {
    clearCopied();
    renderQueue.reset();
    stopRawDecoder();
    // The background renderer and the RAW exposure cache, if they were ever loaded.
    runEditorResets();
  });
}
wireEditorSessionReset();

export { copyEdits, getCopied, useCopied } from './clipboard';
export { renderQueue } from './queue';
