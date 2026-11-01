import { GALLERY_TOKEN_RE } from '@zephyr/shared/client';

/** Where this page was opened from: a guest link, the owner's preview, or something that isn't a gallery. */
export type GuestRoute =
  | { kind: 'token'; token: string }
  | { kind: 'preview'; galleryId: string }
  | { kind: 'bad' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseGuestPath(pathname: string): GuestRoute {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'g') return { kind: 'bad' };
  if (parts.length === 3 && parts[1] === 'preview' && UUID.test(parts[2] ?? '')) {
    return { kind: 'preview', galleryId: parts[2] as string };
  }
  if (parts.length === 2 && GALLERY_TOKEN_RE.test(parts[1] ?? ''))
    return { kind: 'token', token: parts[1] as string };
  return { kind: 'bad' };
}
