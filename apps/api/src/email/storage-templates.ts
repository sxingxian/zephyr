/**
 * Storage emails to every Owner (phase 8): the store switch, rollbacks, and automatic read-only mode. Store
 * names and short error codes only: never endpoints, bucket names, keys, member emails or photo names.
 */
import { layout, type Mail } from './share-templates';

const adminLink = (adminUrl: string) => ({ link: { label: 'Open Admin › Storage', url: adminUrl } });

export function storageSwitchEmail(e: { actor: string; from: string; to: string; adminUrl: string }): Mail {
  return layout(
    `[Zephyr] Storage switch started: ${e.from} → ${e.to}`,
    'Storage switch started',
    [
      `${e.actor} switched where new uploads go, from ${e.from} to ${e.to}. Existing photos are being copied and verified in the background.`,
      'Copies on the old store are deleted only after every photo is verified and the 7-day hold has passed. Every Owner is told about storage switches; the reason is in the audit log.',
    ],
    adminLink(e.adminUrl),
  );
}

export function storageRollbackEmail(e: { actor: string; from: string; to: string; adminUrl: string }): Mail {
  return layout(
    `[Zephyr] Storage switch rolled back: back to ${e.from}`,
    'Storage switch rolled back',
    [
      `${e.actor} rolled back the switch from ${e.from} to ${e.to}. New uploads go to ${e.from} again, and photos already moved are being copied back.`,
    ],
    adminLink(e.adminUrl),
  );
}

export function storageAbandonEmail(e: {
  actor: string;
  store: string;
  copies: number;
  adminUrl: string;
}): Mail {
  return layout(
    `[Zephyr] Old copies abandoned on ${e.store}`,
    'Old copies abandoned',
    [
      `${e.actor} gave up on deleting ${e.copies} old ${e.copies === 1 ? 'copy' : 'copies'} of moved photos on ${e.store}, which can't be reached. Nothing was deleted there.`,
      `If ${e.store} comes back, its photo files are still on it: delete them by hand or reconnect it and let the orphan sweep clear them. The reason is in the audit log.`,
    ],
    adminLink(e.adminUrl),
  );
}

export function readOnlyAutoEmail(e: {
  on: boolean;
  store: string;
  error: string | null;
  adminUrl: string;
}): Mail {
  return e.on
    ? layout(
        '[Zephyr] Read-only mode is on: the photo store stopped answering',
        'Read-only mode turned on automatically',
        [
          `The write store (${e.store}) failed three health checks in a row${e.error ? ` (last error: ${e.error})` : ''}.`,
          'Uploads and edits are paused. Members can still view and download photos stored elsewhere, and guest galleries keep working. Read-only mode turns off by itself after two good checks in a row.',
        ],
        adminLink(e.adminUrl),
      )
    : layout(
        '[Zephyr] Read-only mode is off: the photo store is back',
        'Read-only mode turned off',
        [`The write store (${e.store}) passed two health checks in a row. Uploads and edits work again.`],
        adminLink(e.adminUrl),
      );
}
