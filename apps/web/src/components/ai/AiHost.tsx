import { useEffect } from 'react';
import { listJobs, useAiStatus, useAiStatusPolling } from '../../lib/aiClient';
import { useSession } from '../../lib/session';

/**
 * Zephyr AI's background wiring for a signed-in member (phase 6):
 * - reads the AI status on start and every five minutes;
 * - runs the background scanner when quality signals (cleanup, Night) or faces are wanted;
 * - picks up device jobs this device was running when the tab closed.
 * The scanner and device runner stop themselves when the member's session ends.
 */
export function AiHost() {
  const { user } = useSession();
  const on = Boolean(user && !user.pendingDeletion);
  useAiStatusPolling(on);
  const s = useAiStatus();
  const enabled = Boolean(on && s?.enabled);
  const signals =
    enabled &&
    (s?.features.cleanup === 'on' || s?.features.scene_tags === 'on' || s?.features.scene_tags === 'paused');
  const faces = enabled && s?.features.face_grouping === 'on';

  useEffect(() => {
    if (!on) return;
    let live = true;
    void import('../../lib/ai/scanner').then(({ scanner }) => {
      if (!live) return;
      if (signals || faces) scanner.start({ signals: Boolean(signals), faces: Boolean(faces) });
      else scanner.stop();
    });
    return () => {
      live = false;
    };
  }, [on, signals, faces]);

  // Unmounted when the member signs out or the account becomes scheduled for deletion: stop finding faces and
  // running device jobs here at once (the server would refuse them anyway).
  useEffect(
    () => () => {
      void import('../../lib/ai/scanner').then(({ scanner }) => scanner.stop());
      void import('../../lib/deviceRunner').then(({ deviceRunner }) => deviceRunner.stopAll());
    },
    [],
  );

  // Device jobs this device held (its lease is still live): carry on.
  useEffect(() => {
    if (!enabled) return;
    const c = new AbortController();
    listJobs('running', null, c.signal)
      .then(async (page) => {
        if (!Array.isArray(page?.jobs)) return;
        const mine = page.jobs.filter((j) => j.kind === 'device' && j.holder?.self && j.status !== 'paused');
        if (!mine.length || c.signal.aborted) return;
        const { deviceRunner } = await import('../../lib/deviceRunner');
        for (const j of mine) void deviceRunner.start(j);
      })
      .catch(() => {});
    return () => c.abort();
  }, [enabled]);

  return null;
}
