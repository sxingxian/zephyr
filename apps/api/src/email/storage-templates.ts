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
  /**
   * Set when `store` answered and only the copies whose photos are on these unreachable stores were abandoned
   * (each copy's deletion first copies anything missing to the photo's store, so a dead one blocks it).
   */
  targets?: string[] | null;
  adminUrl: string;
}): Mail {
  const copies = `${e.copies} old ${e.copies === 1 ? 'copy' : 'copies'} of moved photos on ${e.store}`;
  const dead = e.targets?.length ? e.targets.join(', ') : null;
  return layout(
    `[Zephyr] Old copies abandoned on ${e.store}`,
    'Old copies abandoned',
    dead
      ? [
          `${e.actor} gave up on deleting ${copies}: the copies whose photos are on ${dead}, which can't be reached (${e.store} itself answered). Nothing was deleted.`,
          `The copies stay on ${e.store}. Don't delete them by hand: while ${dead} ${e.targets?.length === 1 ? 'is' : 'are'} unreachable they may be the only readable copy of those photos. If ${dead} ${e.targets?.length === 1 ? 'comes' : 'come'} back, keep ${e.targets?.length === 1 ? 'it' : 'them'} configured and reachable; the orphan sweep then copies anything a photo's own store is missing over to it before deleting the rest. The reason is in the audit log.`,
        ]
      : [
          `${e.actor} gave up on deleting ${copies}, which can't be reached. Nothing was deleted there.`,
          `The copies stay on ${e.store}. Don't delete them by hand: some may be the only copy of an edit or mask made while photos moved. If ${e.store} comes back, keep it configured and reachable; the orphan sweep then copies anything a photo's own store is missing over to it before deleting the rest. The reason is in the audit log.`,
        ],
    adminLink(e.adminUrl),
  );
}

export function storageGiveUpEmail(e: {
  actor: string;
  from: string;
  to: string;
  photos: number;
  /** Every photo still read from `from` (never moved, uploaded there, or edited after its copy back). */
  stranded?: number;
  /** Of those, the ones copied back and edited on `from` afterwards. */
  edited?: number;
  adminUrl: string;
}): Mail {
  const stranded = e.stranded ?? 0;
  const edited = Math.min(e.edited ?? 0, stranded);
  return layout(
    `[Zephyr] Rollback given up: uploads go to ${e.to} again`,
    'Rollback given up',
    [
      `${e.actor} gave up the failed rollback from ${e.to} to ${e.from}. New uploads go to ${e.to} again.`,
      `${e.photos} ${e.photos === 1 ? 'photo is' : 'photos are'} read from ${e.to} now, including any already copied back that hadn't changed since. The reason is in the audit log.`,
      ...(stranded > 0
        ? [
            `${stranded} ${stranded === 1 ? 'photo is' : 'photos are'} still read from ${e.from}, so ${stranded === 1 ? 'it' : 'they'} can't be shown while ${e.from} is unreachable${edited > 0 ? ` (${edited} of them edited there after being copied back)` : ''}. Any copy on ${e.to} is kept, and ${stranded === 1 ? 'it comes' : 'they come'} back if ${e.from} does. Admin › Storage lists them.`,
          ]
        : []),
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
