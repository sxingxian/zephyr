import { type EditRecipe, normalizeRecipe } from '@zephyr/shared/client';
import { useSyncExternalStore } from 'react';
import { sessionUserId } from '../sessionGuard';

/**
 * Copied edits. Kept in memory only (never localStorage), bound to the member who copied them, and cleared
 * when the session ends, so nothing carries over on a shared device.
 */
export interface Copied {
  recipe: EditRecipe;
  fromId: string;
  fromName: string;
  owner: string;
}

let current: Copied | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

export function copyEdits(recipe: EditRecipe, fromId: string, fromName: string): void {
  const owner = sessionUserId();
  if (!owner) return;
  current = { recipe: normalizeRecipe(recipe), fromId, fromName, owner };
  emit();
}
/** The copied edits, if the same member is still signed in. */
export function getCopied(): Copied | null {
  if (current && current.owner !== sessionUserId()) current = null;
  return current;
}
export function clearCopied(): void {
  current = null;
  emit();
}
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
export function useCopied(): Copied | null {
  return useSyncExternalStore(subscribe, getCopied, getCopied);
}
