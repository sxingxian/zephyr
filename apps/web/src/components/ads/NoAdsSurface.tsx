import type { ReactNode } from 'react';
import { useAdsenseLoaded } from '../../lib/ads';

/**
 * Phase 8: true when this document may show something secret (a new gallery's link and passcode, an invite link,
 * anything shown once). Never while Google's AdSense script is in the page: it runs with the page's privileges
 * and could read it. Secret-bearing UI checks this and renders nothing instead; flows that would show a secret
 * from an ad page continue elsewhere with a full page load (Share → /share/new).
 */
export function useSecretsAllowed(): boolean {
  return !useAdsenseLoaded();
}

/** Renders its children only in a document without Google's AdSense script (see useSecretsAllowed). */
export function NoAdsSurface({ children }: { children: ReactNode }) {
  return useSecretsAllowed() ? children : null;
}
