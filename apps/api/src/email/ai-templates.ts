/**
 * Zephyr AI emails (phase 6): spend-cap alerts and settings changes for staff, and face-data notices for
 * members whose plan lost people grouping. Staff emails carry amounts and field names only; members' carry
 * no face data.
 */
import { layout, type Mail } from './share-templates';

const SCOPE: Record<string, string> = {
  total: 'All cloud AI',
  bg_removal: 'Background removal',
  scene_tags: 'Scene tags',
};
const usd = (n: number) => `US$${n.toFixed(2)}`;

export function capAlertEmail(e: {
  scope: string;
  threshold: number;
  usedUsd: number;
  capUsd: number;
  day: string;
  atCap: 'pause' | 'alert_only';
  adminUrl: string;
}): Mail {
  const what = SCOPE[e.scope] ?? 'Cloud AI';
  const reached = e.threshold >= 100;
  return layout(
    `[Zephyr AI] ${what} ${reached ? 'reached' : 'passed'} ${e.threshold}% of today’s cap`,
    `${what}: ${e.threshold}% of today’s cap`,
    [
      `Spent ${usd(e.usedUsd)} of ${usd(e.capUsd)} on ${e.day} (UTC).`,
      reached
        ? e.atCap === 'pause'
          ? 'Cloud AI work now waits until 00:00 UTC. Members’ queued jobs start then; device features keep working.'
          : 'Work continues past the cap (“Keep running, alert only”).'
        : 'Nothing is paused yet.',
    ],
    { link: { label: 'Open Zephyr AI controls', url: e.adminUrl } },
  );
}

export function aiSettingsChangedEmail(e: { actor: string; fields: string[]; adminUrl: string }): Mail {
  return layout(
    '[Zephyr AI] Settings changed',
    'Zephyr AI settings changed',
    [
      `${e.actor} changed: ${e.fields.join(', ')}.`,
      'These changes can raise cloud spend or turn features back on, so every Owner is told. The full before-and-after is in the audit log.',
    ],
    { link: { label: 'Open Zephyr AI controls', url: e.adminUrl } },
  );
}

export function faceLapseEmail(e: {
  kind: 'stopped' | 'warning' | 'deleted';
  deleteOn: string | null;
  appUrl: string;
}): Mail {
  const url = `${e.appUrl.replace(/\/$/, '')}/settings/ai`;
  if (e.kind === 'deleted') {
    return layout('Your face grouping data was deleted', 'Face grouping data deleted', [
      'Your plan no longer includes people grouping, so the face codes and names in your account were deleted, as we said they would be. Your photos are not affected.',
    ]);
  }
  const on = e.deleteOn ?? 'in 30 days';
  return layout(
    e.kind === 'stopped' ? 'Face grouping has stopped' : 'Your face grouping data will be deleted soon',
    e.kind === 'stopped' ? 'Face grouping has stopped' : 'Face grouping data will be deleted soon',
    [
      e.kind === 'stopped'
        ? 'Your plan no longer includes people grouping, so Zephyr has stopped finding faces in new photos.'
        : 'Your plan still doesn’t include people grouping.',
      `The face codes and names already in your account will be deleted on ${on}, unless you move back to a plan with people grouping. You can delete them now in Settings › Zephyr AI.`,
    ],
    { link: { label: 'Open Settings', url } },
  );
}
